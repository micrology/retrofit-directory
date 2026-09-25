/**
 * HTTP query server for the Retrofit Directory.
 *
 * Express app bound to 127.0.0.1 (default port 5001). Routes each question to
 * directory (text-to-SQL + SQLite), policy (Bedrock Knowledge Base), proximity
 * search, or out-of-scope. Enforces input limits, SQL guardrails, rate limits,
 * admin auth for `/api/observe`, and usage logging to `usage.db`.
 *
 * Endpoints:
 *   POST /api/query    — public chat (also proxied as /retrofit/query)
 *   POST /api/observe  — admin usage summary (Bearer ADMIN_PASSWORD)
 *
 * Usage (development):
 *   cd backend
 *   VERBOSE=1 ADMIN_PASSWORD=secret node query.mjs
 *
 * Usage (production):
 *   systemd unit backend/retrofit-query-server.service
 *   (Environment=ADMIN_PASSWORD=…, optional DAILY_TOKEN_BUDGET, VERBOSE, PORT)
 *
 * Environment:
 *   PORT                 Listen port (default 5001)
 *   ADMIN_PASSWORD       Required for /api/observe (503 if unset)
 *   DAILY_TOKEN_BUDGET   UTC-day Bedrock token cap (default 200000; 0 disables)
 *   VERBOSE              1/true/yes enables detailed request/SQL logs
 *
 * Requires: directory.db, directory.schema, AWS credentials for Bedrock in eu-west-2.
 *
 * @license MIT
 * Copyright (c) 2025–2026 Nigel Gilbert and contributors
 * University of Surrey — INHABIT / National Retrofit Hub
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'
import sqlite3 from 'sqlite3'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime'
import express from 'express'
import cors from 'cors'
import { createHttpTerminator } from 'http-terminator'
import rateLimit from 'express-rate-limit'
import {
  initUsageStore,
  withUsageCapture,
  recordModelCall,
  saveRequestLog,
  getUsageSummary,
  getTodayTokenTotal,
} from './lib/usage.mjs'
import { tryAnswerProximityQuery } from './lib/proximity.mjs'

/** Verbose request logging. Off by default; set VERBOSE=1 (or true) to enable. */
const VERBOSE = /^(1|true|yes)$/i.test(String(process.env.VERBOSE || ''))
const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'directory.db')
const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'directory.schema')
const CANONICAL_SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'directory.schema.canonical'
)
const BEDROCK_REGION = 'eu-west-2'
const BEDROCK_MODEL_ID = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'
const CHEAP_MODEL_ID = 'qwen.qwen3-235b-a22b-2507-v1:0'
/** Unstructured policy corpus (S3-backed Bedrock Knowledge Base). */
const KNOWLEDGE_BASE_ID = 'U8L4ZLT14K'
/**
 * Model ARN/id passed to RetrieveAndGenerate. Cross-region inference profile
 * ids (eu.anthropic...) are accepted as the modelArn value in recent Agents Runtime APIs.
 */
const KB_GENERATION_MODEL_ARN = BEDROCK_MODEL_ID
const SQL_MAX_TOKENS = 300
const ANSWER_MAX_TOKENS = 2000
const REFORMULATE_MAX_TOKENS = 120
const ROUTE_MAX_TOKENS = 20
const MAX_HISTORY_TURNS = 3 // number of previous turns kept for context in query reformulation
const MAX_QUERY_LENGTH = 500
const MAX_QUERY_LENGTH_WITH_CONTEXT = 1000
const LONG_LIST_THRESHOLD = 25
/** Hard cap on rows returned from directory SQL (defence against huge dumps). */
const MAX_SQL_RESULT_ROWS = 500
/**
 * Global Bedrock budget: sum of input+output tokens logged today (UTC).
 * Override with DAILY_TOKEN_BUDGET. Requests are rejected with 429 once exceeded.
 */
const DAILY_TOKEN_BUDGET = Math.max(
  0,
  Number(process.env.DAILY_TOKEN_BUDGET) || 200_000
)
const VALID_INTENTS = new Set(['directory', 'policy', 'out_of_scope'])
/**
 * Keywords that must never appear in LLM SQL (word-boundary match after comment strip).
 * REPLACE is matched only as a statement form so REPLACE() expressions remain valid.
 */
const FORBIDDEN_SQL_KEYWORD =
  /\b(?:ATTACH|DETACH|DROP|INSERT|UPDATE|DELETE|ALTER|CREATE|REINDEX|VACUUM|PRAGMA|ANALYZE|GRANT|REVOKE|TRUNCATE|MERGE|CALL|EXEC(?:UTE)?|LOAD_EXTENSION|INTO)\b/i
const FORBIDDEN_SQL_REPLACE_STMT = /\bREPLACE\s+(?:OR\s+\w+\s+)?(?:INTO\b|\w+)/i
// Keep aligned with backend/lib/orgsLlmView.mjs CANONICAL_LLM_COLUMNS (subset used for SQL rewrites).
const CANONICAL_LLM_COLUMNS = [
  'org_name',
  'department_or_unit',
  'org_main_type',
  'org_type_other_public',
  'org_type_other_private',
  'org_type_other_nonprofit',
  'county',
  'postcode',
  'local_authority',
  'parish',
  'hq_latitude',
  'hq_longitude',
  'geographic_scope',
  'countries',
  'operating_areas',
  'operating_areas_other',
  'main_mission_or_remit',
  'retrofit_relevance',
  'primary_activity',
  'primary_activity_other',
  'other_activities',
  'other_activities_other',
  'specialisms',
  'specialisms_other',
  'methods_or_skills',
  'methods_or_skills_other',
  'works_with_fuel_poverty',
  'works_with_health_housing',
  'works_with_inequalities',
  'works_with_tenants_associations',
  'works_with_community_groups',
  'works_with_general_public',
  'works_with_local_authorities',
  'works_with_central_government',
  'works_with_regulators',
  'works_with_funders',
  'works_with_social_housing',
  'works_with_housing_associations',
  'works_with_private_housing',
  'works_with_developers_installers',
  'works_with_product_suppliers',
  'works_with_architects',
  'works_with_building_managers',
  'works_with_researchers',
  'works_with_network_convenors',
  'works_with_consultants',
  'works_with_other_audiences',
  'works_with_other_audiences_text',
  'schemes_delivered',
  'schemes_la_finance_detail',
  'schemes_other_detail',
  'website',
  'contact_email',
  'employee_count_band',
]
const OUT_OF_SCOPE_RESPONSE =
  'I can answer questions about organisations in the Retrofit Directory (locations, activities, specialisms, types, and contacts) and about UK retrofit policy, regulations, and guidance from the uploaded policy documents. Please ask about one of those topics.'
