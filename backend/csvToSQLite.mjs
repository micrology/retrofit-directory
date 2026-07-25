import fs from "node:fs";
import { parse } from "csv-parse/sync";
import sqlite3 from "sqlite3";

const CSV_PATH = "directory.csv";
const DB_PATH = "directory.db";
const TABLE_NAME = "orgs";
const HEADER_ROW_INDEX = 1;
const SKIP_ROWS = new Set([2]);

function cleanColumnName(columnName) {
  return String(columnName).trim().toLowerCase().replace(/ /g, "_");
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Scan a column's values (already cast by csv-parse) and return the most
 * specific SQLite type affinity that fits every non-empty value:
 *   - all integers  → INTEGER
 *   - any float     → REAL
 *   - Date objects  → TEXT  (stored as ISO-8601 string)
 *   - anything else → TEXT
 */
function inferSqliteType(values) {
  let hasFloat = false;
  for (const v of values) {
    if (v === undefined || v === null || v === "") continue;
    if (v instanceof Date) return "TEXT";
    if (typeof v === "boolean") return "INTEGER";
    if (typeof v === "number") {
      if (!Number.isInteger(v)) hasFloat = true;
      continue;
    }
    return "TEXT";
  }
  // If every value was empty we can't infer a numeric type — default to TEXT.
  if (!hasFloat && values.every((v) => v === undefined || v === null || v === "")) return "TEXT";
  return hasFloat ? "REAL" : "INTEGER";
}

async function main() {
  const rawCsv = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parse(rawCsv, {
    relax_column_count: true,
    skip_empty_lines: false,
    cast: true,
    cast_date: true,
  });

  const filteredRows = rows.filter((_, index) => !SKIP_ROWS.has(index));

  if (filteredRows.length <= HEADER_ROW_INDEX) {
    throw new Error("CSV does not contain enough rows to read the configured header.");
  }

  const cleanedColumns = filteredRows[HEADER_ROW_INDEX].map(cleanColumnName);
  const dataRows = filteredRows.slice(HEADER_ROW_INDEX + 1);

  const db = new sqlite3.Database(DB_PATH);

  try {
    await run(db, `DROP TABLE IF EXISTS ${quoteIdentifier(TABLE_NAME)}`);

    // Infer a SQLite type per column from the cast values.
    const columnTypes = cleanedColumns.map((_, colIdx) =>
      inferSqliteType(dataRows.map((row) => row[colIdx]))
    );
    const createColumns = cleanedColumns
      .map((c, i) => `${quoteIdentifier(c)} ${columnTypes[i]}`)
      .join(", ");
    await run(db, `CREATE TABLE ${quoteIdentifier(TABLE_NAME)} (${createColumns})`);

    const insertSql = `INSERT INTO ${quoteIdentifier(TABLE_NAME)} (${cleanedColumns
      .map(quoteIdentifier)
      .join(", ")}) VALUES (${cleanedColumns.map(() => "?").join(", ")})`;

    for (const row of dataRows) {
      const normalizedRow = cleanedColumns.map((_, index) => {
        const value = row[index];
        if (value === undefined || value === null || value === "") return null;
        // Serialise Date objects as "YYYY-MM-DD HH:MM:SS" (SQLite datetime convention).
        if (value instanceof Date) {
          return value.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
        }
        // Pass numbers and booleans through natively; sqlite3 handles them correctly.
        return value;
      });
      await run(db, insertSql, normalizedRow);
    }
  } finally {
    await new Promise((resolve, reject) => {
      db.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
