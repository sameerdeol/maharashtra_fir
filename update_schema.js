const db = require("./db");

(async () => {
    try {
        console.log("Updating database schema...");
        const [rows] = await db.query("SHOW COLUMNS FROM requests LIKE 'city_name'");
        if (rows.length > 0) {
            // Change city_name to TEXT to support multiple cities
            await db.query("ALTER TABLE requests MODIFY COLUMN city_name TEXT");
            console.log("✅ Successfully modified 'city_name' to TEXT.");
        } else {
            console.log("❌ Column 'city_name' not found.");
        }
    } catch (err) {
        console.error("❌ Error updating schema:", err.message);
    } finally {
        process.exit();
    }
})();