const POLICY_NO_HIT_RESPONSE =
  'I could not find relevant information in the retrofit policy documents for that question. Try rephrasing, or ask about a specific scheme, strategy, or regulation (for example ECO, Green Deal, fuel poverty, or heat and buildings policy).'

class UnsafeSqlError extends Error {
  /**
   * @param {string} sqlSnippet
   */
  constructor(sqlSnippet) {
    super(`Unsafe or unexpected SQL generated: ${sqlSnippet}`)
    this.name = 'UnsafeSqlError'
  }
}

class DailyTokenBudgetError extends Error {
  constructor(used, budget) {
    super(
      `Daily Bedrock token budget exceeded (${used.toLocaleString('en-GB')} / ${budget.toLocaleString('en-GB')} tokens UTC day).`
    )
    this.name = 'DailyTokenBudgetError'
    this.used = used
    this.budget = budget
  }
}

process.title = 'retrofit-query-server'

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION })
const bedrockAgent = new BedrockAgentRuntimeClient({ region: BEDROCK_REGION })

const app = express()
const PORT = process.env.PORT || 5001
/** Required for POST /api/observe. Set via environment (systemd Environment= or shell). */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

app.set('trust proxy', 1) // trust first proxy, if behind a proxy
app.use(
  cors({
    origin: [
      'https://retrofit-directory.org.uk',
      'https://www.retrofit-directory.org.uk',
      'http://localhost',
      'http://127.0.0.1',
    ],
  })
)
app.use(express.json({ limit: '8kb' }))

const queryLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 20, // max 20 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
})
app.use('/api/query', queryLimiter)

const observeLimiter = rateLimit({
  windowMs: 60_000,
  max: 30, // admin dashboard refresh + unlock attempts
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
})
app.use('/api/observe', observeLimiter)

let server // server instance
let httpTerminator // terminator instance
/**
 * Start the local Express HTTP server and attach a terminator for graceful shutdown.
 * @returns {Promise<void>}
 */
async function start() {
  // Create/open usage.db up front so a misconfigured path fails loudly at boot
  // rather than silently on the first query.
  await initUsageStore()

  // Start the server
  server = app.listen(PORT, '127.0.0.1', () => {
    console.log(
      `Proxy server running on http://localhost:${PORT}, using models ${BEDROCK_MODEL_ID} and ${CHEAP_MODEL_ID} in ${BEDROCK_REGION}; knowledge base ${KNOWLEDGE_BASE_ID}`
    )
  })
  httpTerminator = createHttpTerminator({ server })
}

// Allow `import` from offline unit tests without binding a port.
const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMainModule) {
  start()
}

/**
 * Open the SQLite database in read-only mode for query execution.
 * @param {string} dbPath
 * @returns {Promise<sqlite3.Database>}
 */
function openDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve(db)
    })
  })
}

/**
 * Promise-based wrapper around sqlite3 `db.all`.
 * @param {sqlite3.Database} db
 * @param {string} sql
 * @param {unknown[]} [params=[]]
 * @returns {Promise<any[]>}
 */
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
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
 * Read a persisted plain-text schema used in SQL-generation prompts.
 * @param {'canonical' | 'full'} [mode='canonical']
 *   canonical — orgs_llm only (default text-to-SQL path)
 *   full — raw orgs + orgs_llm (SQL repair / fallback when canonical file missing)
 * @returns {string}
 */
function readSchema(mode = 'canonical') {
  const preferCanonical = mode === 'canonical'
  const primaryPath = preferCanonical ? CANONICAL_SCHEMA_PATH : SCHEMA_PATH
  const fallbackPath = preferCanonical ? SCHEMA_PATH : CANONICAL_SCHEMA_PATH

  try {
    return fs.readFileSync(primaryPath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        const fallback = fs.readFileSync(fallbackPath, 'utf8')
        logAPICalls(
          `Schema file missing at ${primaryPath}; falling back to ${fallbackPath}`
        )
        return fallback
      } catch (fallbackErr) {
        console.error(
          `Error: schema file not found at ${primaryPath} or ${fallbackPath}. ` +
            `Run csvToDB.mjs or rebuild-orgs-llm.mjs first.`
        )
        throw fallbackErr
      }
    }
    console.error(`Error reading schema file at ${primaryPath}:`, err.message)
    throw err
  }
}

/**
 * Invoke a Bedrock model with a single user prompt via the Converse API.
 *
 * Converse normalises the request/response shape across model families, so the
 * same helper works for both the Anthropic and Qwen models configured above.
 * @param {string} prompt
 * @param {number} temperature
 * @param {number} maxTokens
 * @param {{ modelId?: string, stage?: string }} [options] `stage` labels the
 *   call in the usage log (e.g. "sql", "answer") for per-stage cost attribution.
 * @returns {Promise<string>}
 */
async function invokeBedrock(prompt, temperature, maxTokens, options = {}) {
  const { modelId = BEDROCK_MODEL_ID, stage = 'unknown' } = options
  const response = await bedrock.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens, temperature },
    })
  )

  const { inputTokens, outputTokens } = response.usage ?? {}
  recordModelCall({ stage, modelId, inputTokens, outputTokens })
  logAPICalls(
    `Bedrock ${modelId} (${stage}): ${inputTokens} input tokens, ${outputTokens} output tokens`
  )

  // Concatenate text blocks and ignore any non-text blocks (e.g. reasoning content).
  /**
   * Concatenate text fragments from a Bedrock content block list.
   * @param {Array<{ text?: string }>} content
   * @returns {string}
   */
  const text = (response.output?.message?.content ?? [])
    .map((block) => block?.text ?? '')
    .join('')
    .trim()

  if (!text) {
    throw new Error(
      `Empty response from Bedrock model ${modelId} (stopReason: ${response.stopReason})`
    )
  }
  return text
}

/**
 * Convert a natural-language user question into a SQL SELECT statement.
 * @param {string} userQuery
 * @returns {Promise<string>}
 */
