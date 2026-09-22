/**
 * Integrity checks after a Qualtrics → SQLite import.
 *
 * Compares source spreadsheet rows/columns against `directory.db` using the
 * same import rules as csvToDB.mjs, validates ONSPD enrichment coverage,
 * `orgs_llm` aliases, and `directory.schema`. Prints OK / NOTE / ISSUE lines.
 * Exit non-zero when checks fail (used by `refresh-directory.sh`).
 *
 * Usage:
 *   cd backend
 *   node verifyImport.mjs
 *   node verifyImport.mjs path/to/qualtrics-export.xlsx
 *   node verifyImport.mjs [inputPath] [dbPath] [schemaPath]
 *
 * Defaults:
 *   inputPath  = ../directory.csv
 *   dbPath     = ./directory.db
 *   schemaPath = ./directory.schema
 *
 * @license MIT
 * Copyright (c) 2025–2026 Nigel Gilbert and contributors
 * University of Surrey — INHABIT / National Retrofit Hub
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = process.argv[2] || path.join(__dirname, "../directory.csv");
const DB_PATH = process.argv[3] || path.join(__dirname, "directory.db");
const SCHEMA_PATH = process.argv[4] || path.join(__dirname, "directory.schema");

// Keep these in sync with csvToDB.mjs
const TABLE_NAME = "orgs";
const LLM_VIEW_NAME = "orgs_llm";
const HEADER_ROW_INDEX = 1;
const SKIP_ROWS = new Set();
const FIRST_DATA_COLUMN_INDEX = 19; // column T onwards

const EXPECTED_LLM_ALIASES = [
  "org_name",
  "org_main_type",
  "county",
  "postcode",
  "local_authority",
  "parish",
  "hq_latitude",
  "hq_longitude",
  "geographic_scope",
  "operating_areas",
  "main_mission_or_remit",
  "retrofit_relevance",
  "primary_activity",
  "other_activities",
  "specialisms",
  "methods_or_skills",
  "works_with_architects",
  "website",
  "contact_email",
  "employee_count_band",
];

const issues = [];
const notes = [];
const oks = [];

/**
 * Record a failing check and print an error line.
 * @param {string} msg
 * @returns {void}
 */
function issue(msg) {
  issues.push(msg);
  console.log(`ISSUE: ${msg}`);
}

/**
 * Print an informational note during verification.
 * @param {string} msg
 * @returns {void}
 */
function note(msg) {
  notes.push(msg);
  console.log(`NOTE: ${msg}`);
}

/**
 * Print a passing check line.
 * @param {string} msg
 * @returns {void}
 */
function ok(msg) {
  oks.push(msg);
  console.log(`OK: ${msg}`);
}

/**
 * Normalise free text: newlines to spaces, collapse whitespace, trim.
 * @param {unknown} value
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
 * True when a cell has no usable content for import.
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmptyCell(value) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (typeof value === "string" && value.trim() === "")
  );
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
 * Coerce a cell to the value stored in SQLite (dates → strings; empty → null).
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
 * Safely quote a SQLite identifier (table/column name).
 * @param {unknown} identifier
 * @returns {string}
 */
function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
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
 * Run `fn` while suppressing known non-fatal SheetJS ZIP size warnings.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withSuppressedXlsxZipSizeWarnings(fn) {
  const originalConsoleError = console.error;
  const warningPattern = /^Bad (compressed|uncompressed) size: \d+ != 0$/;

  console.error = (...args) => {
    const message = args.map((value) => (typeof value === "string" ? value : String(value))).join(" ");
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
 * Load tabular rows from a CSV or XLSX path.
 * @param {string} inputPath
 * @returns {{ rows: unknown[][], format: "csv" | "xlsx" }}
 */
async function loadRowsFromInput(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();

  if (ext === ".csv") {
    const { parse } = await import("csv-parse/sync");
    const rawCsv = fs.readFileSync(inputPath, "utf8");
    return {
      rows: parse(rawCsv, {
        relax_column_count: true,
        skip_empty_lines: false,
        cast: true,
        cast_date: true,
      }),
      format: "csv",
      sheetName: null,
      sheetRef: null,
    };
  }

  if (ext === ".xlsx") {
    const workbook = withSuppressedXlsxZipSizeWarnings(() =>
      XLSX.readFile(inputPath, { cellDates: true, raw: true })
    );
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) throw new Error("XLSX file does not contain any sheets.");
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
      header: 1,
      raw: true,
      defval: "",
      blankrows: true,
    });
    return { rows, format: "xlsx", sheetName: firstSheet, sheetRef: workbook.Sheets[firstSheet]["!ref"] };
  }

  throw new Error(`Unsupported input file extension: ${ext || "(none)"} (expected .csv or .xlsx).`);
}

