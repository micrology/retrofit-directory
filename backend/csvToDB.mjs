import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import sqlite3 from "sqlite3";
import XLSX from "xlsx";
/**
 * Import the source CSV into a local SQLite database and emit a plain-text
 * schema snapshot used by the query service.
 */

const INPUT_PATH = process.argv[2] || "../directory.csv";
const DB_PATH = "directory.db";
const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "directory.schema");
const TABLE_NAME = "orgs";
const LLM_VIEW_NAME = "orgs_llm";
const HEADER_ROW_INDEX = 1;
// Optional 0-based source row indexes to drop before header/data split (e.g. extra label rows).
const SKIP_ROWS = new Set();
// Spreadsheet columns A–S (0–18) are survey-respondent metadata, not answers.
const FIRST_DATA_COLUMN_INDEX = 19; // column T onwards
const SCHEMA_EXAMPLE_LIMIT = 3;

/**
 * Normalise free text: embedded newlines → spaces, collapse runs of whitespace,
 * trim leading/trailing spaces and newlines.
 * @param {string} value
 * @returns {string}
 */
function normalizeWhitespace(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .trim();
}

/**
 * Normalise a CSV header label into a deterministic SQL column identifier.
 * @param {unknown} columnName
 * @returns {string}
 */
function cleanColumnName(columnName) {
  return normalizeWhitespace(columnName).toLowerCase().replace(/ /g, "_");
}

/**
 * Coerce a cell to the value stored in SQLite, including text whitespace cleanup.
 * Empty cells become null. Dates become SQLite datetime strings. Other non-strings
 * pass through unchanged.
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeCellValue(value) {
  if (isEmptyCell(value)) return null;
  if (value instanceof Date) {
    return value.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  }
  if (typeof value === "string") {
    const normalized = normalizeWhitespace(value);
    return normalized === "" ? null : normalized;
  }
  return value;
}

/**
 * True when a cell has no usable content for import.
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmptyCell(value) {
  return value === undefined || value === null || value === "" || (typeof value === "string" && value.trim() === "");
}

/**
 * True when every data-row value in a column is empty.
 * @param {unknown[][]} dataRows
 * @param {number} colIdx
 * @returns {boolean}
 */
function isColumnEmpty(dataRows, colIdx) {
  return dataRows.every((row) => isEmptyCell(row[colIdx]));
}

/**
 * Normalize text for fuzzy semantic token matching.
 * @param {string} value
 * @returns {string}
 */
function normalizeForMatch(value) {
  return String(value)
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
/**
 * Safely quote a SQLite identifier (e.g. table/column name).
 * @param {unknown} identifier
 * @returns {string}
 */

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}
/**
 * Promise-based wrapper around sqlite3 `db.run`.
 * @param {sqlite3.Database} db
 * @param {string} sql
 * @param {unknown[]} [params=[]]
 * @returns {Promise<void>}
 */

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
 * Promise-based wrapper around sqlite3 `db.all`.
 * @param {sqlite3.Database} db
 * @param {string} sql
 * @returns {Promise<any[]>}
 */
function all(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

/**
 * Close sqlite database connection.
 * @param {sqlite3.Database} db
 * @returns {Promise<void>}
 */
function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Read table and column metadata and format it as a human-readable schema.
 * @param {sqlite3.Database} db
 * @returns {Promise<string>}
 */
async function getDatabaseSchema(db) {
  const tables = await all(
    db,
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY CASE WHEN type='table' THEN 0 ELSE 1 END, name;"
  );
  const schemaLines = [];

  for (const table of tables) {
    const tableName = table.name;
    const objectType = table.type;
    schemaLines.push(`${objectType === "view" ? "View name" : "Table name"}: ${tableName}`);
    schemaLines.push("Columns:");

    const safeTableName = tableName.replace(/'/g, "''");
    const columns = await all(db, `PRAGMA table_info('${safeTableName}');`);
    const [{ row_count: rowCount }] = await all(
      db,
      `SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(tableName)}`
    );

    for (const col of columns) {
      const colType = col.type || "TEXT";
      const quotedCol = quoteIdentifier(col.name);
      const [{ populated_count: populatedCount }] = await all(
        db,
        `SELECT COUNT(*) AS populated_count FROM ${quoteIdentifier(tableName)} WHERE ${quotedCol} IS NOT NULL AND TRIM(CAST(${quotedCol} AS TEXT)) != ''`
      );

      if (!populatedCount) {
        schemaLines.push(`  - ${col.name} (${colType}) [EMPTY - no data]`);
        continue;
      }

      const examples = await all(
        db,
        `SELECT DISTINCT TRIM(CAST(${quotedCol} AS TEXT)) AS example_value FROM ${quoteIdentifier(tableName)} WHERE ${quotedCol} IS NOT NULL AND TRIM(CAST(${quotedCol} AS TEXT)) != '' ORDER BY LENGTH(TRIM(CAST(${quotedCol} AS TEXT))) ASC, TRIM(CAST(${quotedCol} AS TEXT)) ASC LIMIT ${SCHEMA_EXAMPLE_LIMIT}`
      );
      const formattedExamples = examples
        .map(({ example_value: value }) =>
          `"${String(value).replace(/\s+/g, " ").trim().slice(0, 80).replace(/"/g, "'")}"`
        )
        .join(", ");
      schemaLines.push(
        `  - ${col.name} (${colType}) [populated ${populatedCount}/${rowCount}] examples: ${formattedExamples}`
      );
    }

    schemaLines.push("");
  }

  return schemaLines.join("\n");
}

/**
 * Scan a column's values (already cast by csv-parse) and return the most
 * specific SQLite type affinity that fits every non-empty value:
 *   - all integers  → INTEGER
 *   - any float     → REAL
 *   - Date objects  → TEXT  (stored as ISO-8601 string)
 *   - anything else → TEXT
 * @param {unknown[]} values
 * @returns {"INTEGER" | "REAL" | "TEXT"}
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

/**
 * Convert an Excel serial date number into a JS Date (UTC), if possible.
 * @param {number} serial
 * @returns {Date | null}
 */
function excelSerialToDate(serial) {
  const parts = XLSX.SSF.parse_date_code(serial);
  if (!parts) return null;
  const seconds = Math.floor(parts.S || 0);
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d, parts.H || 0, parts.M || 0, seconds));
}

