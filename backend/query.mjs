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

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "directory.db");
const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "directory.schema");
const BEDROCK_REGION = "eu-west-2";
const BEDROCK_MODEL_ID = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const CHEAP_MODEL_ID = "qwen.qwen3-235b-a22b-2507-v1:0";

process.title = 'retrofit-query-server'

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

const app = express()
const PORT = process.env.PORT || 5001

app.set('trust proxy', 1) // trust first proxy, if behind a proxy
app.use(cors({ origin: ['https://retrofit-directory.org.uk', 'https://www.retrofit-directory.org.uk'] }))
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
async function start() {
  // Start the server
  server = app.listen(PORT, '127.0.0.1', () => {
    console.log(
      `Proxy server running on http://localhost:${PORT}, usingmodels ${BEDROCK_MODEL_ID} and ${CHEAP_MODEL_ID} in ${BEDROCK_REGION} region`,
    )
  })
  httpTerminator = createHttpTerminator({ server })
}
start()

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

export async function generateSqlFromQuery(userQuery) {
  const schema = readSchema();

  const prompt = `You are an expert SQLite data analyst. Your job is to convert a user's natural language question into a valid, safe SQLite SELECT query based on the provided schema.

    This database is a survey export: column names are the full survey question text, and each column annotation shows how many rows are populated plus example values.

    Rules:
    - Return ONLY the raw SQL query. Do not include markdown formatting (like \`\`\`sql), code blocks, or explanatory text.
    - Only use SELECT statements. Never generate INSERT, UPDATE, DELETE, or DROP statements.
    - Use case-insensitive matching where appropriate (e.g., LIKE '%Manchester%') for text filters.
    - If the user asks for a count, use COUNT(*).
    - Never select or filter on columns marked [EMPTY - no data]; they contain no values. For example, an organisation's "name" is the answer to the "name of the organisation" question column, NOT the empty recipient_first_name/recipient_last_name metadata columns.
    - Use the example values to map the user's terms to the correct column and its stored values. For multi-select questions, a populated cell (e.g. 'Directly'/'Indirectly') means the option was chosen; filter with "col" IS NOT NULL AND TRIM("col") != '' rather than assuming a 'Yes' value.
    - IMPORTANT: location_latitude/location_longitude are the survey respondent's IP-based geolocation at submission time, NOT the organisation's location. Do not use them for distance/proximity questions - they are unreliable and often disagree with the organisation's actual location. For any location or proximity question, use the self-reported county column ("for_uk-based_organisations,_in_which_county_is_it_based?") instead.

    Schema:
    ${schema}

    User Question: "${userQuery}"
    SQL Query:`;

  return invokeBedrock(prompt, 0.0);
}

export async function queryDatabase(sqlQuery) {
  const db = await openDatabase(DB_PATH);

  try {
    const rows = await all(db, sqlQuery);
    return rows.map((row) => Object.values(row));
  } finally {
    await close(db);
  }
}

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
function validateSql(sql) {
  // Strip leading whitespace and block comments before checking the statement type.
  const stripped = sql.replace(/^(\s|\/\*.*?\*\/|--[^\n]*\n)*/s, '').trimStart();
  if (!/^SELECT\b/i.test(stripped)) {
    throw new Error(`Unsafe or unexpected SQL generated: ${sql.slice(0, 120)}`);
  }
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
    const userQuery = req.body.query;

    // Validate input type and length.
    if (typeof userQuery !== 'string' || !userQuery.trim()) {
      return res.status(400).json({ error: "Missing or invalid 'query' in request body" });
    }
    if (userQuery.length > 500) {
      return res.status(400).json({ error: "Query too long (max 500 characters)" });
    }

    // Sanitise: strip characters that could break prompt string delimiters.
    const safeQuery = userQuery.replace(/["\\]/g, ' ').trim();

    const sqlQuery = await generateSqlFromQuery(safeQuery);

    // Reject anything that isn't a SELECT before it touches the database.
    validateSql(sqlQuery);

    const rawResults = await queryDatabase(sqlQuery);
    const answer = await generateNaturalLanguageAnswer(safeQuery, sqlQuery, rawResults);

    // Return only the natural-language answer; SQL and raw rows are logged server-side only.
    console.log('Query processed:', { safeQuery, sqlQuery, rowCount: rawResults.length });
    res.json({ answer });
  } catch (error) {
    console.error('Error processing query:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
