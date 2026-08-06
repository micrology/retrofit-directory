import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
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
} from './usage.mjs'
/**
 * HTTP API for natural-language querying over the retrofit SQLite directory.
 * It uses Bedrock-hosted models to generate SQL and natural-language answers.
 */

const VERBOSE = true;  // set to false to suppress console logging of queries and results
const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "directory.db");
const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "directory.schema");
const BEDROCK_REGION = "eu-west-2";
const BEDROCK_MODEL_ID = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const CHEAP_MODEL_ID = "qwen.qwen3-235b-a22b-2507-v1:0";
const SQL_MAX_TOKENS = 300;
const ANSWER_MAX_TOKENS = 2000;
const WRAPPER_MAX_TOKENS = 220;
const REFORMULATE_MAX_TOKENS = 120;
const MAX_HISTORY_TURNS = 6;
const MAX_QUERY_LENGTH = 500;
const MAX_QUERY_LENGTH_WITH_CONTEXT = 1000;
const LONG_LIST_THRESHOLD = 25;
const CANONICAL_LLM_COLUMNS = [
  "org_name",
  "org_main_type",
  "county",
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
const OUT_OF_SCOPE_RESPONSE = "I can only answer questions about organisations in the Retrofit Directory. Please ask about organisations, locations, activities, specialisms, or types.";

class UnsafeSqlError extends Error {
  /**
   * @param {string} sqlSnippet
   */
  constructor(sqlSnippet) {
    super(`Unsafe or unexpected SQL generated: ${sqlSnippet}`);
    this.name = "UnsafeSqlError";
  }
}

process.title = 'retrofit-query-server'

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

const app = express()
const PORT = process.env.PORT || 5001

app.set('trust proxy', 1) // trust first proxy, if behind a proxy
app.use(cors({ origin: ['https://retrofit-directory.org.uk', 'http://localhost', 'http://127.0.0.1'] }))
app.use(express.json({ limit: '8kb' }))

const queryLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 20,          // max 20 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
})
app.use('/api/query', queryLimiter)

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
      `Proxy server running on http://localhost:${PORT}, using models ${BEDROCK_MODEL_ID} and ${CHEAP_MODEL_ID} in ${BEDROCK_REGION} region`
    )
  })
  httpTerminator = createHttpTerminator({ server })
}
start()

/**
 * Open the SQLite database in read-only mode for query execution.
 * @param {string} dbPath
 * @returns {Promise<sqlite3.Database>}
 */
function openDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(db);
    });
  });
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
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
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
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Read the persisted plain-text schema used in SQL-generation prompts.
 * @returns {string}
 */
function readSchema() {
  try {
    return fs.readFileSync(SCHEMA_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(
        `Error: schema file not found at ${SCHEMA_PATH}. ` +
        `Run csvToDB.mjs first to generate it.`
      );
    } else {
      console.error(`Error reading schema file at ${SCHEMA_PATH}:`, err.message);
    }
    throw err;
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
  const { modelId = BEDROCK_MODEL_ID, stage = "unknown" } = options;
  const response = await bedrock.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens, temperature },
    })
  );

  const { inputTokens, outputTokens } = response.usage ?? {};
  recordModelCall({ stage, modelId, inputTokens, outputTokens });
  logAPICalls(`Bedrock ${modelId} (${stage}): ${inputTokens} input tokens, ${outputTokens} output tokens`);

  // Concatenate text blocks and ignore any non-text blocks (e.g. reasoning content).
  const text = (response.output?.message?.content ?? [])
    .map((block) => block?.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error(`Empty response from Bedrock model ${modelId} (stopReason: ${response.stopReason})`);
  }
  return text;
}

/**
 * Convert a natural-language user question into a SQL SELECT statement.
 * @param {string} userQuery
 * @returns {Promise<string>}
 */
