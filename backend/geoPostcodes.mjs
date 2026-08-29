import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'csv-parse/sync'

/**
 * Resolve UK postcodes to local authority / parish / coordinates using a local
 * ONS Postcode Directory (ONSPD) zip or extracted folder under backend/geo/.
 *
 * Designed for weekly directory rebuilds: looks up whatever postcodes appear in
 * the current survey export. Does not ship ONSPD to production — enrichment is
 * written into directory.db at import time only.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const GEO_DIR = path.join(__dirname, 'geo')

/** Columns added to `orgs` / exposed on `orgs_llm` after postcode enrichment. */
export const ENRICHMENT_COLUMNS = [
  { name: 'local_authority', type: 'TEXT' },
  { name: 'parish', type: 'TEXT' },
  { name: 'hq_latitude', type: 'REAL' },
  { name: 'hq_longitude', type: 'REAL' },
]

/**
 * Compact postcode key: uppercase, no spaces (e.g. RG404PZ).
 * @param {unknown} value
 * @returns {string | null}
 */
export function compactPostcode(value) {
  if (value === undefined || value === null) return null
  const compact = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  return compact || null
}

/**
 * Display form with a single space before the inward code (e.g. RG40 4PZ).
 * @param {unknown} value
 * @returns {string | null}
 */
