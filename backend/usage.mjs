import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import sqlite3 from 'sqlite3'

/**
 * Usage/observability store for the retrofit query service.
 *
 * Deliberately kept in its own SQLite file rather than in directory.db:
 *   - csvToDB.mjs walks every table/view in directory.db to generate
 *     directory.schema, which is injected into the SQL-generation prompt. Usage
 *     rows would leak user questions into prompts and let the model query them.
 *   - query.mjs opens directory.db OPEN_READONLY by design.
 *
 * Nothing in here is allowed to break a user request: every public function
 * swallows its own errors and logs instead of throwing.
 */

const USAGE_DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'usage.db')

/**
 * Bedrock on-demand prices in USD per 1,000,000 tokens, keyed by model id.
 *
 * IMPORTANT: verify these against the AWS Bedrock pricing page for the region
 * in use before treating reported costs as authoritative. Token counts in the
 * database are raw, so corrected rates retroactively fix all reported costs.
 * See https://aws.amazon.com/bedrock/pricing/
 */
const MODEL_RATES_USD_PER_MTOK = {
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1.1, output: 5.5 },
  'qwen.qwen3-235b-a22b-2507-v1:0': { input: 0.34, output: 1.37 },
}
const FALLBACK_RATE_USD_PER_MTOK = { input: 0, output: 0 }

const DEFAULT_RECENT_LIMIT = 50
const MAX_RECENT_LIMIT = 500

/** Per-request token capture context, so invokeBedrock needs no threading. */
const usageContext = new AsyncLocalStorage()

/** @type {sqlite3.Database | null} */
let db = null

/**
 * Promise-based wrapper around sqlite3 `db.run`.
 * @param {sqlite3.Database} database
 * @param {string} sql
 * @param {unknown[]} [params=[]]
 * @returns {Promise<sqlite3.RunResult>}
 */
function run(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err)
        return
      }
      resolve(this)
    })
  })
}

/**
 * Promise-based wrapper around sqlite3 `db.all`.
 * @param {sqlite3.Database} database
 * @param {string} sql
 * @param {unknown[]} [params=[]]
 * @returns {Promise<any[]>}
 */
function all(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err, rows) => {
      if (err) {
        reject(err)
        return
      }
      resolve(rows)
    })
  })
}

/**
 * Open usage.db (creating it if absent) and ensure the schema exists.
 * Safe to call once at startup; subsequent calls reuse the open handle.
 * @returns {Promise<sqlite3.Database | null>} null if the store is unavailable.
 */
export async function initUsageStore() {
  if (db) return db

  try {
    const database = await new Promise((resolve, reject) => {
      const handle = new sqlite3.Database(
        USAGE_DB_PATH,
        sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
        (err) => (err ? reject(err) : resolve(handle))
      )
    })

    // WAL lets /api/observe read while /api/query writes. Single Node process
    // means a single writer, so there is no real contention to manage.
    await run(database, 'PRAGMA journal_mode = WAL')
    await run(database, 'PRAGMA busy_timeout = 5000')

    await run(
      database,
      `CREATE TABLE IF NOT EXISTS request_log (
         id                 INTEGER PRIMARY KEY,
         ts                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
         raw_query          TEXT    NOT NULL,
         reformulated_query TEXT,
         route              TEXT,
         sql_query          TEXT,
         row_count          INTEGER,
         response           TEXT,
         outcome            TEXT    NOT NULL,
         input_tokens       INTEGER NOT NULL DEFAULT 0,
         output_tokens      INTEGER NOT NULL DEFAULT 0,
         latency_ms         INTEGER
       )`
    )
    // Older usage.db files pre-date the hybrid router; add the column if missing.
    const requestLogColumns = await all(database, 'PRAGMA table_info(request_log)')
    if (!requestLogColumns.some((column) => column.name === 'route')) {
      await run(database, 'ALTER TABLE request_log ADD COLUMN route TEXT')
    }
    await run(database, 'CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts)')

    await run(
      database,
      `CREATE TABLE IF NOT EXISTS model_call (
         id            INTEGER PRIMARY KEY,
         request_id    INTEGER NOT NULL REFERENCES request_log(id) ON DELETE CASCADE,
         stage         TEXT    NOT NULL,
         model_id      TEXT    NOT NULL,
         input_tokens  INTEGER NOT NULL DEFAULT 0,
         output_tokens INTEGER NOT NULL DEFAULT 0
       )`
    )
    await run(
      database,
      'CREATE INDEX IF NOT EXISTS idx_model_call_request ON model_call(request_id)'
    )

    db = database
    return db
  } catch (error) {
    console.error(`Usage store unavailable at ${USAGE_DB_PATH}:`, error?.message || error)
    return null
  }
}

