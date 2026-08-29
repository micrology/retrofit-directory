import sqlite3 from 'sqlite3'
import { geocodePlace, haversineKm, kmToMiles, milesToKm, normalisePlaceKey } from './geocode.mjs'

/** Default radius for “near X” when the user does not specify one. */
export const DEFAULT_NEAR_RADIUS_MILES = 25
/** Max organisations returned for a near list. */
export const DEFAULT_NEAR_LIMIT = 25
/** Default k for “nearest”. */
export const DEFAULT_NEAREST_LIMIT = 1
const MAX_RADIUS_MILES = 200
const MAX_NEAREST_LIMIT = 10

/**
 * Activity / type tokens mapped to SQL LIKE patterns across org fields.
 * First matching group wins when several appear in the query.
 */
const TYPE_FILTERS = [
  {
    id: 'installer',
    label: 'installers',
    trigger: /\binstallers?\b|\binstallation\b/i,
    patterns: ['%install%'],
  },
  {
    id: 'architect',
    label: 'architects',
    trigger: /\barchitects?\b|\barchitecture\b/i,
    patterns: ['%architect%'],
  },
  {
    id: 'manufacturer',
    label: 'manufacturers / suppliers',
    trigger: /\bmanufacturers?\b|\bsuppliers?\b/i,
    patterns: ['%manufactur%', '%supplier%'],
  },
  {
    id: 'consultant',
    label: 'consultants / advisors',
    trigger: /\bconsultants?\b|\badvisors?\b|\badvisers?\b/i,
    patterns: ['%consult%', '%advisor%', '%adviser%'],
  },
  {
    id: 'contractor',
    label: 'contractors / builders',
    trigger: /\bcontractors?\b|\bbuilders?\b/i,
    patterns: ['%contractor%', '%builder%'],
  },
]

/**
 * Detect near / nearest proximity intent and extract place + options.
 * Returns null when the question should use ordinary text-to-SQL.
 *
 * @param {string} query
 * @returns {{
 *   kind: 'near' | 'nearest',
 *   placeText: string,
 *   radiusMiles: number | null,
 *   limit: number,
 *   typeFilter: { id: string, label: string, patterns: string[] } | null,
 * } | null}
 */
