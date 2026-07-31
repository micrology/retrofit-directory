import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import express from 'express'
import cors from 'cors'
import { createHttpTerminator } from 'http-terminator'
import rateLimit from 'express-rate-limit'
/**
 * HTTP API for natural-language querying over the retrofit SQLite directory.
 * It uses Bedrock-hosted models to generate SQL and natural-language answers.
 */

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "directory.db");
const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "directory.schema");
const BEDROCK_REGION = "eu-west-2";
const BEDROCK_MODEL_ID = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const CHEAP_MODEL_ID = "qwen.qwen3-235b-a22b-2507-v1:0";
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
 * Invoke the configured Bedrock model with a single user prompt.
 * @param {string} prompt
 * @param {number} temperature
 * @returns {Promise<string>}
 */
async function invokeBedrock(prompt, temperature) {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 300,
    temperature,
    messages: [{ role: "user", content: prompt }],
  });

  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body,
    })
  );

  const responseBody = JSON.parse(new TextDecoder("utf-8").decode(response.body));
  return responseBody.content[0].text.trim();
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
    - If the user asks for a count, use COUNT(*).
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

  return invokeBedrock(prompt, 0.0);
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
    - If you reference canonical alias columns (e.g. org_name, org_main_type, county), query FROM orgs_llm (not orgs).
    - Never select or filter on columns marked [EMPTY - no data].
    - Keep the corrected query semantically faithful to the original user question.

    Schema:
    ${schema}

    User Question: "${userQuery}"
    Previous SQL (failed): "${previousSql}"
    SQLite Error: "${sqliteError}"

    Corrected SQL Query:`;

  return invokeBedrock(prompt, 0.0);
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

    User Question: "${userQuery}"
    SQL Query Used: "${sqlQuery}"
    Raw Database Results: ${JSON.stringify(rawResults)}

    Natural Language Answer:`;

  return invokeBedrock(prompt, 0.3);
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

// Catch errors from middleware (e.g. PayloadTooLarge from express.json) and return clean JSON.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = status === 413 ? 'Request body too large'
    : status < 500 ? err.message
    : 'Internal Server Error';
  res.status(status).json({ error: message });
});

app.post('/api/query', async (req, res) => {
  try {
    const { messages } = req.body
    const userQuery = messages[messages.length-1].content[0].query
console.log('Received query:', userQuery)
    // Validate input type and length.
    if (typeof userQuery !== 'string' || !userQuery.trim()) {
      return res.status(400).json({ error: "Missing or invalid 'query' in request body" });
    }
    if (userQuery.length > 500) {
      return res.status(400).json({ error: "Query too long (max 500 characters)" });
    }

    // Sanitise: strip characters that could break prompt string delimiters.
    const safeQuery = userQuery.replace(/["\\]/g, ' ').trim();

    const generatedSqlQuery = await generateSqlFromQuery(safeQuery);
    let sqlQuery = alignCanonicalColumnsToLlmView(generatedSqlQuery);

    // Reject anything that isn't a SELECT before it touches the database.
    try {
      validateSql(sqlQuery);
    } catch (error) {
      if (error instanceof UnsafeSqlError) {
        console.log('Out-of-scope or non-SQL query response:', { safeQuery, generatedSqlQuery });
        return res.json({
          response: OUT_OF_SCOPE_RESPONSE,
          sources: [{ name: "Retrofit Directory", url: "https://retrofit-directory.org.uk" }],
        });
      }
      throw error;
    }

    let rawResults;
    try {
      rawResults = await queryDatabase(sqlQuery);
    } catch (dbError) {
      const sqliteErrorText = dbError?.message || String(dbError);
      const repairedSql = await regenerateSqlFromError(safeQuery, sqlQuery, sqliteErrorText);
      sqlQuery = alignCanonicalColumnsToLlmView(repairedSql);
      try {
        validateSql(sqlQuery);
      } catch (error) {
        if (error instanceof UnsafeSqlError) {
          console.log('Out-of-scope after SQL repair attempt:', { safeQuery, repairedSql });
          return res.json({
            response: OUT_OF_SCOPE_RESPONSE,
            sources: [{ name: "Retrofit Directory", url: "https://retrofit-directory.org.uk" }],
          });
        }
        throw error;
      }
      rawResults = await queryDatabase(sqlQuery);
      console.log('Query repaired after initial SQLite error:', { safeQuery, sqliteErrorText, repairedSql: sqlQuery });
    }
    const answer = await generateNaturalLanguageAnswer(safeQuery, sqlQuery, rawResults);

    // Return only the natural-language answer; SQL and raw rows are logged server-side only.
    console.log('Query processed:', { safeQuery, sqlQuery, rowCount: rawResults.length });

    /* Don't bother to send the source since so far the only source is the Dircetory.  Later, when we add more sources, we'll reinstate this */
    //    res.json({ response: answer, sources: [{ name: "Retrofit Directory", url: "https://retrofit-directory.org.uk" }] });
    res.json({ response: answer, sources: [] })
  } catch (error) {
    console.error('Error processing query:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
