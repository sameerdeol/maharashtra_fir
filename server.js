const express = require("express");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const app = express();
const PORT = 3000;
const db = require("./db");

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
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(
      "https://citizen.mahapolice.gov.in/citizen/mh/PublishedFIRs.aspx",
      { waitUntil: "load" }
    );

    await page.reload({ waitUntil: "load" });

    await page.waitForFunction(() => {
      const ddl = document.querySelector("#ContentPlaceHolder1_ddlDistrict");
      return ddl && ddl.options.length > 1;
    }, { timeout: 30000 });

    const cities = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll("#ContentPlaceHolder1_ddlDistrict option")
      )
        .filter(o => o.value && o.value !== "0")
        .map(o => ({
          value: o.value,
          text: o.textContent.trim()
        }));
    });
    console.log("Total cities:", cities.length);

    await browser.close();
    res.json(cities);

  } catch (err) {
    await browser.close();
    console.error("CITY LOAD ERROR:", err);
    res.status(500).json({ error: "Failed to load cities" });
  }
});

/* ------------------ DOWNLOAD ------------------ */
app.post("/download", async (req, res) => {
  const { fromDate, toDate, cityValue, requestName } = req.body;
  

  const baseFolder = path.join(__dirname, "download", `${requestName.replace(/\s+/g, "_")}_request_1`);
  fs.mkdirSync(baseFolder, { recursive: true });

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
    await page.goto(
      "https://citizen.mahapolice.gov.in/citizen/mh/PublishedFIRs.aspx",
      { waitUntil: "load" }
    );
    await page.reload({ waitUntil: "load" });

    // Select District
    await page.selectOption("#ContentPlaceHolder1_ddlDistrict", cityValue);

    

    await page.waitForFunction(() => {
      const ps = document.querySelector("#ContentPlaceHolder1_ddlPoliceStation");
      return ps && ps.options.length > 1;
    });

    const selectedCityName = await page.evaluate(() => {
    const ddl = document.querySelector("#ContentPlaceHolder1_ddlDistrict");
    return ddl.options[ddl.selectedIndex].text.trim();
    });

    console.log("Selected city:", selectedCityName);

    // 1️⃣ Save request to DB
    const [requestResult] = await db.query(
    `INSERT INTO requests 
    (request_name, city_name, from_date, to_date, status)
    VALUES (?, ?, ?, ?, 'running')`,
    [requestName, selectedCityName, fromDate, toDate]
    );

    const requestId = requestResult.insertId;
    console.log("Request saved with ID:", requestId);
    res.write(`Request ID: ${requestId}\n`);

    res.write(`Selected city: ${selectedCityName}\n`);

    const stations = await page.$$eval(
      "#ContentPlaceHolder1_ddlPoliceStation option",
      opts => opts.filter(o => o.value).map(o => ({
        value: o.value,
        name: o.textContent.trim()
      }))
    );
    console.log("Total stations in city:", stations.length);
    res.write(`Total stations: ${stations.length}\n`);

    const sectionsToCheck = ["281", "125(A)", "125(B)", "106"];

    for (const station of stations) {
      const stationFolder = path.join(
        baseFolder,
        station.name.replace(/[\/\\:?<>|"]/g, "_")
      );
      fs.mkdirSync(stationFolder, { recursive: true });

      console.log("Processing:", station.name);
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
        res.write(`No FIRs in ${station.name}, skipping\n`);
        continue; // 👈 VERY IMPORTANT
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
        console.log(`❌ No matched FIRs in ${station.name}, skipping...`);
        res.write(`No matched FIRs in ${station.name}, skipping\n`);
        continue; // 👈 move to next police station
        }

      for (const record of filteredRows) {
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

        await page.click(`#ContentPlaceHolder1_gdvDeadBody_btnDownload_${idx}`);

        // Click download and capture browser download event
        const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 20000 }),
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
      }
    }
    // 4️⃣ Final request update
    const [countRows] = await db.query(
    `SELECT COUNT(*) AS total 
    FROM firs 
    WHERE request_id = ? AND download_status = 'downloaded'`,
    [requestId]
    );

    await db.query(
    `UPDATE requests
    SET total_downloaded_firs = ?, status = 'completed'
    WHERE id = ?`,
    [countRows[0].total, requestId]
    );

    res.write(`\nTotal downloaded FIRs: ${countRows[0].total}\n`);

    await browser.close();
    res.end("\nDownload completed successfully!");

  } catch (err) {
    console.error("DOWNLOAD ERROR:", err);
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