/**
 * Offline unit tests for `geocode.mjs` and `proximity.mjs` (no Bedrock).
 *
 * Covers intent parsing, seed gazetteer geocoding, haversine distances,
 * near/nearest answers against directory.db, and “near me” location prompts.
 * Requires a local `directory.db` with HQ coordinates for the DB cases.
 *
 * Usage:
 *   cd backend
 *   node test/test-proximity.mjs
 *
 * Exit code: number of failed assertions (0 = all pass).
 *
 * @license MIT
 * Copyright (c) 2025–2026 Nigel Gilbert and contributors
 * University of Surrey — INHABIT / National Retrofit Hub
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { geocodePlace, haversineKm, kmToMiles, normalisePlaceKey } from '../lib/geocode.mjs'
import {
  parseProximityIntent,
  tryAnswerProximityQuery,
  findOrganisationsNear,
  isUnspecifiedUserLocation,
  DEFAULT_NEAR_RADIUS_MILES,
} from '../lib/proximity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'directory.db')

let fail = 0
/**
 * Assert a named condition; prints PASS/FAIL and tallies failures.
 * @param {string} label
 * @param {unknown} cond
 * @returns {void}
 */
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

  const nearMe = parseProximityIntent('Is there an architect near me')
  check(
    'near me parses place me',
    nearMe?.kind === 'near' && nearMe.placeText === 'me' && nearMe.typeFilter?.id === 'architect'
  )
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

  const nearMeAnswer = await tryAnswerProximityQuery('Is there an architect near me', DB_PATH)
  check('near me is handled', nearMeAnswer.handled === true)
  check('near me asks for location', /postcode|town or city/i.test(nearMeAnswer.answer))
  check('near me does not invent Pity Me', !/pity me/i.test(nearMeAnswer.answer))
  check('near me meta needsLocation', nearMeAnswer.meta?.needsLocation === true)
  check('isUnspecifiedUserLocation me', isUnspecifiedUserLocation('me'))
  check('isUnspecifiedUserLocation here', isUnspecifiedUserLocation('here'))
  check('isUnspecifiedUserLocation Reading false', !isUnspecifiedUserLocation('Reading'))

  const geoMe = await geocodePlace('me')
  check('geocode me rejects', geoMe === null)
}

process.exit(fail)