export async function generateSqlFromQuery(userQuery) {
  const schema = readSchema();

  const prompt = `You are an expert SQLite data analyst. Your job is to convert a user's natural language question into a valid, safe SQLite SELECT query based on the provided schema.

    This database is a survey export: column names are the full survey question text, and each column annotation shows how many rows are populated plus example values.

    Rules:
    - Return ONLY the raw SQL query. Do not include markdown formatting (like \`\`\`sql), code blocks, or explanatory text.
    - Only use SELECT statements. Never generate INSERT, UPDATE, DELETE, or DROP statements.
    - Use case-insensitive matching where appropriate (e.g., LIKE '%Manchester%') for text filters.
    - For list-style outputs (especially organisation names), use DISTINCT unless duplicates are explicitly requested.
    - The Directory contains duplicate entries: the same organisation can appear in more than one row. When the user asks to count organisations, count DISTINCT identities with COUNT(DISTINCT org_name) rather than COUNT(*), so each organisation is counted only once. Reserve COUNT(*) for counting raw rows/entries (e.g. survey responses) rather than distinct organisations.
    - Prefer querying the canonical view orgs_llm when it is present in the schema; its columns are semantic aliases (e.g. org_name, county, org_main_type, works_with_architects) and should be preferred over long raw survey column names.
    - If you reference any canonical alias column (e.g. org_name, org_main_type, county), you MUST query FROM orgs_llm (never FROM orgs).
    - Never select or filter on columns marked [EMPTY - no data]; they contain no values. For example, an organisation's "name" is the answer to the "name of the organisation" question column, NOT the empty recipient_first_name/recipient_last_name metadata columns.
    - Use the example values to map the user's terms to the correct column and its stored values. For multi-select questions, a populated cell (e.g. 'Directly'/'Indirectly') means the option was chosen; filter with "col" IS NOT NULL AND TRIM("col") != '' rather than assuming a 'Yes' value.
    - Disambiguation rule: if the user asks whether an organisation IS a type of organisation/persona (e.g. architect, engineer, local authority), use org_main_type (or the raw "main type" selected-choice column). Only use collaboration/audience columns such as works_with_architects when the user asks who the organisation works with.
    - IMPORTANT: location_latitude/location_longitude are the survey respondent's IP-based geolocation at submission time, NOT the organisation's location. Do not use them for distance/proximity questions - they are unreliable and often disagree with the organisation's actual location. For any location or proximity question, use the self-reported county column ("for_uk-based_organisations,_in_which_county_is_it_based?") instead.

    Schema:
    ${schema}

    User Question: "${userQuery}"
    SQL Query:`;

  return invokeBedrock(prompt, 0.0, SQL_MAX_TOKENS, { stage: "sql" });
}

/**
 * Regenerate SQL using the previous SQL and SQLite error as corrective context.
 * @param {string} userQuery
 * @param {string} previousSql
 * @param {string} sqliteError
 * @returns {Promise<string>}
 */
export async function regenerateSqlFromError(userQuery, previousSql, sqliteError) {
  const schema = readSchema();

  const prompt = `You are fixing a failed SQLite SELECT query.

    Return ONLY a corrected raw SQL SELECT query.

    Rules:
    - Only use SELECT statements. Never generate INSERT, UPDATE, DELETE, DROP, ALTER, or PRAGMA.
    - Use the provided schema exactly.
    - For list-style outputs (especially organisation names), use DISTINCT unless duplicates are explicitly requested.
    - The Directory contains duplicate entries: when counting organisations, use COUNT(DISTINCT org_name) rather than COUNT(*).
    - If you reference canonical alias columns (e.g. org_name, org_main_type, county), query FROM orgs_llm (not orgs).
    - Never select or filter on columns marked [EMPTY - no data].
    - Keep the corrected query semantically faithful to the original user question.

    Schema:
    ${schema}

    User Question: "${userQuery}"
    Previous SQL (failed): "${previousSql}"
    SQLite Error: "${sqliteError}"

    Corrected SQL Query:`;

  return invokeBedrock(prompt, 0.0, SQL_MAX_TOKENS, { stage: "repair" });
}

/**
 * Execute SQL against the SQLite directory and return row values only.
 * @param {string} sqlQuery
 * @returns {Promise<any[][]>}
 */
