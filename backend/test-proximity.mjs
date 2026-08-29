/**
 * Offline unit tests for geocode.mjs + proximity.mjs (no Bedrock).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { geocodePlace, haversineKm, kmToMiles, normalisePlaceKey } from './geocode.mjs'
import {
  parseProximityIntent,
  tryAnswerProximityQuery,
  findOrganisationsNear,
  DEFAULT_NEAR_RADIUS_MILES,
} from './proximity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, 'directory.db')

let fail = 0
function check(label, cond) {
  if (cond) process.stdout.write(`PASS ${label}\n`)
  else {
    fail += 1
    process.stdout.write(`FAIL ${label}\n`)
  }
}

// --- parseProximityIntent ---
{
  const a = parseProximityIntent('List the organisations in and near Reading')
  check('near: in and near Reading', a?.kind === 'near' && a.placeText === 'Reading')
  check('near: default radius', a?.radiusMiles === DEFAULT_NEAR_RADIUS_MILES)

  const b = parseProximityIntent('which is the nearest installer to Guildford?')
  check('nearest installer place', b?.kind === 'nearest' && /guildford/i.test(b.placeText))
  check('nearest installer type', b?.typeFilter?.id === 'installer')

  const c = parseProximityIntent('organisations within 10 miles of Oxford')
  check('within 10 miles', c?.kind === 'near' && c.radiusMiles === 10 && c.placeText === 'Oxford')

  const d = parseProximityIntent('How many organisations are based in Wokingham?')
  check('exact in-place is not proximity', d === null)

  const e = parseProximityIntent('architects near Bath')
  check('near with type', e?.kind === 'near' && e.typeFilter?.id === 'architect' && e.placeText === 'Bath')
}

// --- geocode seed ---
{
  const g = await geocodePlace('Reading', { allowNetwork: false })
  check('gazetteer Reading', g?.source === 'gazetteer' && g.lat > 51 && g.lat < 52)
  const gf = await geocodePlace('Guildford', { allowNetwork: false })
  check('gazetteer Guildford', gf?.label === 'Guildford')
  check('normalise place key', normalisePlaceKey('  St. Albans ') === 'st albans')
}

// --- haversine sanity (Reading ↔ Wokingham ~7–8 miles) ---
{
  const km = haversineKm(51.4543, -0.9781, 51.4105, -0.8339)
  const mi = kmToMiles(km)
  check('Reading–Wokingham distance ballpark', mi > 5 && mi < 15)
}

// --- DB proximity (requires directory.db with hq coords) ---
{
  const reading = await geocodePlace('Reading', { allowNetwork: false })
  const near = await findOrganisationsNear(DB_PATH, reading, { radiusMiles: 25, limit: 10 })
  check('near Reading returns rows', near.length >= 1)
  check('near Reading sorted', near.length < 2 || near[0].distance_miles <= near[1].distance_miles)

  const wokinghamHit = near.some(
    (r) => /wokingham/i.test(r.local_authority || '') || /instagroup/i.test(r.org_name || '')
  )
  check('Wokingham org within 25mi of Reading', wokinghamHit)

  const full = await tryAnswerProximityQuery(
    'List the organisations in and near Reading',
    DB_PATH
  )
  check('tryAnswer near handled', full.handled === true && full.rowCount >= 1)
  check('tryAnswer mentions Reading', /Reading/i.test(full.answer))
  check('tryAnswer uses markdown bullets', /^\- /m.test(full.answer))
  check('tryAnswer has blank line before list', /:\n\n\- /.test(full.answer))
  check(
    'tryAnswer plain-language caveat',
    /as the crow flies from the centre of Reading/i.test(full.answer) &&
      !/centroid/i.test(full.answer) &&
      !/postcode/i.test(full.answer.split('Distances')[1] || '')
  )

  const nearest = await tryAnswerProximityQuery(
    'which is the nearest organisation to Guildford?',
    DB_PATH
  )
  check('tryAnswer nearest handled', nearest.handled === true && nearest.rowCount === 1)
  check('tryAnswer nearest has distance', /miles/i.test(nearest.answer))

  const fallthrough = await tryAnswerProximityQuery('How many organisations are in Bristol?', DB_PATH)
  check('non-proximity falls through', fallthrough.handled === false)
}

process.exit(fail)