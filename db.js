const mysql = require("mysql2/promise");

const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "maharashtra_db",
  connectionLimit: 10
});
module.exports = db;