export async function generateSqlFromQuery(userQuery) {
  // Default path: canonical orgs_llm-only schema (smaller prompt, lower latency).
  const schema = readSchema('canonical')

  const prompt = `You are an expert SQLite data analyst. Your job is to convert a user's natural language question into a valid, safe SQLite SELECT query based on the provided schema.

    The schema describes the canonical view orgs_llm only. Column annotations show how many rows are populated plus example values.

    Rules:
    - Return ONLY the raw SQL query. Do not include markdown formatting (like \`\`\`sql), code blocks, or explanatory text.
    - Only use SELECT statements. Never generate INSERT, UPDATE, DELETE, or DROP statements.
    - Always query FROM orgs_llm. Do not reference a table named orgs.
    - Use only column names listed in the schema. Do not invent columns.
    - Use case-insensitive matching where appropriate (e.g., LIKE '%Manchester%') for text filters.
    - For list-style outputs (especially organisation names), use DISTINCT unless duplicates are explicitly requested.
    - The Directory contains duplicate entries: the same organisation can appear in more than one row. When the user asks to count organisations, count DISTINCT identities with COUNT(DISTINCT org_name) rather than COUNT(*), so each organisation is counted only once. Reserve COUNT(*) for counting raw rows/entries rather than distinct organisations.
    - Never select or filter on columns marked [EMPTY - no data].
    - Use the example values to map the user's terms to the correct column and its stored values. For works_with_* audience columns, a populated cell is usually 'Directly' or 'Indirectly'; filter with col IS NOT NULL AND TRIM(col) != '' rather than assuming 'Yes'.
    - Disambiguation: if the user asks whether an organisation IS a type (architect, engineer, local authority), use org_main_type (and org_type_other_* free text when helpful). Use works_with_* only when asking who the organisation works with / serves.
    - "Community-led" / community groups: prefer specialisms, main_mission_or_remit, other_activities, and/or works_with_community_groups as appropriate.
    - Scheme delivery questions (Green Homes Grant, HUGS, etc.): use schemes_delivered and schemes_*_detail.
    - Place / location questions ("in Wokingham", "based in Manchester", "how many in Kent"): filter with case-insensitive LIKE against local_authority, parish, county, and/or operating_areas as appropriate. Prefer local_authority for towns and districts; county for ceremonial/historic counties; operating_areas for nations/regions such as London/Scotland/Wales. OR across place columns when a single place name might appear in more than one field. Do not invent postcode prefixes.
    - Do NOT write Haversine/distance SQL for "near", "nearest", "within N miles", or "closest to" questions — those are handled outside text-to-SQL. If you somehow receive one, fall back to local_authority/parish/county/operating_areas text filters only.
    - hq_latitude/hq_longitude are HQ postcode centroids (ONSPD), not survey IP location.

    Schema:
    ${schema}

    User Question: "${userQuery}"
    SQL Query:`

  return invokeBedrock(prompt, 0.0, SQL_MAX_TOKENS, { stage: 'sql' })
}

/**
 * Regenerate SQL using the previous SQL and SQLite error as corrective context.
 * @param {string} userQuery
 * @param {string} previousSql
 * @param {string} sqliteError
 * @returns {Promise<string>}
 */
export async function regenerateSqlFromError(userQuery, previousSql, sqliteError) {
  // Repair may need the full raw+canonical schema when the first pass missed a column.
  const schema = readSchema('full')

  const prompt = `You are fixing a failed SQLite SELECT query.

    Return ONLY a corrected raw SQL SELECT query.

    Rules:
    - Only use SELECT statements. Never generate INSERT, UPDATE, DELETE, DROP, ALTER, or PRAGMA.
    - Prefer the canonical view orgs_llm and its short alias columns whenever they can answer the question.
    - If and only if orgs_llm cannot express the filter, you may use long raw column names on table orgs from the full schema.
    - If you reference canonical alias columns (e.g. org_name, org_main_type, county, works_with_community_groups), query FROM orgs_llm (not orgs).
    - For list-style outputs (especially organisation names), use DISTINCT unless duplicates are explicitly requested.
    - The Directory contains duplicate entries: when counting organisations, use COUNT(DISTINCT org_name) rather than COUNT(*).
    - For place filters, use local_authority / parish / county / operating_areas (LIKE), not invented postcode districts.
    - Never select or filter on columns marked [EMPTY - no data].
    - Keep the corrected query semantically faithful to the original user question.

    Schema:
    ${schema}

    User Question: "${userQuery}"
    Previous SQL (failed): "${previousSql}"
    SQLite Error: "${sqliteError}"

    Corrected SQL Query:`

  return invokeBedrock(prompt, 0.0, SQL_MAX_TOKENS, { stage: 'repair' })
}

/**
 * Execute SQL against the SQLite directory and return column names plus row values.
 * Column names enable zero-LLM formatting of multi-field organisation profiles.
 * @param {string} sqlQuery
 * @returns {Promise<{ columns: string[], rows: any[][] }>}
 */
export async function queryDatabase(sqlQuery) {
  const db = await openDatabase(DB_PATH)

  try {
    const rows = await all(db, sqlQuery)
    const limited = rows.length > MAX_SQL_RESULT_ROWS ? rows.slice(0, MAX_SQL_RESULT_ROWS) : rows
    if (limited.length === 0) return { columns: [], rows: [] }
    const columns = Object.keys(limited[0])
    return {
      columns,
      rows: limited.map((row) => columns.map((column) => row[column])),
    }
  } finally {
    await close(db)
  }
}

/**
 * Turn raw SQL result rows into a concise natural-language answer.
 * @param {string} userQuery
 * @param {string} sqlQuery
 * @param {any[][]} rawResults
 * @returns {Promise<string>}
 */
export async function generateNaturalLanguageAnswer(userQuery, sqlQuery, rawResults) {
  const prompt = `You are a helpful assistant for a public retrofit organisation database. 
    A user asked a question, a SQL query was run against the database, and raw results were returned.
    Your job is to write a clear, concise, and natural language response answering the user's question based on the data provided.

    Rules:
    - Be polite and conversational.
    - If the result is a count (e.g., a number), state it clearly (e.g., "There are 4 organisations...").
    - If the result is a list of names/records, list them nicely.
    - If the results are empty, politely state that no matching records were found.
    - Do not mention SQL or technical database details in your response.
    - The data comes from the Retrofit Directory, which is NOT an exhaustive list of every retrofit organisation in the UK. If the user's question asks about all organisations in the UK (or a wider population) as though the Directory were complete, make clear that your answer reflects only the organisations listed in the Directory. If the user's question is specifically about the Directory itself, no such caveat is needed.

    User Question: "${userQuery}"
    SQL Query Used: "${sqlQuery}"
    Raw Database Results: ${JSON.stringify(rawResults)}

    Natural Language Answer:`

  return invokeBedrock(prompt, 0.3, ANSWER_MAX_TOKENS, { stage: 'answer' })
}

/**
 * True when the question treats the Directory as a complete UK-wide census.
 * Used only to decide whether template answers need a coverage caveat.
 * @param {string} userQuery
 * @returns {boolean}
 */
function queryImpliesUkWideExhaustive(userQuery) {
  const q = String(userQuery || '').toLowerCase()
  if (/\bin the (?:retrofit )?directory\b/.test(q)) return false
  return /\b(?:across the uk|in the uk|united kingdom|nationwide|the whole country|every (?:org|organisation|organization))\b/.test(
    q
  )
}

/**
 * Humanise a SQL column alias for template profile answers.
 * @param {string} column
 * @returns {string}
 */