/**
 * Compare two cell values after normalising empty/whitespace cases.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function valuesEqual(expected, actual) {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined || actual === "";
  }
  if (typeof expected === "number") {
    if (typeof actual === "number") return expected === actual;
    const n = Number(actual);
    return !Number.isNaN(n) && n === expected;
  }
  if (typeof expected === "boolean") {
    return actual === expected || actual === (expected ? 1 : 0);
  }
  return String(expected) === String(actual);
}

/**
 * Promise wrapper around sqlite3 `db.all`.
 * @param {import("sqlite3").Database} db
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<any[]>}
 */
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/**
 * Promise wrapper around sqlite3 `db.get`.
 * @param {import("sqlite3").Database} db
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<any>}
 */
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

/**
 * Close a sqlite3 database connection.
 * @param {import("sqlite3").Database} db
 * @returns {Promise<void>}
 */
function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Normalise text for fuzzy semantic token matching.
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
 * Find the first column whose normalised name contains all required tokens.
 * @param {string[]} columns
 * @param {string[]} requiredTokens
 * @returns {string | null}
 */
function findColumnByTokens(columns, requiredTokens) {
  for (const column of columns) {
    const normalized = normalizeForMatch(column);
    if (requiredTokens.every((token) => normalized.includes(token))) return column;
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
  /**
   * Register an alias if a source column matching `tokens` exists.
   * @param {string} alias
   * @param {string[]} tokens
   * @returns {void}
   */
  const addMapping = (alias, tokens) => {
    const source = findColumnByTokens(columns, tokens);
    if (source) mappings.push({ alias, source });
  };

  addMapping("org_name", ["name", "organisation", "wish", "add", "directory"]);
  addMapping("org_main_type", ["main", "type", "selected", "choice"]);
  addMapping("county", ["ukbased", "county", "based"]);
  addMapping("postcode", ["postcode", "organisation", "headquarters"]);
  for (const name of ["local_authority", "parish", "hq_latitude", "hq_longitude"]) {
    if (columns.includes(name)) mappings.push({ alias: name, source: name });
  }
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
 * Parse column names for a table/view from `directory.schema` text.
 * @param {string} schemaText
 * @param {string} tableName
 * @returns {string[]}
 */
function parseSchemaTableColumns(schemaText, tableHeader) {
  const idx = schemaText.indexOf(tableHeader);
  if (idx < 0) return null;
  const rest = schemaText.slice(idx);
  const next = rest.search(/\n(?:Table name:|View name:)/);
  // Skip the first header line itself when finding the next section.
  const afterHeader = rest.slice(tableHeader.length);
  const nextFromAfter = afterHeader.search(/\n(?:Table name:|View name:)/);
  const section = nextFromAfter < 0 ? afterHeader : afterHeader.slice(0, nextFromAfter);

  const cols = [];
  const re =
    /^  - ([\s\S]*?) \(([A-Z]+)\) \[(EMPTY - no data|populated (\d+)\/(\d+)[^\]]*)\]/gm;
  let match;
  while ((match = re.exec(section))) {
    cols.push({
      name: match[1],
      type: match[2],
      populated: match[4] ? Number(match[4]) : 0,
      total: match[5] ? Number(match[5]) : null,
      empty: match[3] === "EMPTY - no data",
    });
  }
  return cols;
}

/**
 * CLI entry point.
 * @returns {Promise<void> | void}
 */
async function main() {
  console.log(`Input:  ${INPUT_PATH}`);
  console.log(`DB:     ${DB_PATH}`);
  console.log(`Schema: ${SCHEMA_PATH}`);

  if (!fs.existsSync(INPUT_PATH)) throw new Error(`Input file not found: ${INPUT_PATH}`);
  if (!fs.existsSync(DB_PATH)) throw new Error(`Database not found: ${DB_PATH}`);
  if (!fs.existsSync(SCHEMA_PATH)) throw new Error(`Schema file not found: ${SCHEMA_PATH}`);

  const { rows, format, sheetName, sheetRef } = await loadRowsFromInput(INPUT_PATH);
  console.log(`Source: format=${format} sheet=${sheetName ?? "n/a"} ref=${sheetRef ?? "n/a"} rawRows=${rows.length}`);

  const filteredRows = rows.filter((_, index) => !SKIP_ROWS.has(index));
  if (filteredRows.length <= HEADER_ROW_INDEX) {
    throw new Error("Input file does not contain enough rows to read the configured header.");
  }

  const headerRow = filteredRows[HEADER_ROW_INDEX];
  const dataRows = filteredRows.slice(HEADER_ROW_INDEX + 1);
  const normalizedDataRows = format === "xlsx" ? normalizeExcelDateColumns(dataRows) : dataRows;

  const maxColumnCount = Math.max(
    headerRow.length,
    ...normalizedDataRows.map((row) => row.length),
    FIRST_DATA_COLUMN_INDEX
  );

  const keptColumnIndexes = [];
  const emptyDropped = [];
  for (let colIdx = FIRST_DATA_COLUMN_INDEX; colIdx < maxColumnCount; colIdx += 1) {
    if (isColumnEmpty(normalizedDataRows, colIdx)) {
      emptyDropped.push(colIdx);
      continue;
    }
    keptColumnIndexes.push(colIdx);
  }

  const cleanedColumns = keptColumnIndexes.map((colIdx) => {
    const cleaned = cleanColumnName(headerRow[colIdx]);
    return cleaned || `column_${colIdx + 1}`;
  });

  const expectedRows = normalizedDataRows.map((row) =>
    keptColumnIndexes.map((sourceIdx) => normalizeCellValue(row[sourceIdx]))
  );

  console.log(
    `Expected import shape: dataRows=${expectedRows.length} columns=${cleanedColumns.length} emptyDroppedFromT=${emptyDropped.length}`
  );

  // Duplicate cleaned column names
  const nameCounts = new Map();
  for (const name of cleanedColumns) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  const dupes = [...nameCounts.entries()].filter(([, count]) => count > 1);
  if (dupes.length) issue(`Duplicate cleaned column names: ${dupes.map(([n, c]) => `${n}×${c}`).join(", ")}`);
  else ok("No duplicate cleaned column names");

  for (const [i, name] of cleanedColumns.entries()) {
    if (/[\r\n]/.test(name)) issue(`Column ${i} still contains a newline: ${JSON.stringify(name)}`);
    if (name !== name.trim()) issue(`Column ${i} is not trimmed: ${JSON.stringify(name)}`);
  }

  const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

  try {
    const integrity = await get(db, "PRAGMA integrity_check");
    if (integrity?.integrity_check === "ok") ok("PRAGMA integrity_check = ok");
    else issue(`PRAGMA integrity_check failed: ${JSON.stringify(integrity)}`);

    const objects = await all(
      db,
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY type, name"
    );
    console.log(`DB objects: ${objects.map((o) => `${o.type}:${o.name}`).join(", ")}`);

    if (!objects.some((o) => o.type === "table" && o.name === TABLE_NAME)) {
      issue(`Missing table ${TABLE_NAME}`);
    }
    if (!objects.some((o) => o.type === "view" && o.name === LLM_VIEW_NAME)) {
      issue(`Missing view ${LLM_VIEW_NAME}`);
    }

    const pragma = await all(db, `PRAGMA table_info(${quoteIdentifier(TABLE_NAME)})`);
    const dbCols = pragma.map((col) => col.name);
    const rowCount = (await get(db, `SELECT COUNT(*) AS c FROM ${quoteIdentifier(TABLE_NAME)}`)).c;

    if (rowCount !== expectedRows.length) {
      issue(`Row count mismatch: DB=${rowCount} expected=${expectedRows.length}`);
    } else {
      ok(`Row count matches: ${rowCount}`);
    }

    const enrichmentCols = ["local_authority", "parish", "hq_latitude", "hq_longitude"];
    const expectedDbCols = [...cleanedColumns];
    const hasEnrichment = enrichmentCols.every((c) => dbCols.includes(c));
    if (hasEnrichment) expectedDbCols.push(...enrichmentCols);

    if (dbCols.length !== expectedDbCols.length) {
      issue(`Column count mismatch: DB=${dbCols.length} expected=${expectedDbCols.length}`);
    } else {
      ok(`Column count matches: ${dbCols.length}`);
    }

    for (let i = 0; i < cleanedColumns.length; i += 1) {
      if (dbCols[i] !== cleanedColumns[i]) {
        issue(
          `Column ${i} name mismatch: DB=${JSON.stringify(dbCols[i])} expected=${JSON.stringify(cleanedColumns[i])}`
        );
      }
    }
    if (!issues.some((msg) => msg.includes("Column ") && msg.includes("name mismatch"))) {
      ok("All survey column names match expected cleaned headers");
    }
    if (hasEnrichment) ok("Postcode enrichment columns present (local_authority, parish, hq_lat/lon)");
    else note("Postcode enrichment columns absent (ONSPD not applied?)");

    const dbRows = await all(
      db,
      `SELECT rowid AS __rowid, * FROM ${quoteIdentifier(TABLE_NAME)} ORDER BY rowid`
    );

    let mismatches = 0;
    const mismatchSamples = [];
    let dirtyWhitespaceValues = 0;

    for (let r = 0; r < expectedRows.length; r += 1) {
      const dbRow = dbRows[r];
      if (!dbRow) {
        mismatches += 1;
        if (mismatchSamples.length < 10) mismatchSamples.push({ r, reason: "missing db row" });
        continue;
      }

      for (let c = 0; c < cleanedColumns.length; c += 1) {
        const colName = cleanedColumns[c];
        const expected = expectedRows[r][c];
        const actual = dbRow[colName];

        if (!valuesEqual(expected, actual)) {
          mismatches += 1;
          if (mismatchSamples.length < 15) {
            mismatchSamples.push({
              r,
              c,
              col: colName.slice(0, 80),
              expected,
              actual,
            });
          }
        }

        if (typeof actual === "string" && (/[\r\n]/.test(actual) || actual !== actual.trim())) {
          dirtyWhitespaceValues += 1;
          if (dirtyWhitespaceValues <= 5) {
            issue(`Dirty whitespace in DB value r=${r} c=${c}: ${JSON.stringify(actual).slice(0, 120)}`);
          }
        }
      }
    }

    const totalCells = expectedRows.length * cleanedColumns.length;
    console.log(`Cell comparison: ${totalCells} cells, mismatches=${mismatches}`);
    if (mismatches === 0) ok("All cell values match normalized source");
    else {
      issue(`${mismatches} cell value mismatches`);
      console.log("Mismatch samples:", JSON.stringify(mismatchSamples, null, 2));
    }
    if (dirtyWhitespaceValues === 0) ok("No trailing/embedded newline issues in stored string values");
    else if (dirtyWhitespaceValues > 5) issue(`${dirtyWhitespaceValues} values still have dirty whitespace`);

    // Org-name checks (first kept column / org_name mapping source)
    const nameCol = cleanedColumns[0];
    const dbNames = dbRows.map((row) => row[nameCol]);
    const emptyNames = dbNames.filter((name) => name == null || String(name).trim() === "").length;
    if (emptyNames) issue(`${emptyNames} rows have empty org name`);
    else ok("All org names populated");

    const nameFreq = new Map();
    for (const name of dbNames) {
      const key = name == null ? "<null>" : String(name);
      nameFreq.set(key, (nameFreq.get(key) || 0) + 1);
    }
    const duplicateNames = [...nameFreq.entries()].filter(([, count]) => count > 1);
    if (duplicateNames.length) {
      note(
        `Duplicate org names (${duplicateNames.length}): ${duplicateNames
          .slice(0, 10)
          .map(([n, c]) => `${JSON.stringify(n)}×${c}`)
          .join(", ")}`
      );
    } else {
      ok("All org names unique");
    }

    console.log("First 5 org names:", dbNames.slice(0, 5));
    console.log("Last 5 org names:", dbNames.slice(-5));

    // LLM view
    if (objects.some((o) => o.type === "view" && o.name === LLM_VIEW_NAME)) {
      const viewInfo = await all(db, `PRAGMA table_info(${quoteIdentifier(LLM_VIEW_NAME)})`);
      const viewCols = viewInfo.map((col) => col.name);
      console.log(`${LLM_VIEW_NAME} columns: ${viewCols.join(", ")}`);

      const optionalEnrichment = new Set(["local_authority", "parish", "hq_latitude", "hq_longitude"]);
      for (const alias of EXPECTED_LLM_ALIASES) {
        if (!viewCols.includes(alias)) {
          if (optionalEnrichment.has(alias)) note(`${LLM_VIEW_NAME} missing optional alias ${alias}`);
          else issue(`${LLM_VIEW_NAME} missing alias ${alias}`);
        }
      }

      const viewCount = (await get(db, `SELECT COUNT(*) AS c FROM ${quoteIdentifier(LLM_VIEW_NAME)}`)).c;
      if (viewCount !== rowCount) issue(`${LLM_VIEW_NAME} row count ${viewCount} != ${TABLE_NAME} ${rowCount}`);
      else ok(`${LLM_VIEW_NAME} row count matches ${TABLE_NAME} (${viewCount})`);

      const mappings = buildLlmViewMappings(dbCols);
      for (const alias of EXPECTED_LLM_ALIASES) {
        if (!viewCols.includes(alias)) continue; // enrichment may be absent without ONSPD
        if (!mappings.some((m) => m.alias === alias)) issue(`No source column mapped for LLM alias ${alias}`);
      }
      if (!issues.some((msg) => msg.includes("LLM alias"))) {
        ok("All expected LLM view aliases map to source columns");
      }

      const tableNamesSorted = [...dbNames].map(String).sort();
      /**
       * Collect view names from sqlite_master for verification.
       * @param {import("sqlite3").Database} db
       * @returns {Promise<string[]>}
       */
      const viewNames = (await all(db, `SELECT org_name FROM ${quoteIdentifier(LLM_VIEW_NAME)}`)).map((r) =>
        String(r.org_name)
      );
      const viewNamesSorted = [...viewNames].sort();
      let nameSetMismatches = 0;
      for (let i = 0; i < Math.max(tableNamesSorted.length, viewNamesSorted.length); i += 1) {
        if (tableNamesSorted[i] !== viewNamesSorted[i]) nameSetMismatches += 1;
      }
      if (nameSetMismatches) issue(`${LLM_VIEW_NAME}.org_name multiset mismatch (~${nameSetMismatches})`);
      else ok(`${LLM_VIEW_NAME}.org_name multiset matches ${TABLE_NAME}`);
    }

    // Schema file
    const schemaText = fs.readFileSync(SCHEMA_PATH, "utf8");
    if (!schemaText.includes(`Table name: ${TABLE_NAME}`)) issue(`Schema missing table ${TABLE_NAME}`);
    if (!schemaText.includes(`View name: ${LLM_VIEW_NAME}`)) issue(`Schema missing view ${LLM_VIEW_NAME}`);

    const populatedPairs = [...schemaText.matchAll(/populated (\d+)\/(\d+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    const badPopulated = populatedPairs.filter(([populated, total]) => populated > total || total !== rowCount);
    if (badPopulated.length) {
      issue(`Schema populated counts inconsistent: ${JSON.stringify(badPopulated.slice(0, 5))}`);
    } else {
      ok(`Schema populated denominators match row count ${rowCount} (${populatedPairs.length} entries)`);
    }

    const schemaCols = parseSchemaTableColumns(schemaText, `Table name: ${TABLE_NAME}`);
    if (!schemaCols) {
      issue("Could not parse orgs columns from schema file");
    } else if (schemaCols.length !== dbCols.length) {
      issue(`Schema orgs column parse count ${schemaCols.length} != DB ${dbCols.length}`);
    } else {
      let popIssues = 0;
      for (let i = 0; i < dbCols.length; i += 1) {
        const col = dbCols[i];
        const quoted = quoteIdentifier(col);
        const { c } = await get(
          db,
          `SELECT COUNT(*) AS c FROM ${quoteIdentifier(TABLE_NAME)} WHERE ${quoted} IS NOT NULL AND TRIM(CAST(${quoted} AS TEXT)) != ''`
        );
        const schemaCol = schemaCols[i];
        if (schemaCol.name !== col) {
          issue(
            `Schema col order/name mismatch at ${i}: schema=${JSON.stringify(schemaCol.name).slice(0, 80)} db=${JSON.stringify(col).slice(0, 80)}`
          );
          popIssues += 1;
          continue;
        }
        if (schemaCol.populated !== c || (schemaCol.total != null && schemaCol.total !== rowCount)) {
          issue(
            `Populated mismatch for col ${i} ${col.slice(0, 50)}: schema ${schemaCol.populated}/${schemaCol.total} db ${c}/${rowCount}`
          );
          popIssues += 1;
        }
      }
      if (popIssues === 0) ok("All schema populated counts match live DB queries");
    }

    if (schemaText.includes("\n\nplease_")) {
      issue("Schema still appears to contain broken multiline column names");
    } else {
      ok("Schema column names look single-line");
    }

    // Metadata exclusion summary (informational)
    let metaNonEmptyCols = 0;
    for (let i = 0; i < FIRST_DATA_COLUMN_INDEX; i += 1) {
      if (normalizedDataRows.some((row) => !isEmptyCell(row[i]))) metaNonEmptyCols += 1;
    }
    note(
      `Intentionally excluded metadata columns A–S with data: ${metaNonEmptyCols}/${FIRST_DATA_COLUMN_INDEX}`
    );
  } finally {
    await close(db);
  }

  console.log("\n========== SUMMARY ==========");
  console.log(`OK:     ${oks.length}`);
  console.log(`Notes:  ${notes.length}`);
  console.log(`Issues: ${issues.length}`);
  for (const msg of issues) console.log(` - ${msg}`);
  for (const msg of notes) console.log(` ~ ${msg}`);

  if (issues.length === 0) {
    console.log("RESULT: PASS — schema and data integrity match source under importer rules");
    process.exitCode = 0;
  } else {
    console.log("RESULT: FAIL");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