export async function queryDatabase(sqlQuery) {
  const db = await openDatabase(DB_PATH);

  try {
    const rows = await all(db, sqlQuery);
    return rows.map((row) => Object.values(row));
  } finally {
    await close(db);
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

    Natural Language Answer:`;

  return invokeBedrock(prompt, 0.3, ANSWER_MAX_TOKENS, { stage: "answer" });
}

/**
 * Build deterministic facts for cases where exactness should not depend on LLM generation.
 * @param {any[][]} rawResults
 * @returns {{ kind: "count", count: number } | { kind: "long_list", count: number, items: string[] } | null}
 */
function buildDeterministicFacts(rawResults) {
  if (!Array.isArray(rawResults) || rawResults.length === 0) return null;
  if (!rawResults.every((row) => Array.isArray(row) && row.length === 1)) return null;

  const values = rawResults.map((row) => row[0]);
  const allNumeric = values.every((value) => typeof value === "number");
  if (rawResults.length === 1 && allNumeric) {
    return { kind: "count", count: values[0] };
  }

  if (rawResults.length < LONG_LIST_THRESHOLD) return null;
  const items = values.map((value) => {
    if (value === null || value === undefined || String(value).trim() === "") return "(blank)";
    return String(value).trim();
  });
  return { kind: "long_list", count: rawResults.length, items };
}

/**
 * Generate a friendly wrapper around deterministic facts while preserving exactness.
 * @param {string} userQuery
 * @param {{ kind: "count", count: number } | { kind: "long_list", count: number, items: string[] }} deterministicFacts
 * @returns {Promise<string>}
 */
async function generateDeterministicWrappedAnswer(userQuery, deterministicFacts) {
  if (deterministicFacts.kind === "count") {
    const count = deterministicFacts.count;
    const prompt = `Write one concise, friendly sentence that answers the user's question.

Rules:
- You MUST keep the exact count as ${count}.
- Do not change the number or add uncertainty.
- Do not mention SQL or databases unless the user explicitly asked about them.
- The count reflects only organisations listed in the Retrofit Directory, which is NOT an exhaustive list of every retrofit organisation in the UK. If the user's question asks about the total number in the UK (or a wider population) as though the Directory were complete, make this clear and frame the count as applying only to Directory listings, e.g. "I can only tell you about the organisations listed in the Retrofit Directory; there are ${count} of these." If the user's question is specifically about the Directory itself, no such caveat is needed.
- Output only the final sentence for the end user (no preface, no labels, no quotes).

User question: "${userQuery}"
Exact count: ${count}
Sentence:`;

    const wrapped = (await invokeBedrock(prompt, 0.2, WRAPPER_MAX_TOKENS, { stage: "wrapper_count" }))
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .trim();
    const countPattern = new RegExp(`\\b${count}\\b`);
    if (countPattern.test(wrapped)) return wrapped;
    return `There are ${count} matching records.`;
  }

  const count = deterministicFacts.count;
  const prompt = `Write a short friendly introduction (1-2 sentences) for a list answer.

Rules:
- You MUST keep the exact count as ${count}.
- Mention that the full list follows.
- Do not include item names in the introduction.
- Do not mention SQL or databases unless the user explicitly asked about them.
- The list reflects only organisations listed in the Retrofit Directory, which is NOT an exhaustive list of every retrofit organisation in the UK. If the user's question asks for all organisations in the UK (or a wider population) as though the Directory were complete, make clear that the list covers only Directory listings. If the user's question is specifically about the Directory itself, no such caveat is needed.
- Output only the final introduction text for the end user (no preface like "Here is...", no labels, no quotes).

User question: "${userQuery}"
Exact count: ${count}
Introduction:`;

  const intro = (await invokeBedrock(prompt, 0.2, WRAPPER_MAX_TOKENS, { stage: "wrapper_list" }))
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^here(?:'s| is)\b[^:]*:\s*/i, "")
    .replace(/^introduction:\s*/i, "")
    .replace(/^sentence:\s*/i, "")
    .trim();
  const countPattern = new RegExp(`\\b${count}\\b`);
  const safeIntro = countPattern.test(intro)
    ? intro
    : `There are ${count} matching records. The full list is below.`;

  const lines = deterministicFacts.items.map((item, index) => `${index + 1}. ${item}`);
  return `${safeIntro}\n\n${lines.join("\n")}`;
}

// Validate that an LLM-generated SQL string is a safe SELECT-only statement.
/**
 * Guardrail: allow only SELECT statements before sending SQL to SQLite.
 * @param {string} sql
 * @returns {void}
 */
function validateSql(sql) {
  // Strip leading whitespace and block comments before checking the statement type.
  const stripped = sql.replace(/^(\s|\/\*.*?\*\/|--[^\n]*\n)*/s, '').trimStart();
  if (!/^SELECT\b/i.test(stripped)) {
    throw new UnsafeSqlError(sql.slice(0, 120));
  }
}

/**
 * Check whether generated SQL references canonical alias columns from orgs_llm.
 * @param {string} sql
 * @returns {boolean}
 */
function referencesCanonicalLlmColumns(sql) {
  return CANONICAL_LLM_COLUMNS.some((column) => {
    const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    return pattern.test(sql);
  });
}

/**
 * If canonical alias columns are used, make sure query targets orgs_llm.
 * @param {string} sql
 * @returns {string}
 */
function alignCanonicalColumnsToLlmView(sql) {
  if (!referencesCanonicalLlmColumns(sql)) return sql;
  if (/from\s+"?orgs_llm"?\b/i.test(sql)) return sql;
  return sql.replace(/\bfrom\s+"?orgs"?\b/i, "FROM orgs_llm");
}

/**
 * Add DISTINCT for simple organisation-name listing queries to suppress duplicate names.
 * @param {string} sql
 * @returns {string}
 */
function enforceDistinctForOrgNameLists(sql) {
  if (/\bselect\s+distinct\b/i.test(sql)) return sql;
  if (/\bcount\s*\(/i.test(sql)) return sql;
  if (!/\bselect\s+org_name\b/i.test(sql)) return sql;
  if (!/\bfrom\s+"?orgs_llm"?\b/i.test(sql)) return sql;
  return sql.replace(/\bselect\s+/i, "SELECT DISTINCT ");
}

// Catch errors from middleware (e.g. PayloadTooLarge from express.json) and return clean JSON.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = status === 413 ? 'Request body too large'
    : status < 500 ? err.message
      : 'Internal Server Error';
  res.status(status).json({ error: message });
});

/**
 * Extract the plain text of a chat message, tolerating both the user shape
 * (`content: [{ query }]`) and the assistant shape (`content: [{ text }]`).
 * @param {any} message
 * @returns {string}
 */
function extractMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block === "string" ? block : block?.query ?? block?.text ?? ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
      const text = extractMessageText(message);
      if (!text) return "";
      return `${message?.role === "assistant" ? "Assistant" : "User"}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
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
  const transcript = formatConversationTranscript(messages);
  if (!transcript) return lastUserMessage;

  const prompt = `Rewrite the user's latest question as a single standalone question about a directory of UK retrofit organisations.

    Rules:
    - Resolve pronouns and elliptical references (e.g. "and in Manchester?") using the conversation below.
    - Preserve the user's intent exactly; do not answer the question, add filters, or invent details.
    - If the latest question is already self-contained, return it unchanged.
    - Output ONLY the rewritten question on a single line, with no preface, labels, quotes, or explanation.

    Conversation so far:
    ${transcript}

    Latest question: "${lastUserMessage}"
    Standalone question:`;

  try {
    const reformulated = (await invokeBedrock(prompt, 0.0, REFORMULATE_MAX_TOKENS, {
      modelId: CHEAP_MODEL_ID,
      stage: "reformulate",
    }))
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!reformulated || reformulated.length > MAX_QUERY_LENGTH_WITH_CONTEXT) return lastUserMessage;
    return reformulated;
  } catch (error) {
    logAPICalls(`Reformulation failed, falling back to the original query: ${error?.message || error}`);
    return lastUserMessage;
  }
}