/**
 * Run `callback` inside a fresh token-capture context.
 *
 * Any invokeBedrock call made within the callback (including nested async
 * calls) contributes to the same tally, and concurrent requests stay isolated.
 * @template T
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
export function withUsageCapture(callback) {
  return usageContext.run({ calls: [], startedAt: Date.now() }, callback)
}

/**
 * Record one model invocation against the active capture context.
 * A no-op when called outside withUsageCapture (e.g. from a CLI path).
 * @param {{ stage: string, modelId: string, inputTokens?: number, outputTokens?: number }} call
 * @returns {void}
 */
export function recordModelCall({ stage, modelId, inputTokens, outputTokens }) {
  const store = usageContext.getStore()
  if (!store) return
  store.calls.push({
    stage,
    modelId,
    inputTokens: Number(inputTokens) || 0,
    outputTokens: Number(outputTokens) || 0,
  })
}

/**
 * Milliseconds elapsed since the active capture context began, or null.
 * @returns {number | null}
 */
export function elapsedMs() {
  const store = usageContext.getStore()
  return store ? Date.now() - store.startedAt : null
}

/**
 * Persist one request plus its per-model call breakdown.
 *
 * Call this after the HTTP response has been sent. Errors are logged and
 * swallowed so that observability never degrades the user-facing request.
 * @param {{
 *   rawQuery: string,
 *   reformulatedQuery?: string | null,
 *   route?: "directory" | "policy" | "out_of_scope" | null,
 *   sqlQuery?: string | null,
 *   rowCount?: number | null,
 *   response?: string | null,
 *   outcome: "ok" | "out_of_scope" | "repaired" | "error" | "kb_no_hit",
 * }} entry
 * @returns {Promise<void>}
 */