export function formatPostcode(value) {
  const compact = compactPostcode(value)
  if (!compact || compact.length < 5) return compact
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`
}

/**
 * Postcode area letters used by ONSPD multi_csv filenames (e.g. RG, B, EC).
 * @param {string} compact
 * @returns {string | null}
 */
function postcodeArea(compact) {
  const match = compact.match(/^([A-Z]+)/)
  return match ? match[1] : null
}

/**
 * @returns {{ kind: 'zip' | 'dir', path: string } | null}
 */
export function findOnspdSource(geoDir = GEO_DIR) {
  if (!fs.existsSync(geoDir)) return null

  const entries = fs.readdirSync(geoDir)
  const zip = entries
    .filter((name) => /^ONSPD_.*\.zip$/i.test(name))
    .sort()
    .at(-1)
  if (zip) return { kind: 'zip', path: path.join(geoDir, zip) }

  const dirs = entries
    .filter((name) => {
      const full = path.join(geoDir, name)
      return fs.statSync(full).isDirectory() && /onspd/i.test(name)
    })
    .sort()
  for (const name of dirs.reverse()) {
    const full = path.join(geoDir, name)
    if (findOnspdDataRoot(full)) return { kind: 'dir', path: full }
  }
  return null
}

/**
 * @param {string} root
 * @returns {string | null} path containing Data/ and Documents/
 */
function findOnspdDataRoot(root) {
  const candidates = [root, path.join(root, 'onspd_may_2026'), path.join(root, 'ONSPD')]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'Data')) && fs.existsSync(path.join(candidate, 'Documents'))) {
      return candidate
    }
  }
  // Walk one level for extracted layouts.
  if (!fs.existsSync(root)) return null
  for (const name of fs.readdirSync(root)) {
    const child = path.join(root, name)
    try {
      if (!fs.statSync(child).isDirectory()) continue
    } catch {
      continue
    }
    if (fs.existsSync(path.join(child, 'Data')) && fs.existsSync(path.join(child, 'Documents'))) {
      return child
    }
  }
  return null
}

/**
 * Read a file from an ONSPD zip via `unzip -p` (no full extract).
 * @param {string} zipPath
 * @param {string} memberPath
 * @returns {Buffer | null}
 */
function readZipMember(zipPath, memberPath) {
  const result = spawnSync('unzip', ['-p', zipPath, memberPath], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0 || !result.stdout || result.stdout.length === 0) return null
  return result.stdout
}

/**
 * List zip member paths (unzip -l).
 * @param {string} zipPath
 * @returns {string[]}
 */
function listZipMembers(zipPath) {
  const result = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  if (result.status !== 0) return []
  return String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * @param {{ kind: 'zip' | 'dir', path: string }} source
 * @param {(memberPath: string) => boolean} predicate
 * @returns {{ memberPath: string, buffer: Buffer } | null}
 */
function readFirstMatching(source, predicate) {
  if (source.kind === 'zip') {
    const members = listZipMembers(source.path)
    const memberPath = members.find(predicate)
    if (!memberPath) return null
    const buffer = readZipMember(source.path, memberPath)
    if (!buffer) return null
    return { memberPath, buffer }
  }

  const root = findOnspdDataRoot(source.path)
  if (!root) return null
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) {
        stack.push(full)
        continue
      }
      const rel = full.slice(root.length + 1).replaceAll('\\', '/')
      if (predicate(rel) || predicate(full)) {
        return { memberPath: rel, buffer: fs.readFileSync(full) }
      }
    }
  }
  return null
}

/**
 * @param {Buffer | string} csvBuffer
 * @returns {Map<string, string>} code -> name
 */
function parseCodeNameCsv(csvBuffer, codeHeaderPrefix, nameHeaderPrefix) {
  const rows = parse(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  })
  const map = new Map()
  if (!rows.length) return map

  const headers = Object.keys(rows[0])
  const prefix = codeHeaderPrefix.toLowerCase()
  const codeKey =
    headers.find((h) => h.toLowerCase().startsWith(prefix) && /cd$/i.test(h)) ||
    headers.find((h) => /cd$/i.test(h))
  const nameKey =
    headers.find((h) => h.toLowerCase().startsWith(prefix) && /nm$/i.test(h) && !/nmw$/i.test(h)) ||
    headers.find((h) => /nm$/i.test(h) && !/nmw$/i.test(h))
  if (!codeKey || !nameKey) return map

  for (const row of rows) {
    const code = String(row[codeKey] || '').trim()
    const name = String(row[nameKey] || '').trim()
    if (code && name) map.set(code, name)
  }
  return map
}

/**
 * Load LAD and parish name lookups from ONSPD Documents.
 * @param {{ kind: 'zip' | 'dir', path: string }} source
 */
function loadNameLookups(source) {
  const lad = readFirstMatching(
    source,
    (p) => /Documents\/.*LAD.*names and codes/i.test(p) && p.toLowerCase().endsWith('.csv')
  )
  const parish = readFirstMatching(
    source,
    (p) => /Documents\/.*PARNCP.*names and codes/i.test(p) && p.toLowerCase().endsWith('.csv')
  )

  const ladNames = lad ? parseCodeNameCsv(lad.buffer, 'LAD', 'LAD') : new Map()
  // Parish file headers are typically PARNCP25CD / PARNCP25NM
  const parishNames = parish ? parseCodeNameCsv(parish.buffer, 'PARNCP', 'PARNCP') : new Map()
  return { ladNames, parishNames }
}

/**
 * Resolve multi_csv member path for a postcode area.
 * @param {string[]} members
 * @param {string} area
 * @returns {string | null}
 */
function multiCsvMemberForArea(members, area) {
  const upper = area.toUpperCase()
  const areaSuffix = new RegExp(`_UK_${upper}\.csv$`, 'i')
  return members.find((m) => /multi_csv/i.test(m) && areaSuffix.test(m)) || null
}

/**
 * @param {{ kind: 'zip' | 'dir', path: string }} source
 * @param {string} area
 * @param {string[]} zipMembers
 * @returns {Buffer | null}
 */
function readAreaCsv(source, area, zipMembers) {
  if (source.kind === 'zip') {
    const member = multiCsvMemberForArea(zipMembers, area)
    if (!member) return null
    return readZipMember(source.path, member)
  }
  const root = findOnspdDataRoot(source.path)
  if (!root) return null
  const multiDir = path.join(root, 'Data', 'multi_csv')
  if (!fs.existsSync(multiDir)) return null
  const file = fs
    .readdirSync(multiDir)
    .find((name) => new RegExp(`_UK_${area}\.csv$`, 'i').test(name))
  if (!file) return null
  return fs.readFileSync(path.join(multiDir, file))
}

/**
 * @typedef {{ local_authority: string | null, parish: string | null, hq_latitude: number | null, hq_longitude: number | null }} PostcodeEnrichment
 */

/**
 * Look up enrichment for a set of postcodes via local ONSPD.
 * Prefer live (doterm empty) rows; fall back to terminated if needed.
 *
 * @param {Iterable<unknown>} postcodes
 * @param {{ geoDir?: string }} [options]
 * @returns {{
 *   source: string | null,
 *   byCompact: Map<string, PostcodeEnrichment>,
 *   matched: string[],
 *   unmatched: string[],
 *   missingAreas: string[],
 * }}
 */
export function enrichPostcodesFromOnspd(postcodes, options = {}) {
  const geoDir = options.geoDir || GEO_DIR
  const wanted = new Map() // compact -> original display
  for (const value of postcodes) {
    const compact = compactPostcode(value)
    if (!compact) continue
    if (!wanted.has(compact)) wanted.set(compact, formatPostcode(value) || compact)
  }

  const empty = {
    source: null,
    byCompact: new Map(),
    matched: [],
    unmatched: [...wanted.keys()].map((c) => wanted.get(c)),
    missingAreas: [],
  }
  if (wanted.size === 0) return { ...empty, unmatched: [] }

  const source = findOnspdSource(geoDir)
  if (!source) return empty

  const { ladNames, parishNames } = loadNameLookups(source)
  const zipMembers = source.kind === 'zip' ? listZipMembers(source.path) : []

  /** @type {Map<string, string[]>} */
  const byArea = new Map()
  for (const compact of wanted.keys()) {
    const area = postcodeArea(compact)
    if (!area) continue
    if (!byArea.has(area)) byArea.set(area, [])
    byArea.get(area).push(compact)
  }

  /** @type {Map<string, PostcodeEnrichment & { terminated: boolean }>} */
  const found = new Map()
  const missingAreas = []

  for (const [area, compacts] of byArea) {
    const need = new Set(compacts)
    const csvBuffer = readAreaCsv(source, area, zipMembers)
    if (!csvBuffer) {
      missingAreas.push(area)
      continue
    }

    const rows = parse(csvBuffer, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      relax_quotes: true,
    })

    for (const row of rows) {
      const compact = compactPostcode(row.pcd7 || row.pcds || row.pcd8)
      if (!compact || !need.has(compact)) continue

      const terminated = Boolean(String(row.doterm || '').trim())
      const existing = found.get(compact)
      if (existing && !existing.terminated) continue // already have live
      if (existing && terminated) continue

      const ladCode = String(row.lad25cd || row.oslaua || '').trim()
      const parishCode = String(row.parncp25cd || '').trim()
      const latRaw = row.lat
      const lonRaw = row.long
      const lat = latRaw === undefined || latRaw === '' ? null : Number(latRaw)
      const lon = lonRaw === undefined || lonRaw === '' ? null : Number(lonRaw)

      found.set(compact, {
        local_authority: ladNames.get(ladCode) || null,
        parish: parishNames.get(parishCode) || null,
        hq_latitude: Number.isFinite(lat) ? lat : null,
        hq_longitude: Number.isFinite(lon) ? lon : null,
        terminated,
      })
    }
  }

  const byCompact = new Map()
  const matched = []
  const unmatched = []
  for (const [compact, display] of wanted) {
    const hit = found.get(compact)
    if (hit && (hit.local_authority || hit.hq_latitude != null)) {
      byCompact.set(compact, {
        local_authority: hit.local_authority,
        parish: hit.parish,
        hq_latitude: hit.hq_latitude,
        hq_longitude: hit.hq_longitude,
      })
      matched.push(display)
    } else {
      unmatched.push(display)
    }
  }

  return {
    source: source.path,
    byCompact,
    matched,
    unmatched,
    missingAreas,
  }
}

/**
 * Apply enrichment map onto orgs rows by postcode column.
 * @param {sqlite3.Database} db
 * @param {string} tableName
 * @param {string} postcodeColumn
 * @param {Map<string, PostcodeEnrichment>} byCompact
 * @param {(sql: string, params?: unknown[]) => Promise<void>} run
 * @param {(sql: string) => Promise<any[]>} all
 */
export async function applyPostcodeEnrichment(db, tableName, postcodeColumn, byCompact, run, all) {
  for (const col of ENRICHMENT_COLUMNS) {
    await run(
      db,
      `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(col.name)} ${col.type}`
    )
  }

  const rows = await all(db, `SELECT rowid AS __rid, ${quoteIdent(postcodeColumn)} AS pc FROM ${quoteIdent(tableName)}`)
  const updateSql = `UPDATE ${quoteIdent(tableName)}
    SET local_authority = ?, parish = ?, hq_latitude = ?, hq_longitude = ?
    WHERE rowid = ?`

  let updated = 0
  for (const row of rows) {
    const compact = compactPostcode(row.pc)
    if (!compact) continue
    const hit = byCompact.get(compact)
    if (!hit) continue
    await run(db, updateSql, [
      hit.local_authority,
      hit.parish,
      hit.hq_latitude,
      hit.hq_longitude,
      row.__rid,
    ])
    updated += 1
  }
  return updated
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`
}