export function humaniseColumnLabel(column) {
  const key = String(column || '').trim()
  const known = {
    org_name: 'Organisation',
    department_or_unit: 'Department / unit',
    org_main_type: 'Type',
    org_type_other_public: 'Type (other public)',
    org_type_other_private: 'Type (other private)',
    org_type_other_nonprofit: 'Type (other non-profit)',
    main_mission_or_remit: 'Mission / remit',
    retrofit_relevance: 'Retrofit relevance',
    primary_activity: 'Primary activity',
    primary_activity_other: 'Primary activity (other)',
    other_activities: 'Other activities',
    other_activities_other: 'Other activities (other)',
    specialisms: 'Specialisms',
    specialisms_other: 'Specialisms (other)',
    methods_or_skills: 'Methods / skills',
    methods_or_skills_other: 'Methods / skills (other)',
    works_with_fuel_poverty: 'Works with people in fuel poverty',
    works_with_health_housing: 'Works with health / housing vulnerability',
    works_with_inequalities: 'Works with groups facing inequalities',
    works_with_tenants_associations: "Works with tenants' associations",
    works_with_community_groups: 'Works with community groups',
    works_with_general_public: 'Works with the general public',
    works_with_local_authorities: 'Works with local authorities',
    works_with_central_government: 'Works with central government',
    works_with_regulators: 'Works with regulators / standards bodies',
    works_with_funders: 'Works with funders / investors',
    works_with_social_housing: 'Works with social housing providers',
    works_with_housing_associations: 'Works with housing associations',
    works_with_private_housing: 'Works with private housing / landlords',
    works_with_developers_installers: 'Works with developers / installers',
    works_with_product_suppliers: 'Works with product suppliers',
    works_with_architects: 'Works with architects / engineers',
    works_with_building_managers: 'Works with building managers',
    works_with_researchers: 'Works with researchers',
    works_with_network_convenors: 'Works with network convenors',
    works_with_consultants: 'Works with consultants / advisors',
    works_with_other_audiences: 'Works with other audiences',
    works_with_other_audiences_text: 'Other audiences (detail)',
    schemes_delivered: 'Schemes delivered',
    schemes_la_finance_detail: 'LA finance schemes (detail)',
    schemes_other_detail: 'Other schemes (detail)',
    contact_email: 'Email',
    employee_count_band: 'Employee band',
    geographic_scope: 'Geographic scope',
    countries: 'Countries',
    operating_areas: 'Operating areas',
    operating_areas_other: 'Operating areas (other)',
    local_authority: 'Local authority',
    hq_latitude: 'HQ latitude',
    hq_longitude: 'HQ longitude',
  }
  if (known[key]) return known[key]
  return key
    .replace(/^org_/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (ch) => ch.toUpperCase())
}

/**
 * Format a cell value for display; blank-ish values are omitted by callers.
 * @param {unknown} value
 * @returns {string}
 */
function formatCellValue(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return String(value).replace(/\s+/g, ' ').trim()
}

/**
 * Build a directory answer without a second Bedrock call when the result shape
 * is simple enough (empty, count, name list, or small multi-column profile).
 * Returns null when free-form NL generation is still needed.
 *
 * @param {string} userQuery
 * @param {string[]} columns
 * @param {any[][]} rawResults
 * @returns {string | null}
 */
export function formatDirectoryAnswer(userQuery, columns, rawResults) {
  const rows = Array.isArray(rawResults) ? rawResults : []
  if (rows.length === 0) {
    return 'No matching organisations were found in the Retrofit Directory for that question.'
  }

  const caveat = queryImpliesUkWideExhaustive(userQuery)
    ? ' This reflects only organisations listed in the Retrofit Directory, not every retrofit organisation in the UK.'
    : ''

  // Single numeric aggregate (COUNT, etc.).
  if (
    rows.length === 1 &&
    Array.isArray(rows[0]) &&
    rows[0].length === 1 &&
    typeof rows[0][0] === 'number'
  ) {
    const count = rows[0][0]
    if (caveat) {
      return `I can only report organisations listed in the Retrofit Directory; there are ${count} matching records.${caveat}`
    }
    return `There are ${count} matching records in the Retrofit Directory.`
  }

  // Single-column list (org names, types, places, …) — any length.
  if (rows.every((row) => Array.isArray(row) && row.length === 1)) {
    const items = rows.map((row) => {
      const text = formatCellValue(row[0])
      return text || '(blank)'
    })
    if (items.length === 1) {
      return `${items[0]}${caveat}`
    }
    const intro =
      items.length >= LONG_LIST_THRESHOLD
        ? `There are ${items.length} matching records in the Retrofit Directory. The full list is below.${caveat}`
        : `There are ${items.length} matching records in the Retrofit Directory:${caveat}`
    const lines = items.map((item, index) => `${index + 1}. ${item}`)
    return `${intro}\n\n${lines.join('\n')}`
  }

  // Small multi-column result sets: render a structured profile/list.
  const colCount = Array.isArray(rows[0]) ? rows[0].length : 0
  const colNames =
    Array.isArray(columns) && columns.length === colCount
      ? columns
      : Array.from({ length: colCount }, (_, i) => `Field ${i + 1}`)

  // Richer orgs_llm profiles can return many works_with_* fields; still template them.
  if (rows.length <= 25 && colCount >= 2 && colCount <= 40) {
    const nameIdx = colNames.findIndex((c) => /^(org_name|name)$/i.test(String(c)))
    const blocks = rows.map((row) => {
      const cells = colNames.map((col, i) => ({
        label: humaniseColumnLabel(col),
        value: formatCellValue(row[i]),
      }))
      const title =
        nameIdx >= 0 && cells[nameIdx]?.value
          ? cells[nameIdx].value
          : cells.find((c) => c.value)?.value || 'Record'
      const details = cells
        .filter((c, i) => c.value && i !== nameIdx)
        .map((c) => `- **${c.label}:** ${c.value}`)
      return details.length ? `**${title}**\n${details.join('\n')}` : `**${title}**`
    })

    if (blocks.length === 1) {
      return `${blocks[0]}${caveat ? `\n\n${caveat.trim()}` : ''}`
    }
    const intro = `There are ${blocks.length} matching records in the Retrofit Directory:${caveat}`
    return `${intro}\n\n${blocks.join('\n\n')}`
  }

  return null
}

/**
 * Remove SQL line/block comments so keyword checks cannot be defeated by
 * comment camouflage.
 * @param {string} sql
 * @returns {string}
 */
function stripSqlComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

/**
 * Replace string literals with empty quoted placeholders so keyword / semicolon
 * checks ignore values such as LIKE '%into%' or 'a;b'.
 * Handles SQL single quotes (including '') and double-quoted identifiers/strings.
 * @param {string} sql
 * @returns {string}
 */
function maskSqlStringLiterals(sql) {
  return String(sql || '')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
}

/**
 * Normalise raw LLM SQL output before validation/execution.
 * Strips markdown fences and any prose before the first SELECT/WITH.
 * @param {string} text
 * @returns {string}
 */
