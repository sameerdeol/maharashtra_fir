const express = require("express");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const app = express();
const PORT = 3000;
const db = require("./db");
const axios = require("axios"); // Added axios
const FormData = require("form-data"); // Added form-data

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* ------------------ FRONTEND ------------------ */
app.get("/", (req, res) => {
  res.render("index");
});

/* ------------------ GET CITIES ------------------ */
app.get("/cities", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT city_id as value, city_name as text FROM maharashtra_cities ORDER BY city_name");

    if (rows.length > 0) {
      console.log(`[DB] Fetched ${rows.length} cities.`);
      return res.json(rows);
    }

    // Fallback to scraping if DB is empty
    console.log("[SCRAPE] DB empty, falling back to scraping cities...");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto("https://citizen.mahapolice.gov.in/citizen/mh/PublishedFIRs.aspx", { waitUntil: "load" });
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => {
        const ddl = document.querySelector("#ContentPlaceHolder1_ddlDistrict");
        return ddl && ddl.options.length > 1;
      }, { timeout: 30000 });

      const cities = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("#ContentPlaceHolder1_ddlDistrict option"))
          .filter(o => o.value && o.value !== "0")
          .map(o => ({ value: o.value, text: o.textContent.trim() }));
      });
      await browser.close();
      res.json(cities);
    } catch (err) {
      await browser.close();
      throw err;
    }
  } catch (err) {
    console.error("CITY LOAD ERROR:", err);
    res.status(500).json({ error: "Failed to load cities" });
  }
});


/* ------------------ GET STATIONS ------------------ */
app.get("/stations", async (req, res) => {
  const cityValue = req.query.cityValue;
  if (!cityValue) {
    return res.status(400).json({ error: "City value is required" });
  }

  try {
    const [rows] = await db.query(
      "SELECT station_id as value, station_name as text FROM maharashtra_police_stations WHERE city_id = ? ORDER BY station_name",
      [cityValue]
    );

    if (rows.length > 0) {
      console.log(`[DB] Fetched ${rows.length} stations for city ${cityValue}.`);
      return res.json(rows);
    }

    // Fallback to scraping if DB has no stations for this city
    console.log(`[SCRAPE] No stations in DB for city ${cityValue}, falling back to scraping...`);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto("https://citizen.mahapolice.gov.in/citizen/mh/PublishedFIRs.aspx", { waitUntil: "load" });
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => {
        const ddl = document.querySelector("#ContentPlaceHolder1_ddlDistrict");
        return ddl && ddl.options.length > 1;
      }, { timeout: 30000 });

      await page.selectOption("#ContentPlaceHolder1_ddlDistrict", cityValue);
      await page.waitForFunction(() => {
        const ps = document.querySelector("#ContentPlaceHolder1_ddlPoliceStation");
        return ps && ps.options.length > 1;
      }, { timeout: 30000 });

      const stations = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("#ContentPlaceHolder1_ddlPoliceStation option"))
          .filter(o => o.value && o.value !== "0" && o.value !== "Select")
          .map(o => ({ value: o.value, text: o.textContent.trim() }));
      });
      await browser.close();
      res.json(stations);
    } catch (err) {
      await browser.close();
      throw err;
    }
  } catch (err) {
    console.error("STATION LOAD ERROR:", err);
    res.status(500).json({ error: "Failed to load stations" });
  }
});

