/**
 * Import a Qualtrics CSV/XLSX survey export into SQLite (`directory.db`),
 * enrich HQ postcodes via ONSPD when available, create the LLM-facing
 * `orgs_llm` view, and write `directory.schema` for text-to-SQL prompts.
 *
 * Outputs (written under this directory when run from `backend/`):
 *   directory.db       — organisations table + orgs_llm view
 *   directory.schema   — human-readable schema for text-to-SQL prompts
 *
 * Usage:
 *   cd backend
 *   node csvToDB.mjs
 *   node csvToDB.mjs path/to/qualtrics-export.xlsx
 *   node csvToDB.mjs path/to/qualtrics-export.csv
 *
 * Defaults:
 *   input  = ../directory.csv
 *   db     = ./directory.db
 *   schema = ./directory.schema
 *
 * ONSPD: if backend/geo/ONSPD_*.zip (or an extracted ONSPD folder) is present,
 * HQ postcodes are enriched with local_authority, parish, hq_latitude,
 * hq_longitude. Prefer backend/ops/refresh-directory.sh for weekly imports
 * (import + match-rate gate + verify + optional deploy).
 *
 * @license MIT
 * Copyright (c) 2025–2026 Nigel Gilbert and contributors
 * University of Surrey — INHABIT / National Retrofit Hub
 */

import path from 'node:path'
import { parse } from 'csv-parse/sync'
import sqlite3 from 'sqlite3'
import XLSX from 'xlsx'
import {
  ENRICHMENT_COLUMNS,
  applyPostcodeEnrichment,
  enrichPostcodesFromOnspd,
  findOnspdSource,
} from './lib/geoPostcodes.mjs'
import {
  CANONICAL_SCHEMA_PATH,
  SCHEMA_PATH,
  TABLE_NAME,
  findColumnByTokens,
  quoteIdentifier,
  recreateOrgsLlmView,
  writeSchemaFiles,
} from './lib/orgsLlmView.mjs'

const INPUT_PATH = process.argv[2] || '../directory.csv'
const DB_PATH = 'directory.db'
const HEADER_ROW_INDEX = 1
// Optional 0-based source row indexes to drop before header/data split (e.g. extra label rows).
const SKIP_ROWS = new Set()
// Spreadsheet columns A–S (0–18) are survey-respondent metadata, not answers.
const FIRST_DATA_COLUMN_INDEX = 19 // column T onwards

/**
 * Normalise free text: embedded newlines → spaces, collapse runs of whitespace,
 * trim leading/trailing spaces and newlines.
 * @param {string} value
 * @returns {string}
 */
function normalizeWhitespace(value) {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim()
}

/**
 * Normalise a CSV header label into a deterministic SQL column identifier.
 * @param {unknown} columnName
 * @returns {string}
 */
function cleanColumnName(columnName) {
  return normalizeWhitespace(columnName).toLowerCase().replace(/ /g, '_')
}

/**
 * Coerce a cell to the value stored in SQLite, including text whitespace cleanup.
 * Empty cells become null. Dates become SQLite datetime strings. Other non-strings
 * pass through unchanged.
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeCellValue(value) {
  if (isEmptyCell(value)) return null
  if (value instanceof Date) {
    return value
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
  }
  if (typeof value === 'string') {
    const normalized = normalizeWhitespace(value)
    return normalized === '' ? null : normalized
  }
  return value
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
    value === '' ||
    (typeof value === 'string' && value.trim() === '')
  )
}

/**
 * True when every data-row value in a column is empty.
 * @param {unknown[][]} dataRows
 * @param {number} colIdx
 * @returns {boolean}
 */
function isColumnEmpty(dataRows, colIdx) {
  return dataRows.every((row) => isEmptyCell(row[colIdx]))
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
        reject(err)
        return
      }
      resolve()
    })
  })
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
        reject(err)
        return
      }
      resolve(rows)
    })
  })
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
        reject(err)
        return
      }
      resolve()
    })
  })
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
  let hasFloat = false
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue
    if (v instanceof Date) return 'TEXT'
    if (typeof v === 'boolean') return 'INTEGER'
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) hasFloat = true
      continue
    }
    return 'TEXT'
  }
  // If every value was empty we can't infer a numeric type — default to TEXT.
  if (!hasFloat && values.every((v) => v === undefined || v === null || v === '')) return 'TEXT'
  return hasFloat ? 'REAL' : 'INTEGER'
}

