import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve UK place names to WGS84 centroids for proximity search.
 *
 * Order: in-memory seed gazetteer → on-disk cache → postcodes.io places/outcodes.
 * Production does not need ONSPD; org HQ coords already live in directory.db.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GEO_DIR = path.join(__dirname, 'geo')
const CACHE_PATH = path.join(GEO_DIR, 'geocode-cache.json')
const POSTCODES_IO_BASE = 'https://api.postcodes.io'
const FETCH_TIMEOUT_MS = 8_000

/** Preferred OS local_type ranking (higher = better). */
const LOCAL_TYPE_SCORE = {
  city: 100,
  town: 90,
  'london borough': 85,
  'unitary authority': 80,
  'metropolitan district': 75,
  'non-metropolitan district': 70,
  'suburban area': 50,
  village: 40,
  hamlet: 10,
  'other settlement': 20,
}

/**
 * Offline seed of common UK places (approx town/city centroids).
 * Keys are normalised (lowercase, stripped punctuation).
 * Enough to answer near/nearest without a network hop for frequent queries.
 */
const SEED_GAZETTEER = {
  reading: { lat: 51.4543, lon: -0.9781, label: 'Reading' },
  guildford: { lat: 51.2362, lon: -0.5704, label: 'Guildford' },
  wokingham: { lat: 51.4105, lon: -0.8339, label: 'Wokingham' },
  london: { lat: 51.5074, lon: -0.1278, label: 'London' },
  manchester: { lat: 53.4808, lon: -2.2426, label: 'Manchester' },
  birmingham: { lat: 52.4862, lon: -1.8904, label: 'Birmingham' },
  leeds: { lat: 53.8008, lon: -1.5491, label: 'Leeds' },
  bristol: { lat: 51.4545, lon: -2.5879, label: 'Bristol' },
  glasgow: { lat: 55.8642, lon: -4.2518, label: 'Glasgow' },
  edinburgh: { lat: 55.9533, lon: -3.1883, label: 'Edinburgh' },
  cardiff: { lat: 51.4816, lon: -3.1791, label: 'Cardiff' },
  belfast: { lat: 54.5973, lon: -5.9301, label: 'Belfast' },
  oxford: { lat: 51.752, lon: -1.2577, label: 'Oxford' },
  cambridge: { lat: 52.2053, lon: 0.1218, label: 'Cambridge' },
  southampton: { lat: 50.9097, lon: -1.4044, label: 'Southampton' },
  portsmouth: { lat: 50.8198, lon: -1.088, label: 'Portsmouth' },
  brighton: { lat: 50.8225, lon: -0.1372, label: 'Brighton' },
  'brighton and hove': { lat: 50.8225, lon: -0.1372, label: 'Brighton and Hove' },
  sheffield: { lat: 53.3811, lon: -1.4701, label: 'Sheffield' },
  newcastle: { lat: 54.9783, lon: -1.6178, label: 'Newcastle upon Tyne' },
  'newcastle upon tyne': { lat: 54.9783, lon: -1.6178, label: 'Newcastle upon Tyne' },
  liverpool: { lat: 53.4084, lon: -2.9916, label: 'Liverpool' },
  nottingham: { lat: 52.9548, lon: -1.1581, label: 'Nottingham' },
  leicester: { lat: 52.6369, lon: -1.1398, label: 'Leicester' },
  coventry: { lat: 52.4068, lon: -1.5197, label: 'Coventry' },
  plymouth: { lat: 50.3755, lon: -4.1427, label: 'Plymouth' },
  exeter: { lat: 50.7184, lon: -3.5339, label: 'Exeter' },
  bath: { lat: 51.3811, lon: -2.359, label: 'Bath' },
  york: { lat: 53.96, lon: -1.0873, label: 'York' },
  norwich: { lat: 52.6309, lon: 1.2974, label: 'Norwich' },
  ipswich: { lat: 52.0567, lon: 1.1482, label: 'Ipswich' },
  canterbury: { lat: 51.2802, lon: 1.0789, label: 'Canterbury' },
  maidstone: { lat: 51.2704, lon: 0.5227, label: 'Maidstone' },
  swindon: { lat: 51.5558, lon: -1.7797, label: 'Swindon' },
  slough: { lat: 51.5105, lon: -0.595, label: 'Slough' },
  windsor: { lat: 51.483, lon: -0.6042, label: 'Windsor' },
  basingstoke: { lat: 51.2667, lon: -1.0876, label: 'Basingstoke' },
  winchester: { lat: 51.0632, lon: -1.308, label: 'Winchester' },
  'milton keynes': { lat: 52.0406, lon: -0.7594, label: 'Milton Keynes' },
  luton: { lat: 51.8787, lon: -0.42, label: 'Luton' },
  watford: { lat: 51.6565, lon: -0.3903, label: 'Watford' },
  croydon: { lat: 51.3762, lon: -0.0982, label: 'Croydon' },
  ealing: { lat: 51.513, lon: -0.3089, label: 'Ealing' },
  derby: { lat: 52.9225, lon: -1.4746, label: 'Derby' },
  chester: { lat: 53.1934, lon: -2.8931, label: 'Chester' },
  shrewsbury: { lat: 52.7073, lon: -2.7541, label: 'Shrewsbury' },
  cornwall: { lat: 50.266, lon: -5.0527, label: 'Cornwall' },
  devon: { lat: 50.7156, lon: -3.5309, label: 'Devon' },
  kent: { lat: 51.2787, lon: 0.5217, label: 'Kent' },
  surrey: { lat: 51.3148, lon: -0.56, label: 'Surrey' },
  hampshire: { lat: 51.0577, lon: -1.3081, label: 'Hampshire' },
  berkshire: { lat: 51.45, lon: -1.0, label: 'Berkshire' },
  'isle of wight': { lat: 50.6938, lon: -1.3047, label: 'Isle of Wight' },
  ventnor: { lat: 50.594, lon: -1.206, label: 'Ventnor' },
  niton: { lat: 50.587, lon: -1.285, label: 'Niton' },
  bognor: { lat: 50.7826, lon: -0.6764, label: 'Bognor Regis' },
  'bognor regis': { lat: 50.7826, lon: -0.6764, label: 'Bognor Regis' },
  arun: { lat: 50.82, lon: -0.55, label: 'Arun' },
  bersted: { lat: 50.8015, lon: -0.674, label: 'Bersted' },
}