/* ------------------ DOWNLOAD ------------------ */
app.post("/download", async (req, res) => {
  let { fromDate, toDate, cityValue, requestName, stations: targetStations } = req.body;

  // Ensure cityValue is an array
  if (!Array.isArray(cityValue)) {
    cityValue = [cityValue];
  }

  console.log("Selected Cities:", cityValue);

  res.write("Download started...\n");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  function formatDate(input) {
    const [y, m, d] = input.split("-");
    return `${d}/${m}/${y}`;
  }

  try {
    // 1️⃣ Create ONE Main Request Record
    // Store IDs initially, will update with Names later if desired
    const initialCityStr = Array.isArray(cityValue) ? cityValue.join(", ") : cityValue;
    const [requestResult] = await db.query(
      `INSERT INTO requests 
      (request_name, city_name, from_date, to_date, status)
      VALUES (?, ?, ?, ?, 'running')`,
      [requestName, initialCityStr, fromDate, toDate]
    );
    const requestId = requestResult.insertId;
    console.log("Request created with ID:", requestId);

    let collectedCityNames = [];

    for (const city of cityValue) {
      console.log(`\n=== Processing City Value: ${city} ===`);

      // Keep the same browser session if possible, or reload fresh for each city
      try {
        await page.goto(
          "https://citizen.mahapolice.gov.in/citizen/mh/PublishedFIRs.aspx",
          { waitUntil: "load" }
        );
        await page.reload({ waitUntil: "load" });

        // Select City
        await page.selectOption("#ContentPlaceHolder1_ddlDistrict", city);

        await page.waitForFunction(() => {
          const ps = document.querySelector("#ContentPlaceHolder1_ddlPoliceStation");
          return ps && ps.options.length > 1;
        });

        const selectedCityName = await page.evaluate(() => {
          const ddl = document.querySelector("#ContentPlaceHolder1_ddlDistrict");
          return ddl.options[ddl.selectedIndex].text.trim();
        });

        collectedCityNames.push(selectedCityName);

        console.log("Processing City:", selectedCityName);
        res.write(`Processing City: ${selectedCityName}\n`);

        // Create Folder for City
        const baseFolder = path.join(
          __dirname,
          "download",
          `${requestName.replace(/\s+/g, "_")}`,
          selectedCityName.replace(/[\/\\:?<>|"]/g, "_")
        );
        fs.mkdirSync(baseFolder, { recursive: true });


        // Request ID is already created globally

        const allStations = await page.$$eval(
          "#ContentPlaceHolder1_ddlPoliceStation option",
          opts => opts.filter(o => o.value).map(o => ({
            value: o.value,
            name: o.textContent.trim()
          }))
        );

        // Filter valid stations based on user selection
        let stations = allStations;
        if (targetStations) {
          // targetStations is expected to be { "cityValue": ["st1", "st2"] }
          if (targetStations[city]) {
            const allowed = Array.isArray(targetStations[city]) ? targetStations[city] : [targetStations[city]];
            stations = allStations.filter(s => allowed.includes(s.value));
          } else {
            // City selected in main list, but no stations selected -> Process NONE
            stations = [];
          }
        }

        console.log(`Total stations in city: ${allStations.length}, Processing: ${stations.length}`);
        res.write(`Total stations: ${allStations.length}, Processing: ${stations.length}\n`);

        const sectionsToCheck = ["281", "125(A)", "125(B)", "106"];

        for (const station of stations) {
          console.log("Processing station:", station.name);
          res.write(`Processing station: ${station.name}\n`);

          await page.selectOption(
            "#ContentPlaceHolder1_ddlPoliceStation",
            station.value
          );

          await page.evaluate(({ from, to }) => {
            const f = document.querySelector("#ContentPlaceHolder1_txtDateOfRegistrationFrom");
            const t = document.querySelector("#ContentPlaceHolder1_txtDateOfRegistrationTo");
            f.value = from;
            t.value = to;
            ["input", "change", "blur"].forEach(e => {
              f.dispatchEvent(new Event(e, { bubbles: true }));
              t.dispatchEvent(new Event(e, { bubbles: true }));
            });
          }, {
            from: formatDate(fromDate),
            to: formatDate(toDate)
          });

          console.log(`Searching FIRs from ${formatDate(fromDate)} to ${formatDate(toDate)}...`);
          res.write(`Searching FIRs from ${formatDate(fromDate)} to ${formatDate(toDate)}...\n`);

          await Promise.all([
            page.waitForNavigation({ waitUntil: "load" }),
            page.click("#ContentPlaceHolder1_btnSearch")
          ]);

          await page.waitForTimeout(2000);

          // View all records
          await page.selectOption("#ContentPlaceHolder1_ucRecordView_ddlPageSize", "50");
          await page.waitForTimeout(1000);
          await page.selectOption("#ContentPlaceHolder1_ucRecordView_ddlPageSize", "0");
          await page.waitForTimeout(2000);

          // Check if any FIR rows exist
          const totalFIRs = await page.$$eval(
            "#ContentPlaceHolder1_gdvDeadBody tr",
            rows => rows.length > 1 ? rows.length - 1 : 0
          );

          if (totalFIRs === 0) {
            console.log(`❌ No FIRs found in ${station.name}, skipping...`);
            // res.write(`No FIRs in ${station.name}, skipping\n`);
            continue;
          }

          console.log(`Total FIRs in station ${station.name}:`, totalFIRs);
          res.write(`Total FIRs in ${station.name}: ${totalFIRs}\n`);

          const filteredRows = await page.$$eval(
            "#ContentPlaceHolder1_gdvDeadBody tr",
            (rows, sections) => {
              const header = Array.from(rows[0].querySelectorAll("th"))
                .map(th => th.innerText.trim());

              return Array.from(rows).slice(1)
                .map((row, i) => {
                  const cells = Array.from(row.querySelectorAll("td"))
                    .map(td => td.innerText.trim());
                  const obj = {};
                  header.forEach((h, idx) => obj[h] = cells[idx] || "");
                  obj._rowIndex = i;
                  return obj;
                })
                .filter(r => {
                  const secText = (r["Sections"] || "").toLowerCase();
                  return sections.some(sec => secText.includes(sec.toLowerCase()));
                });
            },
            ["281", "125(a)", "125(b)", "106"]
          );


          console.log("Matched FIRs:", filteredRows.length);
          if (filteredRows.length === 0) {
            // console.log(`❌ No matched FIRs in ${station.name}, skipping...`);
            // res.write(`No matched FIRs in ${station.name}, skipping\n`);
            continue;
          }

          // ✅ ONLY CREATE FOLDER IF MATCHED FIRS FOUND
          const stationFolder = path.join(
            baseFolder,
            station.name.replace(/[\/\\:?<>|"]/g, "_")
          );
          fs.mkdirSync(stationFolder, { recursive: true });


          for (const record of filteredRows) {
            try {
              // 2️⃣ Insert FIR record (before download)
              const [firResult] = await db.query(
                `INSERT INTO firs
            (request_id, station_name, fir_no, sections, download_status)
            VALUES (?, ?, ?, ?, 'pending')`,
                [
                  requestId,
                  station.name,
                  record["FIR No."] || record["FIR No"],
                  record["Sections"] || ""
                ]
              );
              const firId = firResult.insertId;

              const idx = record._rowIndex;
              const fileName = `${record["FIR No."] || record["FIR No"]}.pdf`;
              const filePath = path.join(stationFolder, fileName);

              console.log("Downloading:", fileName);
              res.write(`Downloading FIR: ${fileName}\n`);

              await page.click(`#ContentPlaceHolder1_gdvDeadBody_btnDownload_${idx}`);

              // Click download and capture browser download event
              const [download] = await Promise.all([
                page.waitForEvent("download", { timeout: 60000 }),
                page.click(`#ContentPlaceHolder1_gdvDeadBody_btnDownload_${idx}`)
              ]);

              const savePath = path.join(stationFolder, fileName);
              await download.saveAs(savePath);

              // 3️⃣ Update FIR after download success
              await db.query(
                `UPDATE firs
            SET pdf_path = ?, download_status = 'downloaded'
            WHERE id = ?`,
                [savePath, firId]
              );

              console.log("Saved:", savePath);
              res.write(`Saved FIR: ${fileName}\n`);
              await page.waitForTimeout(1000);

              // ------------------ OCR API CHECK ------------------
              // try {
              //   console.log("🔍 Running OCR on:", savePath);

              //   const BNS_SECTIONS = ["281", "125(A)", "125(B)", "106"];

              //   const form = new FormData();
              //   form.append("file", fs.createReadStream(savePath));
              //   form.append("fir_no", record["FIR No."] || record["FIR No"]);
              //   form.append("station_no", station.name);
              //   form.append("city", selectedCityName);
              //   form.append("sections", record["Sections"] || "");

              //   const apiRes = await axios.post(
              //     "http://103.168.18.184:3003/extract",
              //     form,
              //     {
              //       headers: { ...form.getHeaders() },
              //       timeout: 60000
              //     }
              //   );

              //   const apiSections = apiRes.data.sections || [];
              //   const rawText = (apiRes.data.raw || "").toLowerCase();

              //   console.log("📝 OCR Extracted Sections:", apiSections);
              //   res.write(`📝 OCR Extracted Sections: ${apiSections.join(", ")}\n`);

              //   let matchFound = null;

              //   // 1️⃣ Check inside API sections array
              //   for (const bns of BNS_SECTIONS) {
              //     if (apiSections.some((sec) => sec.toLowerCase().includes(bns.toLowerCase()))) {
              //       matchFound = bns;
              //       break;
              //     }
              //   }

              //   // 2️⃣ Check inside raw text if sections array missed
              //   if (!matchFound) {
              //     for (const bns of BNS_SECTIONS) {
              //       if (rawText.includes(bns.toLowerCase())) {
              //         matchFound = bns;
              //         break;
              //       }
              //     }
              //   }

              //   if (matchFound) {
              //     console.log("🎯 MATCH FOUND:", matchFound);
              //     res.write(`🎯 MATCH FOUND: ${matchFound}\n`);
              //   } else {
              //     console.log("No match found in OCR.");
              //     res.write(`No match found in OCR.\n`);
              //   }

              // } catch (ocrErr) {
              //   console.error("❌ OCR Error:", ocrErr.message);
              //   res.write(`❌ OCR Error: ${ocrErr.message}\n`);
              // }
              // ---------------------------------------------------

            } catch (fileErr) {
              console.error(`❌ Error downloading ${record["FIR No."] || "Unknown"}:`, fileErr.message);
              res.write(`❌ Failed to download FIR ${record["FIR No."] || "Unknown"} (Timeout or Server Error)\n`);
              // Continue to next file
            }
          }
        }

        // Update deferred to after loop

        res.write(`\nFinished City: ${selectedCityName}.\n`);

      } catch (cityErr) {
        console.error(`ERROR processing city ${city}:`, cityErr);
        res.write(`Error processing city ${city}. Moving to next...\n`);
      }
    } // End City Loop

    // Final Update for the Request
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total 
      FROM firs 
      WHERE request_id = ? AND download_status = 'downloaded'`,
      [requestId]
    );

    // Update with collected City Names
    const finalCityStr = collectedCityNames.length > 0
      ? collectedCityNames.join(", ")
      : (Array.isArray(cityValue) ? cityValue.join(", ") : cityValue);

    await db.query(
      `UPDATE requests
      SET total_downloaded_firs = ?, status = 'completed', city_name = ?
      WHERE id = ?`,
      [countRows[0].total, finalCityStr, requestId]
    );

    await browser.close();
    res.end("\nDOWNLOAD COMPLETE");

  } catch (err) {
    console.error("GLOBAL DOWNLOAD ERROR:", err);
    await browser.close();
    res.end("\nError occurred. Check server logs.");
  }
});

app.get("/downloads", async (req, res) => {
  try {
    const [requests] = await db.query(
      "SELECT * FROM requests ORDER BY created_at DESC"
    );

    const [firs] = await db.query(
      `SELECT id, request_id, station_name, fir_no, pdf_path
       FROM firs
       WHERE download_status = 'downloaded'`
    );

    // Group FIRs under requests → stations
    const result = requests.map(req => ({
      id: req.id,
      request_name: req.request_name,
      city: req.city_name,
      created_at: req.created_at,
      stations: {}
    }));

    firs.forEach(fir => {
      const req = result.find(r => r.id === fir.request_id);
      if (!req) return;

      if (!req.stations[fir.station_name]) {
        req.stations[fir.station_name] = [];
      }

      req.stations[fir.station_name].push({
        fir_no: fir.fir_no,
        pdf_path: fir.pdf_path
      });
    });

    res.json(result);
  } catch (err) {
    console.error("LOAD DOWNLOADS ERROR:", err);
    res.status(500).json({ error: "Failed to load downloads" });
  }
});

app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);

(async () => {
  try {
    const conn = await db.getConnection();
    console.log("✅ Database connected successfully");
    conn.release();
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
})();