/**
 * Convert an Excel serial date number into a JS Date (UTC), if possible.
 * @param {number} serial
 * @returns {Date | null}
 */
function excelSerialToDate(serial) {
  const parts = XLSX.SSF.parse_date_code(serial)
  if (!parts) return null
  const seconds = Math.floor(parts.S || 0)
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d, parts.H || 0, parts.M || 0, seconds))
}

/**
 * For date columns in XLSX data, coerce serial/date-like values to Date objects.
 * @param {unknown[][]} rows
 * @returns {unknown[][]}
 */
function normalizeExcelDateColumns(rows) {
  const dateColumns = new Set()

  for (const row of rows) {
    for (let i = 0; i < row.length; i += 1) {
      if (row[i] instanceof Date) dateColumns.add(i)
    }
  }

  if (dateColumns.size === 0) return rows

  return rows.map((row) =>
    row.map((value, index) => {
      if (!dateColumns.has(index)) return value
      if (value instanceof Date || value === undefined || value === null || value === '')
        return value
      if (typeof value === 'number') return excelSerialToDate(value) ?? value
      if (typeof value === 'string') {
        const parsed = new Date(value)
        return Number.isNaN(parsed.getTime()) ? value : parsed
      }
      return value
    })
  )
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
  const originalConsoleError = console.error
  const warningPattern = /^Bad (compressed|uncompressed) size: \d+ != 0$/

  console.error = (...args) => {
    const message = args
      .map((value) => (typeof value === 'string' ? value : String(value)))
      .join(' ')

    if (warningPattern.test(message)) return
    originalConsoleError(...args)
  }

  try {
    return fn()
  } finally {
    console.error = originalConsoleError
  }
}

/**
 * Load tabular rows from CSV or XLSX input.
 * @param {string} inputPath
 * @returns {{ rows: unknown[][], format: "csv" | "xlsx" }}
 */
function loadRowsFromInput(inputPath) {
  const ext = path.extname(inputPath).toLowerCase()

  if (ext === '.csv') {
    const rawCsv = fs.readFileSync(inputPath, 'utf8')
    return {
      rows: parse(rawCsv, {
        relax_column_count: true,
        skip_empty_lines: false,
        cast: true,
        cast_date: true,
      }),
      format: 'csv',
    }
  }

  if (ext === '.xlsx') {
    const workbook = withSuppressedXlsxZipSizeWarnings(() =>
      XLSX.readFile(inputPath, { cellDates: true, raw: true })
    )
    const firstSheet = workbook.SheetNames[0]
    if (!firstSheet) {
      throw new Error('XLSX file does not contain any sheets.')
    }

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
      header: 1,
      raw: true,
      defval: '',
      blankrows: true,
    })

    return { rows, format: 'xlsx' }
  }

  throw new Error(`Unsupported input file extension: ${ext || '(none)'} (expected .csv or .xlsx).`)
}

/**
 * Parse CSV data, recreate the SQLite table, insert rows and write schema.
 * @returns {Promise<void>}
 */