/** @type {Map<string, object> | null} */
let diskCache = null

/**
 * @param {string} value
 * @returns {string}
 */
export function normalisePlaceKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @returns {Map<string, object>}
 */
function loadDiskCache() {
  if (diskCache) return diskCache
  diskCache = new Map()
  try {
    if (!fs.existsSync(CACHE_PATH)) return diskCache
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        if (value && typeof value.lat === 'number' && typeof value.lon === 'number') {
          diskCache.set(key, value)
        }
      }
    }
  } catch {
    diskCache = new Map()
  }
  return diskCache
}

/**
 * @param {string} key
 * @param {object} entry
 */
function persistCacheEntry(key, entry) {
  const cache = loadDiskCache()
  cache.set(key, entry)
  try {
    fs.mkdirSync(GEO_DIR, { recursive: true })
    const obj = Object.fromEntries(cache.entries())
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2), 'utf8')
  } catch {
    // Cache write failures must not break queries.
  }
}

/**
 * @param {string} url
 * @returns {Promise<any | null>}
 */
async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Score a postcodes.io place row for a normalised query key.
 * @param {object} place
 * @param {string} key
 * @returns {number}
 */
function scorePlaceResult(place, key) {
  const name = normalisePlaceKey(place.name_1 || place.name || '')
  if (!name) return -1
  let score = 0
  if (name === key) score += 200
  else if (name.startsWith(key + ' ')) score += 80
  else if (name.includes(key)) score += 40
  else return -1

  const localType = String(place.local_type || '').toLowerCase()
  score += LOCAL_TYPE_SCORE[localType] || 15

  const country = String(place.country || '').toLowerCase()
  if (country === 'england') score += 5
  if (country === 'scotland' || country === 'wales' || country === 'northern ireland') score += 3

  // Prefer denser settlement types over rural namesakes.
  if (localType === 'hamlet' || localType === 'other settlement') score -= 30

  return score
}