/**
 * For date columns in XLSX data, coerce serial/date-like values to Date objects.
 * @param {unknown[][]} rows
 * @returns {unknown[][]}
 */
function normalizeExcelDateColumns(rows) {
  const dateColumns = new Set();

  for (const row of rows) {
    for (let i = 0; i < row.length; i += 1) {
      if (row[i] instanceof Date) dateColumns.add(i);
    }
  }

  if (dateColumns.size === 0) return rows;

  return rows.map((row) =>
    row.map((value, index) => {
      if (!dateColumns.has(index)) return value;
      if (value instanceof Date || value === undefined || value === null || value === "") return value;
      if (typeof value === "number") return excelSerialToDate(value) ?? value;
      if (typeof value === "string") {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed;
      }
      return value;
    })
  );
}

/**
 * Run a function while suppressing known non-fatal SheetJS ZIP warnings.
 * Some XLSX files trigger `cfb` warnings like "Bad uncompressed size: N != 0"
 * even though parsing succeeds and data is valid.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withSuppressedXlsxZipSizeWarnings(fn) {
  const originalConsoleError = console.error;
  const warningPattern = /^Bad (compressed|uncompressed) size: \d+ != 0$/;

  console.error = (...args) => {
    const message = args
      .map((value) => (typeof value === "string" ? value : String(value)))
      .join(" ");

    if (warningPattern.test(message)) return;
    originalConsoleError(...args);
  };

  try {
    return fn();
  } finally {
    console.error = originalConsoleError;
  }
}

/**
 * Load tabular rows from CSV or XLSX input.
 * @param {string} inputPath
 * @returns {{ rows: unknown[][], format: "csv" | "xlsx" }}
 */
function loadRowsFromInput(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();

  if (ext === ".csv") {
    const rawCsv = fs.readFileSync(inputPath, "utf8");
    return {
      rows: parse(rawCsv, {
        relax_column_count: true,
        skip_empty_lines: false,
        cast: true,
        cast_date: true,
      }),
      format: "csv",
    };
  }

  if (ext === ".xlsx") {
    const workbook = withSuppressedXlsxZipSizeWarnings(() =>
      XLSX.readFile(inputPath, { cellDates: true, raw: true })
    );
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new Error("XLSX file does not contain any sheets.");
    }

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
      header: 1,
      raw: true,
      defval: "",
      blankrows: true,
    });

    return { rows, format: "xlsx" };
  }

  throw new Error(`Unsupported input file extension: ${ext || "(none)"} (expected .csv or .xlsx).`);
}

/**
 * Find the first matching column by semantic tokens.
 * @param {string[]} columns
 * @param {string[]} requiredTokens
 * @returns {string | null}
 */
function findColumnByTokens(columns, requiredTokens) {
  for (const column of columns) {
    const normalized = normalizeForMatch(column);
    if (requiredTokens.every((token) => normalized.includes(token))) {
      return column;
    }
  }
  return null;
}

/**
 * Build canonical alias mappings for the LLM-facing SQL view.
 * @param {string[]} columns
 * @returns {Array<{ alias: string, source: string }>}
 */