async function main() {
  const { rows, format } = loadRowsFromInput(INPUT_PATH)

  const filteredRows = rows.filter((_, index) => !SKIP_ROWS.has(index))

  if (filteredRows.length <= HEADER_ROW_INDEX) {
    throw new Error('Input file does not contain enough rows to read the configured header.')
  }

  const headerRow = filteredRows[HEADER_ROW_INDEX]
  const dataRows = filteredRows.slice(HEADER_ROW_INDEX + 1)
  const normalizedDataRows = format === 'xlsx' ? normalizeExcelDateColumns(dataRows) : dataRows

  // Keep survey-answer columns only (T onwards) and drop columns with no data.
  const maxColumnCount = Math.max(
    headerRow.length,
    ...normalizedDataRows.map((row) => row.length),
    FIRST_DATA_COLUMN_INDEX
  )
  const keptColumnIndexes = []
  for (let colIdx = FIRST_DATA_COLUMN_INDEX; colIdx < maxColumnCount; colIdx += 1) {
    if (isColumnEmpty(normalizedDataRows, colIdx)) continue
    keptColumnIndexes.push(colIdx)
  }

  if (keptColumnIndexes.length === 0) {
    throw new Error(
      `No non-empty data columns found from column index ${FIRST_DATA_COLUMN_INDEX} (T) onwards.`
    )
  }

  const cleanedColumns = keptColumnIndexes.map((colIdx) => {
    const rawName = headerRow[colIdx]
    const cleaned = cleanColumnName(rawName)
    return cleaned || `column_${colIdx + 1}`
  })

  const db = new sqlite3.Database(DB_PATH)

  try {
    await run(db, `DROP TABLE IF EXISTS ${quoteIdentifier(TABLE_NAME)}`)

    // Infer a SQLite type per column from the cast values.
    const columnTypes = keptColumnIndexes.map((sourceIdx) =>
      inferSqliteType(normalizedDataRows.map((row) => row[sourceIdx]))
    )
    const createColumns = cleanedColumns
      .map((c, i) => `${quoteIdentifier(c)} ${columnTypes[i]}`)
      .join(', ')
    await run(db, `CREATE TABLE ${quoteIdentifier(TABLE_NAME)} (${createColumns})`)

    const insertSql = `INSERT INTO ${quoteIdentifier(TABLE_NAME)} (${cleanedColumns
      .map(quoteIdentifier)
      .join(', ')}) VALUES (${cleanedColumns.map(() => '?').join(', ')})`

    for (const row of normalizedDataRows) {
      const normalizedRow = keptColumnIndexes.map((sourceIdx) => normalizeCellValue(row[sourceIdx]))
      await run(db, insertSql, normalizedRow)
    }

    // HQ place enrichment from local ONSPD (weekly-safe: all postcodes in this export).
    const postcodeColumn = findColumnByTokens(cleanedColumns, ['postcode', 'organisation', 'headquarters'])
    let enrichedColumns = [...cleanedColumns]
    if (postcodeColumn) {
      const postcodes = (
        await all(
          db,
          `SELECT DISTINCT ${quoteIdentifier(postcodeColumn)} AS pc FROM ${quoteIdentifier(TABLE_NAME)} WHERE ${quoteIdentifier(postcodeColumn)} IS NOT NULL`
        )
      ).map((r) => r.pc)

      const onspd = findOnspdSource()
      if (!onspd) {
        console.warn(
          'ONSPD not found under backend/geo/ (expected ONSPD_*.zip). Skipping postcode place enrichment.'
        )
      } else {
        console.log(`ONSPD source: ${onspd.path}`)
        const enrichment = enrichPostcodesFromOnspd(postcodes)
        const updated = await applyPostcodeEnrichment(
          db,
          TABLE_NAME,
          postcodeColumn,
          enrichment.byCompact,
          run,
          all
        )
        enrichedColumns = [...cleanedColumns, ...ENRICHMENT_COLUMNS.map((c) => c.name)]
        console.log(
          `Postcode enrichment: ${enrichment.matched.length} matched, ${enrichment.unmatched.length} unmatched, ${updated} rows updated`
        )
        if (enrichment.unmatched.length) {
          console.warn(`Unmatched postcodes: ${enrichment.unmatched.join(', ')}`)
        }
        if (enrichment.missingAreas.length) {
          console.warn(`Missing ONSPD area CSVs: ${enrichment.missingAreas.join(', ')}`)
        }
      }
    } else {
      console.warn('No headquarters postcode column found; skipping place enrichment.')
    }

    const viewMappings = await recreateOrgsLlmView(db, { run, all })
    await writeSchemaFiles(db, { all })
    console.log(`Input file: ${INPUT_PATH}`)
    console.log(`Database written to ${DB_PATH}`)
    console.log(`orgs_llm aliases: ${viewMappings.length}`)
    console.log(`Full schema: ${SCHEMA_PATH}`)
    console.log(`Canonical schema: ${CANONICAL_SCHEMA_PATH}`)
  } finally {
    await close(db)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