export function extractSqlFromLlmOutput(text) {
  let sql = String(text || '').trim()
  if (!sql) return ''

  const fence = sql.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  if (fence) {
    sql = fence[1].trim()
  }

  // Drop a leading prose line if the model ignored "SQL only".
  const start = sql.search(/\b(?:WITH|SELECT)\b/i)
  if (start > 0) {
    sql = sql.slice(start).trim()
  }

  return sql
}

/**
 * Guardrail: allow a single SELECT / WITH…SELECT statement only.
 * Rejects multi-statement SQL, writes, and SQLite admin features.
 * String literals are masked so harmless values cannot trip keyword checks.
 * @param {string} sql
 * @returns {void}
 */
export function validateSql(sql) {
  const original = String(sql || '')
  const withoutComments = stripSqlComments(original).trim()
  if (!withoutComments) {
    throw new UnsafeSqlError(original.slice(0, 120))
  }

  // Allow one optional trailing semicolon; reject any other statement separator
  // outside of string literals.
  const single = withoutComments.replace(/;\s*$/, '').trim()
  const masked = maskSqlStringLiterals(single)
  if (!single || masked.includes(';')) {
    throw new UnsafeSqlError(original.slice(0, 120))
  }

  if (!/^(?:WITH|SELECT)\b/i.test(single)) {
    throw new UnsafeSqlError(original.slice(0, 120))
  }

  if (FORBIDDEN_SQL_KEYWORD.test(masked) || FORBIDDEN_SQL_REPLACE_STMT.test(masked)) {
    throw new UnsafeSqlError(original.slice(0, 120))
  }
}

/**
 * Reject further Bedrock spend once today's logged tokens hit the daily budget.
 * @returns {Promise<void>}
 */
async function assertDailyTokenBudget() {
  if (DAILY_TOKEN_BUDGET <= 0) return
  const used = await getTodayTokenTotal()
  if (used >= DAILY_TOKEN_BUDGET) {
    throw new DailyTokenBudgetError(used, DAILY_TOKEN_BUDGET)
  }
}

/**
 * Check whether generated SQL references canonical alias columns from orgs_llm.
 * @param {string} sql
 * @returns {boolean}
 */
function referencesCanonicalLlmColumns(sql) {
  return CANONICAL_LLM_COLUMNS.some((column) => {
    const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i')
    return pattern.test(sql)
  })
}

/**
 * If canonical alias columns are used, make sure query targets orgs_llm.
 * @param {string} sql
 * @returns {string}
 */
function alignCanonicalColumnsToLlmView(sql) {
  if (!referencesCanonicalLlmColumns(sql)) return sql
  if (/from\s+"?orgs_llm"?\b/i.test(sql)) return sql
  return sql.replace(/\bfrom\s+"?orgs"?\b/i, 'FROM orgs_llm')
}

/**
 * Add DISTINCT for simple organisation-name listing queries to suppress duplicate names.
 * @param {string} sql
 * @returns {string}
 */
function enforceDistinctForOrgNameLists(sql) {
  if (/\bselect\s+distinct\b/i.test(sql)) return sql
  if (/\bcount\s*\(/i.test(sql)) return sql
  if (!/\bselect\s+org_name\b/i.test(sql)) return sql
  if (!/\bfrom\s+"?orgs_llm"?\b/i.test(sql)) return sql
  return sql.replace(/\bselect\s+/i, 'SELECT DISTINCT ')
}

// Catch errors from middleware (e.g. PayloadTooLarge from express.json) and return clean JSON.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500
  const message =
    status === 413 ? 'Out of memory - please start again by pressing the New button' : status < 500 ? err.message : 'Internal Server Error'
  res.status(status).json({ error: message })
})

/**
 * Extract the plain text of a chat message, tolerating both the user shape
 * (`content: [{ query }]`) and the assistant shape (`content: [{ text }]`).
 * @param {any} message
 * @returns {string}
 */
function extractMessageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (typeof block === 'string' ? block : (block?.query ?? block?.text ?? '')))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Render prior turns as a plain-text transcript for the reformulation prompt.
 * @param {any[]} messages Full history, including the message being answered.
 * @returns {string}
 */