/**
 * @param {object} place
 * @param {string} source
 * @returns {{ lat: number, lon: number, label: string, source: string } | null}
 */
function toGeoResult(place, source) {
  const lat = Number(place.latitude)
  const lon = Number(place.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < 49 || lat > 61 || lon < -9 || lon > 2) return null
  const label = String(place.name_1 || place.name || place.label || '').trim() || 'Unknown place'
  return { lat, lon, label, source }
}

/**
 * @param {string} placeName
 * @returns {Promise<{ lat: number, lon: number, label: string, source: string } | null>}
 */
async function geocodeViaPostcodesIo(placeName) {
  const key = normalisePlaceKey(placeName)
  if (!key) return null

  // Full postcode?
  const compact = key.replace(/\s+/g, '')
  if (/^[a-z]{1,2}\d[a-z\d]?\d[a-z]{2}$/i.test(compact)) {
    const spaced =
      compact.length >= 5 ? `${compact.slice(0, -3)} ${compact.slice(-3)}`.toUpperCase() : compact.toUpperCase()
    const data = await fetchJson(`${POSTCODES_IO_BASE}/postcodes/${encodeURIComponent(spaced)}`)
    if (data?.status === 200 && data.result) {
      return toGeoResult(
        {
          latitude: data.result.latitude,
          longitude: data.result.longitude,
          name_1: data.result.postcode,
        },
        'postcodes.io/postcode'
      )
    }
  }

  // Outcode only (e.g. RG1)?
  if (/^[a-z]{1,2}\d[a-z\d]?$/i.test(compact)) {
    const data = await fetchJson(`${POSTCODES_IO_BASE}/outcodes/${encodeURIComponent(compact.toUpperCase())}`)
    if (data?.status === 200 && data.result) {
      return toGeoResult(
        {
          latitude: data.result.latitude,
          longitude: data.result.longitude,
          name_1: data.result.outcode,
        },
        'postcodes.io/outcode'
      )
    }
  }

  const data = await fetchJson(
    `${POSTCODES_IO_BASE}/places?q=${encodeURIComponent(placeName.trim())}&limit=20`
  )
  const rows = Array.isArray(data?.result) ? data.result : []
  let best = null
  let bestScore = -1
  for (const row of rows) {
    const score = scorePlaceResult(row, key)
    if (score > bestScore) {
      bestScore = score
      best = row
    }
  }
  if (!best || bestScore < 0) return null
  return toGeoResult(best, 'postcodes.io/places')
}

/**
 * Geocode a UK place name to a WGS84 point.
 * @param {string} placeName
 * @param {{ allowNetwork?: boolean }} [options]
 * @returns {Promise<{ lat: number, lon: number, label: string, source: string } | null>}
 */
export async function geocodePlace(placeName, options = {}) {
  const allowNetwork = options.allowNetwork !== false
  const key = normalisePlaceKey(placeName)
  if (!key || key.length < 2) return null

  const seed = SEED_GAZETTEER[key]
  if (seed) {
    return { lat: seed.lat, lon: seed.lon, label: seed.label, source: 'gazetteer' }
  }

  const cache = loadDiskCache()
  const cached = cache.get(key)
  if (cached && typeof cached.lat === 'number' && typeof cached.lon === 'number') {
    return {
      lat: cached.lat,
      lon: cached.lon,
      label: cached.label || placeName,
      source: cached.source || 'cache',
    }
  }

  if (!allowNetwork) return null

  const remote = await geocodeViaPostcodesIo(placeName)
  if (!remote) return null

  persistCacheEntry(key, {
    lat: remote.lat,
    lon: remote.lon,
    label: remote.label,
    source: remote.source,
    cachedAt: new Date().toISOString(),
  })
  return remote
}

/**
 * Haversine distance in kilometres.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const r = 6371
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function kmToMiles(km) {
  return km * 0.621371
}

export function milesToKm(miles) {
  return miles / 0.621371
}

/** @internal test helpers */
export const _test = {
  SEED_GAZETTEER,
  scorePlaceResult,
  CACHE_PATH,
  loadDiskCache,
  resetCacheForTests() {
    diskCache = null
  },
}