app.post('/api/query', async (req, res) => withUsageCapture(async () => {
  // Accumulated as the request progresses, then persisted once the response has
  // been sent. Token counts are gathered separately by the usage context.
  const logEntry = {
    rawQuery: '',
    reformulatedQuery: null,
    sqlQuery: null,
    rowCount: null,
    response: null,
    outcome: 'error',
  };

  // Send the response first, then persist. Logging must never add latency to,
  // or be able to fail, a user-facing request.
  const respondAndLog = async (payload) => {
    res.json(payload);
    await saveRequestLog(logEntry);
  };

  try {
    // Validate the request envelope before extracting the query, so that a
    // malformed body yields a 400 rather than a TypeError surfaced as a 500.
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Invalid request body: 'messages' must be a non-empty array" });
    }
    const lastContent = messages[messages.length - 1]?.content;
    if (!Array.isArray(lastContent) || lastContent.length === 0) {
      return res.status(400).json({ error: "Invalid request body: last message must have a non-empty 'content' array" });
    }
    let userQuery = lastContent[0]?.query;
    logAPICalls('Received query:', userQuery);

    // Validate input type and length before spending a model call on it.
    if (typeof userQuery !== 'string' || !userQuery.trim()) {
      return res.status(400).json({ error: "Missing or invalid 'query' in request body" });
    }
    if (userQuery.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({ error: `Query too long (max ${MAX_QUERY_LENGTH} characters)` });
    }
    logEntry.rawQuery = userQuery;

    // If there is previous context, reformulate the user's query to include it.
    if (messages.length > 1) {
      userQuery = await reformulateUserQueryToIncludePreviousContext(messages, userQuery);
      logEntry.reformulatedQuery = userQuery;
      logAPICalls('Reformulated query with context:', userQuery);
    }

    // Sanitise: strip characters that could break prompt string delimiters.
    const safeQuery = userQuery.replace(/["\\]/g, ' ').trim();

    const generatedSqlQuery = await generateSqlFromQuery(safeQuery);
    let sqlQuery = alignCanonicalColumnsToLlmView(generatedSqlQuery);
    sqlQuery = enforceDistinctForOrgNameLists(sqlQuery);
    logEntry.sqlQuery = sqlQuery;

    // Reject anything that isn't a SELECT before it touches the database.
    try {
      validateSql(sqlQuery);
    } catch (error) {
      if (error instanceof UnsafeSqlError) {
        logAPICalls('Out-of-scope or non-SQL query response:', { safeQuery, generatedSqlQuery });
        logEntry.outcome = 'out_of_scope';
        logEntry.response = OUT_OF_SCOPE_RESPONSE;
        return respondAndLog({
          response: OUT_OF_SCOPE_RESPONSE,
          sources: [{ name: "Retrofit Directory", url: "https://retrofit-directory.org.uk" }],
        });
      }
      throw error;
    }

    let repaired = false;
    let rawResults;
    try {
      rawResults = await queryDatabase(sqlQuery);
    } catch (dbError) {
      const sqliteErrorText = dbError?.message || String(dbError);
      const repairedSql = await regenerateSqlFromError(safeQuery, sqlQuery, sqliteErrorText);
      sqlQuery = alignCanonicalColumnsToLlmView(repairedSql);
      sqlQuery = enforceDistinctForOrgNameLists(sqlQuery);
      logEntry.sqlQuery = sqlQuery;
      try {
        validateSql(sqlQuery);
      } catch (error) {
        if (error instanceof UnsafeSqlError) {
          logAPICalls('Out-of-scope after SQL repair attempt:', { safeQuery, repairedSql });
          logEntry.outcome = 'out_of_scope';
          logEntry.response = OUT_OF_SCOPE_RESPONSE;
          return respondAndLog({
            response: OUT_OF_SCOPE_RESPONSE,
            sources: [{ name: "Retrofit Directory", url: "https://retrofit-directory.org.uk" }],
          });
        }
        throw error;
      }
      rawResults = await queryDatabase(sqlQuery);
      repaired = true;
      logAPICalls('Query repaired after initial SQLite error:', { safeQuery, sqliteErrorText, repairedSql: sqlQuery });
    }
    const deterministicFacts = buildDeterministicFacts(rawResults);
    const answer = deterministicFacts
      ? await generateDeterministicWrappedAnswer(safeQuery, deterministicFacts)
      : await generateNaturalLanguageAnswer(safeQuery, sqlQuery, rawResults);

    // Return only the natural-language answer; SQL and raw rows are logged server-side only.
    logAPICalls('Query processed:', { safeQuery, sqlQuery, rowCount: rawResults.length, SQLresults: rawResults });

    logEntry.rowCount = rawResults.length;
    logEntry.response = answer;
    logEntry.outcome = repaired ? 'repaired' : 'ok';

    /* Don't bother to send the source since so far the only source is the Directory.  Later, when we add more sources, we'll reinstate this */
    //    res.json({ response: answer, sources: [{ name: "Retrofit Directory", url: "https://retrofit-directory.org.uk" }] });
    await respondAndLog({ response: answer, sources: [] })
  } catch (error) {
    console.error('Error processing query:', error);
    res.status(500).json({ error: 'Internal Server Error' });
    // Only log failures that got far enough to have a question attached.
    if (logEntry.rawQuery) {
      logEntry.outcome = 'error';
      logEntry.response = error?.message || String(error);
      await saveRequestLog(logEntry);
    }
  }
}));

app.post('/api/observe', async (req, res) => {
  try {
    // `includeRecent` will drive the scrollable query/response list on
    // admin.html; token totals are always present.
    const summary = await getUsageSummary({
      includeRecent: req.body?.includeRecent === true,
      recentLimit: req.body?.recentLimit,
    });
    res.json(summary)
  } catch (error) {
    console.error('Error building usage summary:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * time stamp and output message to console
 * @param {string} message
 * @param {...unknown} details Optional extra values to log alongside the message.
 */
function logAPICalls(message, ...details) {
  if (!VERBOSE) return;
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}] ${message}`, ...details);
}