export function parseProximityIntent(query) {
  const q = String(query || '').replace(/\s+/g, ' ').trim()
  if (!q) return null

  const typeFilter = detectTypeFilter(q)

  // “within N miles/km of PLACE”
  let m = q.match(
    /\b(?:within|inside)\s+(\d+(?:\.\d+)?)\s*(miles?|mi|km|kilometres?|kilometers?)\s+(?:of|from)\s+(.+?)\s*$/i
  )
  if (m) {
    const placeText = cleanPlaceCapture(m[3])
    if (!placeText) return null
    return {
      kind: 'near',
      placeText,
      radiusMiles: parseRadiusMiles(m[1], m[2]),
      limit: DEFAULT_NEAR_LIMIT,
      typeFilter,
    }
  }

  // “nearest|closest [type…] to|near PLACE”
  if (/\b(?:nearest|closest)\b/i.test(q)) {
    m = q.match(
      /\b(?:the\s+)?(?:nearest|closest)\b(?:\s+[\w'/+-]+){0,10}?\s+(?:to|near)\s+(.+?)\s*$/i
    )
    if (m) {
      const placeText = cleanPlaceCapture(m[1])
      if (placeText) {
        const limitMatch = q.match(/\btop\s+(\d+)\b/i)
        const limit = limitMatch
          ? Math.min(MAX_NEAREST_LIMIT, Math.max(1, Number(limitMatch[1])))
          : DEFAULT_NEAREST_LIMIT
        return { kind: 'nearest', placeText, radiusMiles: null, limit, typeFilter }
      }
    }
  }

  // “how far is the nearest …” handled above; also “which org is nearest to X”
  m = q.match(/\b(?:which|what)\b.+\b(?:nearest|closest)\b.+\b(?:to|near)\s+(.+?)\s*$/i)
  if (m) {
    const placeText = cleanPlaceCapture(m[1])
    if (placeText) {
      return {
        kind: 'nearest',
        placeText,
        radiusMiles: null,
        limit: DEFAULT_NEAREST_LIMIT,
        typeFilter,
      }
    }
  }

  // “in and near PLACE” / “near PLACE” / “around PLACE” / “close to PLACE”
  m = q.match(
    /\b(?:in\s+and\s+near|near(?:\s+to)?|around|close\s+to|nearby(?:\s+to)?)\s+(.+?)\s*$/i
  )
  if (m) {
    let rest = m[1]
    let radiusMiles = DEFAULT_NEAR_RADIUS_MILES
    const radiusInRest = rest.match(
      /^(?:within\s+)?(\d+(?:\.\d+)?)\s*(miles?|mi|km|kilometres?|kilometers?)\s+(?:of\s+)?(.+)$/i
    )
    if (radiusInRest) {
      radiusMiles = parseRadiusMiles(radiusInRest[1], radiusInRest[2])
      rest = radiusInRest[3]
    }
    const placeText = cleanPlaceCapture(rest)
    if (!placeText) return null
    // Avoid treating pure “based in X” without near-language as proximity — those
    // use local_authority text match. Require near-ish cue already matched.
    return {
      kind: 'near',
      placeText,
      radiusMiles,
      limit: DEFAULT_NEAR_LIMIT,
      typeFilter,
    }
  }

  // “organisations within 10 miles of Reading” already covered.
  // “list orgs near Reading, within 15 miles”
  m = q.match(/\bnear\s+(.+?)(?:,|\s+)\s*within\s+(\d+(?:\.\d+)?)\s*(miles?|mi|km)\b/i)
  if (m) {
    const placeText = cleanPlaceCapture(m[1])
    if (placeText) {
      return {
        kind: 'near',
        placeText,
        radiusMiles: parseRadiusMiles(m[2], m[3]),
        limit: DEFAULT_NEAR_LIMIT,
        typeFilter,
      }
    }
  }

  return null
}

/**
 * @param {string} q
 */
function detectTypeFilter(q) {
  for (const filter of TYPE_FILTERS) {
    if (filter.trigger.test(q)) {
      return { id: filter.id, label: filter.label, patterns: filter.patterns }
    }
  }
  return null
}

/**
 * @param {string} amount
 * @param {string} unit
 */
function parseRadiusMiles(amount, unit) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_NEAR_RADIUS_MILES
  const u = String(unit || 'miles').toLowerCase()
  const miles = u.startsWith('km') || u.startsWith('kilomet') ? kmToMiles(n) : n
  return Math.min(MAX_RADIUS_MILES, Math.max(0.5, miles))
}

/**
 * @param {string} raw
 */
function cleanPlaceCapture(raw) {
  let s = String(raw || '').trim()
  // Strip trailing punctuation and common trailing clauses.
  s = s.replace(/[?.!,;:]+$/g, '').trim()
  s = s.replace(/\b(in\s+the\s+directory|please|thanks|thank\s+you)\b.*$/i, '').trim()
  s = s.replace(/^(?:the\s+town\s+of|the\s+city\s+of|the)\s+/i, '').trim()
  // Drop leading org-type words left over from “nearest installer to X”
  s = s.replace(
    /^(?:installer|installers|architect|architects|organisation|organizations|organizations|organisations|company|companies|contractor|contractors)\s+/i,
    ''
  ).trim()
  if (s.length < 2) return ''
  // Reject if capture looks like the whole question still.
  if (/\b(how many|list all|what is)\b/i.test(s) && s.length > 40) return ''
  return s
}

/**
 * @param {string} dbPath
 * @returns {Promise<sqlite3.Database>}
 */
function openDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject(err)
      else resolve(db)
    })
  })
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  })
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()))
  })
}

/**
 * Load HQ-geocoded organisations (optionally type-filtered) and sort by distance.
 * Distance is computed in JS so we do not depend on SQLite math functions.
 *
 * @param {string} dbPath
 * @param {{ lat: number, lon: number }} origin
 * @param {{
 *   radiusMiles?: number | null,
 *   limit?: number,
 *   typeFilter?: { patterns: string[] } | null,
 * }} [options]
 */
