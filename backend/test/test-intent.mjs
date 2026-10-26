/**
 * Offline unit tests for homeowner journey routing helpers in query.mjs.
 *
 * Usage:
 *   cd backend
 *   node test/test-intent.mjs
 *
 * Exit code: number of failed assertions (0 = all pass).
 *
 * @license MIT
 * Copyright (c) 2025–2026 Nigel Gilbert and contributors
 * University of Surrey — INHABIT / National Retrofit Hub
 */

import {
  classifyQueryIntentHeuristic,
  isHomeownerJourneyQuery,
  extractPlaceHint,
  enrichPolicySearchQuery,
} from '../query.mjs'

let fail = 0

/**
 * @param {string} label
 * @param {unknown} cond
 */
function check(label, cond) {
  if (cond) process.stdout.write(`PASS ${label}\n`)
  else {
    fail += 1
    process.stdout.write(`FAIL ${label}\n`)
  }
}

// --- isHomeownerJourneyQuery ---
{
  check(
    'journey: Woodside Park how-to',
    isHomeownerJourneyQuery(
      "I'm considering retrofitting my house in Woodside Park. How do I do this?"
    )
  )
  check(
    'journey: start retrofitting my home',
    isHomeownerJourneyQuery('How do I start retrofitting my home?')
  )
  check(
    'journey: make home warmer',
    isHomeownerJourneyQuery('How can I make my home warmer and more energy efficient?')
  )
  check(
    'not journey: org count',
    !isHomeownerJourneyQuery('How many organisations are located in Bristol?')
  )
  check('not journey: weather', !isHomeownerJourneyQuery('What is the weather in London?'))
  check('not journey: how do I cook', !isHomeownerJourneyQuery('How do I cook pasta?'))
}

// --- extractPlaceHint ---
{
  check(
    'place: Woodside Park from house-in',
    extractPlaceHint(
      "I'm considering retrofitting my house in Woodside Park. How do I do this?"
    ) === 'Woodside Park'
  )
  check(
    'place: rejects England',
    extractPlaceHint('What grants might help in England?') === null
  )
  check(
    'place: rejects UK',
    extractPlaceHint('How do I retrofit my house in the UK?') === null
  )
  check(
    'place: none on plain start question',
    extractPlaceHint('How do I start retrofitting my home?') === null
  )
  check(
    'place: Barnet',
    extractPlaceHint('How do I retrofit my home in Barnet?') === 'Barnet'
  )
}

// --- classifyQueryIntentHeuristic ---
{
  check(
    'heuristic policy: Woodside Park how-to',
    classifyQueryIntentHeuristic(
      "I'm considering retrofitting my house in Woodside Park. How do I do this?"
    ) === 'policy'
  )
  check(
    'heuristic policy: start retrofitting',
    classifyQueryIntentHeuristic('How do I start retrofitting my home?') === 'policy'
  )
  check(
    'heuristic policy: grants England',
    classifyQueryIntentHeuristic('What grants might help in England?') === 'policy'
  )
  check(
    'heuristic policy: PAS2035',
    classifyQueryIntentHeuristic('What is PAS2035?') === 'policy'
  )
  check(
    'heuristic directory: Bristol count',
    classifyQueryIntentHeuristic('How many organisations are located in Bristol?') ===
      'directory'
  )
  check(
    'heuristic directory: architect near',
    classifyQueryIntentHeuristic('Is there an architect near Portsmouth?') === 'directory'
  )
  check(
    'heuristic out_of_scope: weather',
    classifyQueryIntentHeuristic('What is the weather in Manchester?') === 'out_of_scope'
  )
  check(
    'heuristic out_of_scope: joke',
    classifyQueryIntentHeuristic('Tell me a joke') === 'out_of_scope'
  )
}

// --- enrichPolicySearchQuery ---
{
  const enriched = enrichPolicySearchQuery('How do I start retrofitting my home?')
  check('enrich adds focus block', /Search focus: homeowner/.test(enriched))
  check('enrich keeps original question', enriched.startsWith('How do I start'))
  check(
    'enrich is no-op for non-journey',
    enrichPolicySearchQuery('What is ECO4?') === 'What is ECO4?'
  )
}

process.exit(fail)