export async function saveRequestLog(entry) {
  const store = usageContext.getStore()
  const calls = store?.calls ?? []
  const latencyMs = elapsedMs()

  try {
    const database = await initUsageStore()
    if (!database) return

    const inputTokens = calls.reduce((total, call) => total + call.inputTokens, 0)
    const outputTokens = calls.reduce((total, call) => total + call.outputTokens, 0)

    const result = await run(
      database,
      `INSERT INTO request_log
         (raw_query, reformulated_query, route, sql_query, row_count, response, outcome, input_tokens, output_tokens, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.rawQuery,
        entry.reformulatedQuery ?? null,
        entry.route ?? null,
        entry.sqlQuery ?? null,
        entry.rowCount ?? null,
        entry.response ?? null,
        entry.outcome,
        inputTokens,
        outputTokens,
        latencyMs,
      ]
    )

    const requestId = result?.lastID
    for (const call of calls) {
      await run(
        database,
        `INSERT INTO model_call (request_id, stage, model_id, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?)`,
        [requestId, call.stage, call.modelId, call.inputTokens, call.outputTokens]
      )
    }
  } catch (error) {
    console.error('Failed to write usage log:', error?.message || error)
  }
}

/**
 * Total input+output tokens logged for the current UTC calendar day.
 * Used as a global Bedrock spend circuit-breaker. Returns 0 if the store is down
 * so availability issues do not block the API (cost risk only while usage.db is broken).
 * @returns {Promise<number>}
 */
export async function getTodayTokenTotal() {
  try {
    const database = await initUsageStore()
    if (!database) return 0

    const day = new Date().toISOString().slice(0, 10)
    const [row] = await all(
      database,
      `SELECT COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens
         FROM request_log
        WHERE substr(ts, 1, 10) = ?`,
      [day]
    )
    return Number(row?.total_tokens) || 0
  } catch (error) {
    console.error("Failed to read today's token total:", error?.message || error)
    return 0
  }
}

/**
 * Convert token counts into an approximate USD cost for a given model.
 * @param {string} modelId
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number}
 */
function estimateCostUsd(modelId, inputTokens, outputTokens) {
  const rate = MODEL_RATES_USD_PER_MTOK[modelId] ?? FALLBACK_RATE_USD_PER_MTOK
  const cost = (inputTokens / 1e6) * rate.input + (outputTokens / 1e6) * rate.output
  return Number(cost.toFixed(6))
}

/**
 * Aggregate token usage for the admin dashboard.
 *
 * The shape is intentionally extensible. `recentRequests` is opt-in via
 * `includeRecent` so the token-count view stays small; it will later feed the
 * scrollable query/response list on admin.html without a breaking change.
 * @param {{ recentLimit?: number, includeRecent?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function getUsageSummary({
  recentLimit = DEFAULT_RECENT_LIMIT,
  includeRecent = false,
} = {}) {
  const database = await initUsageStore()
  if (!database) {
    return { available: false, error: 'Usage store unavailable' }
  }

  const limit = Math.min(Math.max(Number(recentLimit) || DEFAULT_RECENT_LIMIT, 1), MAX_RECENT_LIMIT)

  const [totalsRow] = await all(
    database,
    `SELECT COUNT(*)                     AS request_count,
            COALESCE(SUM(input_tokens),0)  AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            MIN(ts)                      AS first_request_at,
            MAX(ts)                      AS last_request_at
       FROM request_log`
  )

  const outcomeRows = await all(
    database,
    'SELECT outcome, COUNT(*) AS request_count FROM request_log GROUP BY outcome ORDER BY request_count DESC'
  )

  const routeRows = await all(
    database,
    `SELECT COALESCE(route, 'unknown') AS route, COUNT(*) AS request_count
       FROM request_log
      GROUP BY route
      ORDER BY request_count DESC`
  )

  const modelRows = await all(
    database,
    `SELECT model_id,
            COUNT(*)                     AS call_count,
            COALESCE(SUM(input_tokens),0)  AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens
       FROM model_call
      GROUP BY model_id
      ORDER BY input_tokens + output_tokens DESC`
  )

  const stageRows = await all(
    database,
    `SELECT stage,
            COUNT(*)                     AS call_count,
            COALESCE(SUM(input_tokens),0)  AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens
       FROM model_call
      GROUP BY stage
      ORDER BY input_tokens + output_tokens DESC`
  )

  const dailyRows = await all(
    database,
    `SELECT substr(ts, 1, 10)            AS day,
            COUNT(*)                     AS request_count,
            COALESCE(SUM(input_tokens),0)  AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens
       FROM request_log
      GROUP BY day
      ORDER BY day DESC`
  )

  const dailyCostRows = await all(
    database,
    `SELECT substr(r.ts, 1, 10) AS day,
            m.model_id          AS model_id,
            COALESCE(SUM(m.input_tokens),0)  AS input_tokens,
            COALESCE(SUM(m.output_tokens),0) AS output_tokens
       FROM model_call m
       JOIN request_log r ON r.id = m.request_id
      GROUP BY day, m.model_id`
  )

  const costByDay = new Map()
  for (const row of dailyCostRows) {
    const cost = estimateCostUsd(row.model_id, row.input_tokens, row.output_tokens)
    costByDay.set(row.day, (costByDay.get(row.day) ?? 0) + cost)
  }

  const byModel = modelRows.map((row) => ({
    modelId: row.model_id,
    callCount: row.call_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    estimatedCostUsd: estimateCostUsd(row.model_id, row.input_tokens, row.output_tokens),
    ratesKnown: Boolean(MODEL_RATES_USD_PER_MTOK[row.model_id]),
  }))

  const recentRequests = includeRecent
    ? await all(
        database,
        `SELECT id, ts, raw_query, reformulated_query, route, response, outcome,
                input_tokens, output_tokens, row_count, latency_ms
           FROM request_log
          ORDER BY id DESC
          LIMIT ?`,
        [limit]
      )
    : []

  const totalCostUsd = byModel.reduce((total, model) => total + model.estimatedCostUsd, 0)

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    totals: {
      requestCount: totalsRow?.request_count ?? 0,
      inputTokens: totalsRow?.input_tokens ?? 0,
      outputTokens: totalsRow?.output_tokens ?? 0,
      totalTokens: (totalsRow?.input_tokens ?? 0) + (totalsRow?.output_tokens ?? 0),
      estimatedCostUsd: Number(totalCostUsd.toFixed(6)),
      firstRequestAt: totalsRow?.first_request_at ?? null,
      lastRequestAt: totalsRow?.last_request_at ?? null,
    },
    byModel,
    byStage: stageRows.map((row) => ({
      stage: row.stage,
      callCount: row.call_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    })),
    byOutcome: outcomeRows.map((row) => ({
      outcome: row.outcome,
      requestCount: row.request_count,
    })),
    byRoute: routeRows.map((row) => ({
      route: row.route,
      requestCount: row.request_count,
    })),
    daily: dailyRows.map((row) => ({
      day: row.day,
      requestCount: row.request_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCostUsd: Number((costByDay.get(row.day) ?? 0).toFixed(6)),
    })),
    // Feeds the admin.html scrollable transcript list; empty unless requested.
    recentRequests: recentRequests.map((row) => ({
      id: row.id,
      timestamp: row.ts,
      query: row.reformulated_query || row.raw_query,
      rawQuery: row.raw_query,
      route: row.route,
      response: row.response,
      outcome: row.outcome,
      rowCount: row.row_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
    })),
  }
}