function formatConversationTranscript(messages) {
  return messages
    .slice(0, -1)
    .slice(-MAX_HISTORY_TURNS)
    .map((message) => {
      const text = extractMessageText(message)
      if (!text) return ''
      return `${message?.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Rephrase the user's query into a standalone question that carries context from
 * previous turns (e.g. "and how many in Manchester" becomes a full question).
 * Uses the cheaper Qwen model, and falls back to the original query on failure.
 * @param {any[]} messages Full conversation history from the request body.
 * @param {string} lastUserMessage The latest user query.
 * @returns {Promise<string>}
 */
async function reformulateUserQueryToIncludePreviousContext(messages, lastUserMessage) {
  const transcript = formatConversationTranscript(messages)
  if (!transcript) return lastUserMessage

  const prompt = `Rewrite the user's latest question as a single standalone question about UK housing retrofit.

    The assistant can answer two kinds of questions:
    (1) lookups in a directory of UK retrofit organisations, and
    (2) questions about UK retrofit policy, regulations, schemes, and guidance documents.

    Rules:
    - Resolve pronouns and elliptical references (e.g. "and in Manchester?" or "what does that strategy say about ECO?") using the conversation below.
    - Preserve the user's intent exactly; do not answer the question, add filters, or invent details.
    - If the latest question is already self-contained, return it unchanged.
    - Output ONLY the rewritten question on a single line, with no preface, labels, quotes, or explanation.

    Conversation so far:
    ${transcript}

    Latest question: "${lastUserMessage}"
    Standalone question:`

  try {
    const reformulated = (
      await invokeBedrock(prompt, 0.0, REFORMULATE_MAX_TOKENS, {
        modelId: CHEAP_MODEL_ID,
        stage: 'reformulate',
      })
    )
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!reformulated || reformulated.length > MAX_QUERY_LENGTH_WITH_CONTEXT) return lastUserMessage
    return reformulated
  } catch (error) {
    logAPICalls(
      `Reformulation failed, falling back to the original query: ${error?.message || error}`
    )
    return lastUserMessage
  }
}

/**
 * Fast keyword/intent rules that avoid a Bedrock round-trip when confident.
 * Returns null when the question is ambiguous and the LLM router should run.
 *
 * @param {string} userQuery
 * @returns {'directory' | 'policy' | 'out_of_scope' | null}
 */
export function classifyQueryIntentHeuristic(userQuery) {
  const q = String(userQuery || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  if (!q) return null

  // Clear non-retrofit chit-chat / trivia.
  if (
    /\b(weather|forecast|recipe|football|lottery|stock price|bitcoin|write (?:me )?(?:a )?poem|joke)\b/.test(
      q
    ) &&
    !/\bretrofit|housing|heat pump|insulation|epc\b/.test(q)
  ) {
    return 'out_of_scope'
  }

  const policyHit =
    /\b(funding|fund(?:s|ing)?|grant(?:s)?|subsid(?:y|ies)|rebate(?:s)?|eligib(?:le|ility)|regulati(?:on|ons)|legislat(?:ion|e)|polic(?:y|ies)|scheme(?:s)?|strateg(?:y|ies)|guidance|standard(?:s)?|obligation(?:s)?|compliance|eco\s*4?\b|green deal|boiler upgrade|bus\b|heat and buildings|pas\s*2035|ofgem|fuel poverty|epbd|heca|warm home(?:s)?|social housing decarbonisation)\b/.test(
      q
    ) ||
    /\bwhat (?:is|are|does)\b/.test(q) ||
    /\b(?:define|definition of)\b/.test(q) ||
    /\bis there (?:any )?(?:funding|grant|support|subsidy)\b/.test(q)

  const directoryHit =
    /\b(organisati(?:on|ons)|organizati(?:on|ons)|\borgs?\b|installer(?:s)?|architect(?:s)?|contractor(?:s)?|consultant(?:s)?|manufacturer(?:s)?|directory)\b/.test(
      q
    ) ||
    /\b(?:who (?:is|are) working|which (?:org|organisation|organization|company|companies|installer|architect)|how many|based in|located in|listed in|tell me about|contact (?:email|details)|website|email address|near(?:est)?\b|within \d+|working on|works on)\b/.test(
      q
    ) ||
    /\bin (?:london|manchester|birmingham|bristol|leeds|glasgow|edinburgh|cardiff|belfast|[a-z]+shire)\b/.test(
      q
    )

  if (policyHit && !directoryHit) return 'policy'
  if (directoryHit && !policyHit) return 'directory'
  if (policyHit && directoryHit) {
    // Funding/rules about measures beat org-type words (“heat pump installation”).
    if (
      /\b(funding|fund(?:s|ing)?|grant(?:s)?|subsid|eligib|regulati|legislat|polic(?:y|ies)|scheme|guidance|strateg)/.test(
        q
      ) ||
      /\bwhat (?:is|are|does)\b/.test(q)
    ) {
      return 'policy'
    }
    return 'directory'
  }
  return null
}

/**
 * Classify whether the user wants a directory (SQL) lookup, policy-document RAG,
 * or something outside both scopes. Tries a zero-latency heuristic first, then
 * Haiku. Defaults to directory on failure so existing organisation queries keep
 * working if the router is unavailable.
 * @param {string} userQuery
 * @returns {Promise<'directory' | 'policy' | 'out_of_scope'>}
 */
async function classifyQueryIntent(userQuery) {
  const heuristic = classifyQueryIntentHeuristic(userQuery)
  if (heuristic) {
    logAPICalls('Intent classified heuristically:', heuristic)
    return heuristic
  }

  const prompt = `Classify the user's question into exactly one label.

Labels:
- directory — questions about organisations in the Retrofit Directory: names, counts, locations/counties, organisation types, activities, specialisms, skills, websites, contacts, who works with whom, employee size bands, or other facts stored about listed organisations.
- policy — questions about UK retrofit / energy-efficiency / fuel-poverty policy, regulations, strategies, schemes, standards, or technical/policy guidance (e.g. ECO, Green Deal, Heat and Buildings Strategy, HECA, EPBD, Code for Sustainable Homes, Ofgem delivery guidance, committee reports).
- out_of_scope — anything that is neither a directory organisation lookup nor retrofit policy/guidance (e.g. weather, cooking, general coding, unrelated trivia).

Disambiguation:
- Concrete organisation search/count/list/filter questions → directory.
- Questions about rules, eligibility, obligations, government strategy, or what a named policy document says → policy, even if they mention "organisations" in the abstract.
- If both could apply but the primary ask is organisation data, choose directory.
- If unsure between directory and policy, prefer directory.

Output ONLY one label with no punctuation or explanation: directory OR policy OR out_of_scope.

User question: "${userQuery}"
Label:`

  try {
    const raw = await invokeBedrock(prompt, 0.0, ROUTE_MAX_TOKENS, {
      modelId: BEDROCK_MODEL_ID,
      stage: 'route',
    })
    const normalised = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .toLowerCase()
      .replace(/[^a-z_]/g, ' ')
      .trim()
    const token = normalised.split(/\s+/).find((part) => VALID_INTENTS.has(part))
    if (token) return /** @type {'directory' | 'policy' | 'out_of_scope'} */ (token)
    logAPICalls('Intent classifier returned unrecognised label; defaulting to directory:', raw)
    return 'directory'
  } catch (error) {
    logAPICalls(`Intent classification failed, defaulting to directory: ${error?.message || error}`)
    return 'directory'
  }
}

/**
 * Read a string metadata field from a KB citation reference.
 * Bedrock may flatten sidecar attributes at the top level or nest them.
 * @param {Record<string, unknown>} metadata
 * @param {string[]} keys
 * @returns {string}
 */
function metadataString(metadata, keys) {
  const bags = [metadata]
  if (metadata && typeof metadata === 'object' && metadata.metadataAttributes) {
    bags.push(/** @type {Record<string, unknown>} */ (metadata.metadataAttributes))
  }
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue
    for (const key of keys) {
      const value = bag[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return ''
}

/**
 * True when the URL is safe to expose as a browser link (http/https only).
 * S3 URIs are not valid hrefs for end users.
 * @param {string} url
 * @returns {boolean}
 */
function isBrowserUrl(url) {
  return /^https?:\/\//i.test(url)
}

/**
 * Build a user-facing source list from RetrieveAndGenerate citations.
 * Prefers S3 object metadata attributes `display_name` and `url` when present.
 * @param {any} response
 * @returns {{ name: string, url: string }[]}
 */
function sourcesFromKbCitations(response) {
  /** @type {Map<string, { name: string, url: string }>} */
  const byKey = new Map()

  const citations = response?.citations ?? []
  for (const citation of citations) {
    const references = citation?.retrievedReferences ?? []
    for (const reference of references) {
      const location = reference?.location ?? {}
      const s3 = location?.s3Location ?? {}
      const web = location?.webLocation ?? {}
      const s3Uri = typeof s3.uri === 'string' ? s3.uri : ''
      const webUrl = typeof web.url === 'string' ? web.url : ''
      const metadata = reference?.metadata ?? {}

      // Product metadata from *.metadata.json sidecars (preferred for display).
      const displayName = metadataString(metadata, ['display_name', 'displayName'])
      const metadataUrl = metadataString(metadata, ['url', 'source_url', 'sourceUrl'])
      const metadataTitle = metadataString(metadata, [
        'title',
        'document_title',
        'x-amz-bedrock-kb-document-page-content-type',
        'x-amz-bedrock-kb-title',
      ])

      let name = displayName || metadataTitle
      if (!name && s3Uri) {
        try {
          const basename = decodeURIComponent(s3Uri.split('/').pop() || '')
          name =
            basename
              .replace(/\.pdf$/i, '')
              .replace(/[_+]+/g, ' ')
              .trim() || ''
        } catch {
          name = ''
        }
      }
      if (!name && webUrl) name = webUrl
      if (!name) continue

      // Prefer the human document URL from metadata; never use s3:// as a link href.
      let url = ''
      if (isBrowserUrl(metadataUrl)) url = metadataUrl
      else if (isBrowserUrl(webUrl)) url = webUrl
      // If we only have an S3 URI, still surface the display name but with an empty
      // url so the UI does not render a non-navigable s3:// link.

      // Dedupe by stable identity: prefer metadata URL, else name+s3 key.
      const key = url || s3Uri || name
      if (!byKey.has(key)) byKey.set(key, { name, url })
    }
  }

  return [...byKey.values()]
}

/**
 * Answer a policy/guidance question via Bedrock Knowledge Base RAG.
 * @param {string} userQuery
 * @returns {Promise<{ answer: string, sources: { name: string, url: string }[], noHit: boolean }>}
 */
async function answerFromKnowledgeBase(userQuery) {
  const response = await bedrockAgent.send(
    new RetrieveAndGenerateCommand({
      input: { text: userQuery },
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          modelArn: KB_GENERATION_MODEL_ARN,
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults: 6,
            },
          },
          generationConfiguration: {
            inferenceConfig: {
              textInferenceConfig: {
                temperature: 0.2,
                maxTokens: ANSWER_MAX_TOKENS,
              },
            },
            promptTemplate: {
              // $output_format_instructions$ is required for Bedrock to attach citations.
              textPromptTemplate: `You are a helpful assistant for UK housing retrofit policy and guidance.
Use only the search results to answer the user's question.
If the search results do not contain enough information, say you could not find relevant information in the policy documents rather than guessing.
Do not invent organisation directory facts (names, counts, contacts) that are not in the search results.
Be clear and concise. Prefer UK terminology. Mention document titles when they help the user verify the answer.

Formatting:
- When the answer lists schemes, grants, eligibility criteria, obligations, options, or several distinct points, use a short Markdown bullet list.
- Lead with one summary sentence, then bullets; keep each bullet to one or two short sentences.
- Prefer bullets over long paragraphs for multi-item answers. Use a short paragraph only for a single simple fact or a yes/no-style answer.
- Do not pad with extra commentary, preambles, or repeated caveats.

Here are the search results in numbered order:
$search_results$

Here is the user's question:
$query$

$output_format_instructions$
`,
            },
          },
        },
      },
    })
  )

  // RetrieveAndGenerate does not always expose Converse-style token usage; record
  // the call so route mix and latency still appear in the usage dashboard.
  const usage = response?.usage ?? response?.output?.usage ?? null
  recordModelCall({
    stage: 'kb',
    modelId: BEDROCK_MODEL_ID,
    inputTokens: usage?.inputTokens ?? usage?.inputTokenCount ?? 0,
    outputTokens: usage?.outputTokens ?? usage?.outputTokenCount ?? 0,
  })
  logAPICalls(`Bedrock KB ${KNOWLEDGE_BASE_ID} (kb): citations=${response?.citations?.length ?? 0}`)

  const answer = (response?.output?.text ?? '').trim()
  const sources = sourcesFromKbCitations(response)
  const soundsLikeNoHit =
    /could not find|don't know|do not know|no (relevant |information|context)|not (enough|sufficient) information|unable to (find|answer)|i'm unable|i am unable/i.test(
      answer
    )

  if (!answer || soundsLikeNoHit) {
    return {
      answer: answer || POLICY_NO_HIT_RESPONSE,
      sources: soundsLikeNoHit ? sources : [],
      noHit: true,
    }
  }

  return { answer, sources, noHit: false }
}

app.post('/api/query', async (req, res) =>
  withUsageCapture(async () => {
    // Accumulated as the request progresses, then persisted once the response has
    // been sent. Token counts are gathered separately by the usage context.
    const logEntry = {
      rawQuery: '',
      reformulatedQuery: null,
      route: null,
      sqlQuery: null,
      rowCount: null,
      response: null,
      outcome: 'error',
    }

    // Send the response first, then persist. Logging must never add latency to,
    // or be able to fail, a user-facing request.
    /**
     * Send the JSON response and persist a usage log entry for this request.
     * @param {{ response: string, sources?: object[] }} payload
     * @returns {Promise<void>}
     */
    const respondAndLog = async (payload) => {
      res.json(payload)
      await saveRequestLog(logEntry)
    }

    try {
      // Validate the request envelope before extracting the query, so that a
      // malformed body yields a 400 rather than a TypeError surfaced as a 500.
      const messages = req.body?.messages
      if (!Array.isArray(messages) || messages.length === 0) {
        return res
          .status(400)
          .json({ error: "Invalid request body: 'messages' must be a non-empty array" })
      }
      const lastContent = messages[messages.length - 1]?.content
      if (!Array.isArray(lastContent) || lastContent.length === 0) {
        return res.status(400).json({
          error: "Invalid request body: last message must have a non-empty 'content' array",
        })
      }
      let userQuery = lastContent[0]?.query
      logAPICalls('Received query:', userQuery)

      // Validate input type and length before spending a model call on it.
      if (typeof userQuery !== 'string' || !userQuery.trim()) {
        return res.status(400).json({ error: "Missing or invalid 'query' in request body" })
      }
      if (userQuery.length > MAX_QUERY_LENGTH) {
        return res
          .status(400)
          .json({ error: `Query too long (max ${MAX_QUERY_LENGTH} characters)` })
      }
      logEntry.rawQuery = userQuery

      // Global spend circuit-breaker before any Bedrock call.
      try {
        await assertDailyTokenBudget()
      } catch (error) {
        if (error instanceof DailyTokenBudgetError) {
          logAPICalls('Daily token budget exceeded:', error.message)
          logEntry.outcome = 'error'
          logEntry.response = error.message
          res.status(429).json({
            error:
              'The directory assistant has reached its daily usage limit. Please try again tomorrow.',
          })
          await saveRequestLog(logEntry)
          return
        }
        throw error
      }

      // If there is previous context, reformulate the user's query to include it.
      if (messages.length > 1) {
        userQuery = await reformulateUserQueryToIncludePreviousContext(messages, userQuery)
        logEntry.reformulatedQuery = userQuery
        logAPICalls('Reformulated query with context:', userQuery)
      }

      // Sanitise: strip characters that could break prompt string delimiters.
      const safeQuery = userQuery.replace(/["\\]/g, ' ').trim()

      // Proximity (near/nearest) needs no intent LLM and no text-to-SQL — run first.
      const proximity = await tryAnswerProximityQuery(safeQuery, DB_PATH)
      if (proximity.handled) {
        logEntry.route = 'directory'
        logEntry.sqlQuery = proximity.sqlQuery
        logEntry.rowCount = proximity.rowCount
        logEntry.response = proximity.answer
        logEntry.outcome = 'ok'
        logAPICalls('Proximity query processed:', {
          safeQuery,
          sqlQuery: proximity.sqlQuery,
          rowCount: proximity.rowCount,
          meta: proximity.meta,
        })
        return respondAndLog({ response: proximity.answer, sources: [] })
      }

      const intent = await classifyQueryIntent(safeQuery)
      logEntry.route = intent
      logAPICalls('Classified intent:', intent)

      if (intent === 'out_of_scope') {
        logEntry.outcome = 'out_of_scope'
        logEntry.response = OUT_OF_SCOPE_RESPONSE
        return respondAndLog({ response: OUT_OF_SCOPE_RESPONSE, sources: [] })
      }

      if (intent === 'policy') {
        const { answer, sources, noHit } = await answerFromKnowledgeBase(safeQuery)
        logEntry.response = answer
        logEntry.outcome = noHit ? 'kb_no_hit' : 'ok'
        logAPICalls('Policy KB answer:', {
          safeQuery,
          noHit,
          sourceCount: sources.length,
          answerPreview: answer.slice(0, 240),
        })
        return respondAndLog({ response: answer, sources })
      }

      // Directory path: text-to-SQL, then template answer when the shape is simple.
      const generatedSqlQuery = await generateSqlFromQuery(safeQuery)
      let sqlQuery = extractSqlFromLlmOutput(generatedSqlQuery)
      sqlQuery = alignCanonicalColumnsToLlmView(sqlQuery)
      sqlQuery = enforceDistinctForOrgNameLists(sqlQuery)
      logEntry.sqlQuery = sqlQuery

      // Reject anything that isn't a safe SELECT before it touches the database.
      try {
        validateSql(sqlQuery)
      } catch (error) {
        if (error instanceof UnsafeSqlError) {
          logAPICalls('Rejected unsafe or non-SQL model output:', {
            safeQuery,
            generatedSqlQuery,
            sqlQuery,
          })
          logEntry.outcome = 'out_of_scope'
          logEntry.response = OUT_OF_SCOPE_RESPONSE
          return respondAndLog({ response: OUT_OF_SCOPE_RESPONSE, sources: [] })
        }
        throw error
      }

      let repaired = false
      /** @type {{ columns: string[], rows: any[][] }} */
      let queryResult
      try {
        queryResult = await queryDatabase(sqlQuery)
      } catch (dbError) {
        const sqliteErrorText = dbError?.message || String(dbError)
        const repairedSqlRaw = await regenerateSqlFromError(safeQuery, sqlQuery, sqliteErrorText)
        sqlQuery = extractSqlFromLlmOutput(repairedSqlRaw)
        sqlQuery = alignCanonicalColumnsToLlmView(sqlQuery)
        sqlQuery = enforceDistinctForOrgNameLists(sqlQuery)
        logEntry.sqlQuery = sqlQuery
        try {
          validateSql(sqlQuery)
        } catch (error) {
          if (error instanceof UnsafeSqlError) {
            logAPICalls('Rejected unsafe SQL after repair attempt:', {
              safeQuery,
              repairedSqlRaw,
              sqlQuery,
            })
            logEntry.outcome = 'out_of_scope'
            logEntry.response = OUT_OF_SCOPE_RESPONSE
            return respondAndLog({ response: OUT_OF_SCOPE_RESPONSE, sources: [] })
          }
          throw error
        }
        queryResult = await queryDatabase(sqlQuery)
        repaired = true
        logAPICalls('Query repaired after initial SQLite error:', {
          safeQuery,
          sqliteErrorText,
          repairedSql: sqlQuery,
        })
      }

      const { columns, rows: rawResults } = queryResult
      const templated = formatDirectoryAnswer(safeQuery, columns, rawResults)
      const answer =
        templated ??
        (await generateNaturalLanguageAnswer(safeQuery, sqlQuery, rawResults))

      // Return only the natural-language answer; SQL and raw rows are logged server-side only.
      // Directory answers keep sources empty by product choice.
      logAPICalls('Query processed:', {
        safeQuery,
        sqlQuery,
        rowCount: rawResults.length,
        templated: Boolean(templated),
        SQLresults: rawResults,
      })

      logEntry.rowCount = rawResults.length
      logEntry.response = answer
      logEntry.outcome = repaired ? 'repaired' : 'ok'

      await respondAndLog({ response: answer, sources: [] })
    } catch (error) {
      console.error('Error processing query:', error)
      res.status(500).json({ error: 'Internal Server Error' })
      // Only log failures that got far enough to have a question attached.
      if (logEntry.rawQuery) {
        logEntry.outcome = 'error'
        logEntry.response = error?.message || String(error)
        await saveRequestLog(logEntry)
      }
    }
  })
)

/**
 * Constant-time string compare for bearer tokens. Length mismatch still walks
 * the expected secret so timing does not leak its length in an obvious way.
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function timingSafeEqualString(provided, expected) {
  const a = Buffer.from(String(provided), 'utf8')
  const b = Buffer.from(String(expected), 'utf8')
  if (a.length !== b.length) {
    // Compare against itself so the work is not skipped on length mismatch.
    cryptoTimingSafeEqual(b, b)
    return false
  }
  return cryptoTimingSafeEqual(a, b)
}

/**
 * Gate /api/observe behind ADMIN_PASSWORD (Authorization: Bearer …).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true when the request may proceed
 */
function requireAdmin(req, res) {
  if (!ADMIN_PASSWORD) {
    res.status(503).json({
      error: 'Admin access is not configured. Set ADMIN_PASSWORD on the server.',
    })
    return false
  }

  const header = req.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  const token = match?.[1]?.trim() || ''
  if (!token || !timingSafeEqualString(token, ADMIN_PASSWORD)) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

app.post('/api/observe', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    // `includeRecent` will drive the scrollable query/response list on
    // admin.html; token totals are always present.
    const summary = await getUsageSummary({
      includeRecent: req.body?.includeRecent === true,
      recentLimit: req.body?.recentLimit,
    })
    res.json(summary)
  } catch (error) {
    console.error('Error building usage summary:', error)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

/**
 * time stamp and output message to console
 * @param {string} message
 * @param {...unknown} details Optional extra values to log alongside the message.
 */
function logAPICalls(message, ...details) {
  if (!VERBOSE) return
  const d = new Date()
  const timestamp = `${d.toLocaleTimeString()}:${d.getMilliseconds()}`
  console.log(`[${timestamp}] ${message}`, ...details)
}