export async function findOrganisationsNear(dbPath, origin, options = {}) {
  const radiusMiles = options.radiusMiles == null ? null : Number(options.radiusMiles)
  const limit = Math.min(500, Math.max(1, Number(options.limit) || DEFAULT_NEAR_LIMIT))
  const typeFilter = options.typeFilter || null

  const db = await openDatabase(dbPath)
  try {
    let sql = `
      SELECT org_name, org_main_type, primary_activity, specialisms, other_activities,
             county, local_authority, parish, postcode, hq_latitude, hq_longitude
      FROM orgs_llm
      WHERE hq_latitude IS NOT NULL AND hq_longitude IS NOT NULL
        AND TRIM(CAST(hq_latitude AS TEXT)) != ''
        AND TRIM(CAST(hq_longitude AS TEXT)) != ''`
    const params = []

    if (typeFilter?.patterns?.length) {
      const parts = []
      for (const pattern of typeFilter.patterns) {
        parts.push(`(
          IFNULL(org_main_type,'') LIKE ? OR
          IFNULL(primary_activity,'') LIKE ? OR
          IFNULL(specialisms,'') LIKE ? OR
          IFNULL(other_activities,'') LIKE ?
        )`)
        params.push(pattern, pattern, pattern, pattern)
      }
      sql += ` AND (${parts.join(' OR ')})`
    }

    const rows = await all(db, sql, params)
    const scored = []
    for (const row of rows) {
      const lat = Number(row.hq_latitude)
      const lon = Number(row.hq_longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      const distanceKm = haversineKm(origin.lat, origin.lon, lat, lon)
      const distanceMiles = kmToMiles(distanceKm)
      if (radiusMiles != null && distanceMiles > radiusMiles) continue
      scored.push({
        org_name: row.org_name,
        org_main_type: row.org_main_type,
        primary_activity: row.primary_activity,
        county: row.county,
        local_authority: row.local_authority,
        parish: row.parish,
        postcode: row.postcode,
        hq_latitude: lat,
        hq_longitude: lon,
        distance_km: distanceKm,
        distance_miles: distanceMiles,
      })
    }

    scored.sort((a, b) => a.distance_km - b.distance_km || String(a.org_name).localeCompare(String(b.org_name)))

    // Prefer distinct organisation names (directory can have duplicate rows).
    const seen = new Set()
    const unique = []
    for (const row of scored) {
      const key = String(row.org_name || '').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(row)
      if (unique.length >= limit) break
    }
    return unique
  } finally {
    await close(db)
  }
}

/**
 * Run a full proximity answer for a user question, or return null to fall through.
 *
 * @param {string} userQuery
 * @param {string} dbPath
 * @param {{ geocode?: typeof geocodePlace }} [deps]
 * @returns {Promise<{
 *   handled: true,
 *   answer: string,
 *   sqlQuery: string,
 *   rowCount: number,
 *   rows: object[],
 *   meta: object,
 * } | { handled: false }>}
 */
export async function tryAnswerProximityQuery(userQuery, dbPath, deps = {}) {
  const intent = parseProximityIntent(userQuery)
  if (!intent) return { handled: false }

  const geocode = deps.geocode || geocodePlace
  const geo = await geocode(intent.placeText)
  if (!geo) {
    return {
      handled: true,
      answer: `I could not resolve “${intent.placeText}” to a UK location, so I cannot run a distance search. Try a town, city, or postcode, or ask about organisations by local authority name (for example Wokingham).`,
      sqlQuery: `-- proximity: geocode failed for ${JSON.stringify(intent.placeText)}`,
      rowCount: 0,
      rows: [],
      meta: { intent, geo: null },
    }
  }

  const radiusMiles =
    intent.kind === 'near' ? intent.radiusMiles ?? DEFAULT_NEAR_RADIUS_MILES : null
  const limit = intent.kind === 'nearest' ? intent.limit : intent.limit

  const rows = await findOrganisationsNear(
    dbPath,
    { lat: geo.lat, lon: geo.lon },
    {
      radiusMiles,
      limit,
      typeFilter: intent.typeFilter,
    }
  )

  const sqlQuery = formatProximitySqlLog({
    kind: intent.kind,
    place: geo,
    radiusMiles,
    limit,
    typeFilter: intent.typeFilter,
  })

  const answer = formatProximityAnswer({
    userQuery,
    kind: intent.kind,
    placeLabel: geo.label,
    radiusMiles,
    typeFilter: intent.typeFilter,
    rows,
  })

  return {
    handled: true,
    answer,
    sqlQuery,
    rowCount: rows.length,
    rows,
    meta: { intent, geo, radiusMiles },
  }
}

/**
 * @param {object} opts
 */
function formatProximitySqlLog(opts) {
  const typeNote = opts.typeFilter ? ` type=${opts.typeFilter.id}` : ''
  if (opts.kind === 'nearest') {
    return `-- proximity nearest to ${opts.place.label} (${opts.place.lat.toFixed(5)},${opts.place.lon.toFixed(5)}) limit=${opts.limit}${typeNote} [haversine in application]`
  }
  return `-- proximity near ${opts.place.label} (${opts.place.lat.toFixed(5)},${opts.place.lon.toFixed(5)}) radius_miles=${opts.radiusMiles} limit=${opts.limit}${typeNote} [haversine in application]`
}

/**
 * @param {object} opts
 */
export function formatProximityAnswer(opts) {
  const {
    kind,
    placeLabel,
    radiusMiles,
    typeFilter,
    rows,
  } = opts
  const typeLabel = typeFilter?.label || 'organisations'
  // Plain language for end users. Rendered via marked in the chat UI, so use
  // Markdown lists (blank line + "- ") rather than single newlines or "•".
  const caveat =
    `Distances are as the crow flies from the centre of ${placeLabel} to each organisation’s headquarters and only include organisations listed in the Retrofit Directory.`

  if (!rows.length) {
    if (kind === 'nearest') {
      return `I could not find any ${typeLabel} in the Retrofit Directory with a mappable headquarters near ${placeLabel}.\n\n${caveat}`
    }
    return `I could not find any ${typeLabel} in the Retrofit Directory within about ${formatMiles(radiusMiles)} of ${placeLabel}.\n\n${caveat}`
  }

  if (kind === 'nearest') {
    if (rows.length === 1) {
      const r = rows[0]
      return (
        `The nearest ${typeFilter ? typeLabel.replace(/s$/, '') : 'organisation'} in the Retrofit Directory to ${placeLabel} is ${r.org_name}` +
        `${placeSuffix(r)}` +
        `, about ${formatMiles(r.distance_miles)} away.\n\n${caveat}`
      )
    }
    const lines = rows.map(
      (r, i) =>
        `${i + 1}. ${r.org_name}${placeSuffix(r)} — about ${formatMiles(r.distance_miles)}`
    )
    // Numbered list: blank line after intro so marked creates a proper <ol>.
    return [`The nearest ${typeLabel} in the Retrofit Directory to ${placeLabel} are:`, '', ...lines, '', caveat].join(
      '\n'
    )
  }

  // near list — Markdown bullets so the chat UI shows one org per line
  const lines = rows.map(
    (r) => `- ${r.org_name}${placeSuffix(r)} — about ${formatMiles(r.distance_miles)}`
  )
  const header =
    rows.length === 1
      ? `There is 1 ${typeFilter ? typeLabel.replace(/s$/, '') : 'organisation'} in the Retrofit Directory within about ${formatMiles(radiusMiles)} of ${placeLabel}:`
      : `There are ${rows.length} ${typeLabel} in the Retrofit Directory within about ${formatMiles(radiusMiles)} of ${placeLabel}:`
  return [header, '', ...lines, '', caveat].join('\n')
}

function placeSuffix(row) {
  const bits = [row.local_authority, row.parish, row.postcode].filter(
    (v) => v && String(v).trim() && !/unparished/i.test(String(v))
  )
  // Prefer LA + postcode
  const la = row.local_authority && String(row.local_authority).trim()
  const pc = row.postcode && String(row.postcode).trim()
  if (la && pc) return ` (${la}, ${pc})`
  if (la) return ` (${la})`
  if (pc) return ` (${pc})`
  if (bits[0]) return ` (${bits[0]})`
  return ''
}

function formatMiles(miles) {
  const n = Number(miles)
  if (!Number.isFinite(n)) return 'an unknown distance'
  if (n < 10) return `${n.toFixed(1)} miles`
  return `${Math.round(n)} miles`
}

export const _test = {
  cleanPlaceCapture,
  detectTypeFilter,
  parseRadiusMiles,
  TYPE_FILTERS,
  normalisePlaceKey,
  milesToKm,
}