function buildLlmViewMappings(columns) {
  const mappings = [];
  const addMapping = (alias, tokens) => {
    const source = findColumnByTokens(columns, tokens);
    if (source) mappings.push({ alias, source });
  };

  addMapping("org_name", ["name", "organisation", "wish", "add", "directory"]);
  addMapping("org_main_type", ["main", "type", "selected", "choice"]);
  addMapping("county", ["ukbased", "county", "based"]);
  addMapping("geographic_scope", ["geographic", "scope", "cover"]);
  addMapping("operating_areas", ["geographic", "areas", "operating", "selected", "choice"]);
  addMapping("main_mission_or_remit", ["main", "mission", "remit", "organisation"]);
  addMapping("retrofit_relevance", ["work", "relevant", "retrofit"]);
  addMapping("primary_activity", ["primary", "activity", "selected", "choice"]);
  addMapping("other_activities", ["other", "activities", "carry", "out", "selected", "choice"]);
  addMapping("specialisms", ["areas", "specialism", "selected", "choice"]);
  addMapping("methods_or_skills", ["methods", "technical", "skills", "selected", "choice"]);
  addMapping("works_with_architects", ["work", "with", "architects", "engineers", "design", "professionals"]);
  addMapping("website", ["link", "organisation", "website", "web", "page"]);
  addMapping("contact_email", ["general", "contact", "email", "organisation"]);
  addMapping("employee_count_band", ["approximately", "employees", "organisation", "have"]);

  return mappings;
}
/**
 * Parse CSV data, recreate the SQLite table, insert rows and write schema.
 * @returns {Promise<void>}
 */

async function main() {
  const { rows, format } = loadRowsFromInput(INPUT_PATH);

  const filteredRows = rows.filter((_, index) => !SKIP_ROWS.has(index));

  if (filteredRows.length <= HEADER_ROW_INDEX) {
    throw new Error("Input file does not contain enough rows to read the configured header.");
  }

  const headerRow = filteredRows[HEADER_ROW_INDEX];
  const dataRows = filteredRows.slice(HEADER_ROW_INDEX + 1);
  const normalizedDataRows = format === "xlsx" ? normalizeExcelDateColumns(dataRows) : dataRows;

  // Keep survey-answer columns only (T onwards) and drop columns with no data.
  const maxColumnCount = Math.max(
    headerRow.length,
    ...normalizedDataRows.map((row) => row.length),
    FIRST_DATA_COLUMN_INDEX
  );
  const keptColumnIndexes = [];
  for (let colIdx = FIRST_DATA_COLUMN_INDEX; colIdx < maxColumnCount; colIdx += 1) {
    if (isColumnEmpty(normalizedDataRows, colIdx)) continue;
    keptColumnIndexes.push(colIdx);
  }

  if (keptColumnIndexes.length === 0) {
    throw new Error(
      `No non-empty data columns found from column index ${FIRST_DATA_COLUMN_INDEX} (T) onwards.`
    );
  }

  const cleanedColumns = keptColumnIndexes.map((colIdx) => {
    const rawName = headerRow[colIdx];
    const cleaned = cleanColumnName(rawName);
    return cleaned || `column_${colIdx + 1}`;
  });

  const db = new sqlite3.Database(DB_PATH);

  try {
    await run(db, `DROP TABLE IF EXISTS ${quoteIdentifier(TABLE_NAME)}`);

    // Infer a SQLite type per column from the cast values.
    const columnTypes = keptColumnIndexes.map((sourceIdx) =>
      inferSqliteType(normalizedDataRows.map((row) => row[sourceIdx]))
    );
    const createColumns = cleanedColumns
      .map((c, i) => `${quoteIdentifier(c)} ${columnTypes[i]}`)
      .join(", ");
    await run(db, `CREATE TABLE ${quoteIdentifier(TABLE_NAME)} (${createColumns})`);

    const insertSql = `INSERT INTO ${quoteIdentifier(TABLE_NAME)} (${cleanedColumns
      .map(quoteIdentifier)
      .join(", ")}) VALUES (${cleanedColumns.map(() => "?").join(", ")})`;

    for (const row of normalizedDataRows) {
      const normalizedRow = keptColumnIndexes.map((sourceIdx) => normalizeCellValue(row[sourceIdx]));
      await run(db, insertSql, normalizedRow);
    }

    const viewMappings = buildLlmViewMappings(cleanedColumns);
    if (viewMappings.length > 0) {
      await run(db, `DROP VIEW IF EXISTS ${quoteIdentifier(LLM_VIEW_NAME)}`);
      const viewSelect = viewMappings
        .map(({ alias, source }) => `${quoteIdentifier(source)} AS ${quoteIdentifier(alias)}`)
        .join(",\n      ");
      await run(
        db,
        `CREATE VIEW ${quoteIdentifier(LLM_VIEW_NAME)} AS
         SELECT
           ${viewSelect}
         FROM ${quoteIdentifier(TABLE_NAME)}`
      );
    }
    const extractedSchema = await getDatabaseSchema(db);
    fs.writeFileSync(SCHEMA_PATH, extractedSchema, "utf8");
    console.log(`Input file: ${INPUT_PATH}`);
    console.log(`Database written to ${DB_PATH}`);
    console.log(`Schema written to ${SCHEMA_PATH}`);
  } finally {
    await close(db);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
