import sqlite3 from "sqlite3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DB_PATH = "directory.db";
const BEDROCK_REGION = "eu-west-2";
const BEDROCK_MODEL_ID = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

function openDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
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

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
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

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}

function quoteStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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

export async function getDatabaseSchema(dbPath, sampleValues = 3) {
  const db = await openDatabase(dbPath);

  try {
    const tables = await all(db, "SELECT name FROM sqlite_master WHERE type='table';");
    const schemaLines = [];

    for (const table of tables) {
      const tableName = table.name;
      const quotedTableName = quoteIdentifier(tableName);
      const safeTableNameLiteral = quoteStringLiteral(tableName);

      const countRow = await get(db, `SELECT COUNT(*) AS count FROM ${quotedTableName};`);
      const totalRows = countRow.count;

      schemaLines.push(`Table name: ${tableName} (${totalRows} rows)`);
      schemaLines.push("Columns:");

      const columns = await all(db, `PRAGMA table_info(${safeTableNameLiteral});`);

      for (const col of columns) {
        const colName = col.name;
        const colType = col.type || "TEXT";
        const quotedColumnName = quoteIdentifier(colName);

        const populatedRow = await get(
          db,
          `SELECT COUNT(*) AS count FROM ${quotedTableName} ` +
            `WHERE ${quotedColumnName} IS NOT NULL AND TRIM(CAST(${quotedColumnName} AS TEXT)) != '';`
        );
        const populated = populatedRow.count;

        if (populated === 0) {
          schemaLines.push(`  - ${colName} (${colType}) [EMPTY - no data]`);
          continue;
        }

        const samples = await all(
          db,
          `SELECT DISTINCT ${quotedColumnName} AS value FROM ${quotedTableName} ` +
            `WHERE ${quotedColumnName} IS NOT NULL AND TRIM(CAST(${quotedColumnName} AS TEXT)) != '' ` +
            `LIMIT ${sampleValues};`
        );

        const sampleValuesText = samples
          .map((row) => String(row.value).replace(/\n/g, " ").trim())
          .map((value) => (value.length > 60 ? `${value.slice(0, 60)}...` : value))
          .join("; ");

        schemaLines.push(
          `  - ${colName} (${colType}) [${populated}/${totalRows} populated] e.g. ${sampleValuesText}`
        );
      }

      schemaLines.push("");
    }

    return schemaLines.join("\n");
  } finally {
    await close(db);
  }
}

export async function generateSqlFromQuery(userQuery) {
  const schema = await getDatabaseSchema(DB_PATH);

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

async function main() {
  console.log("Enter your natural language query:");
  const rl = createInterface({ input, output });
  const userInput = await rl.question("");
  rl.close();

  const sql = await generateSqlFromQuery(userInput);
  console.log(`Generated SQL: ${sql}`);

  const rawResults = await queryDatabase(sql);
  console.log(`Raw Results: ${JSON.stringify(rawResults)}`);

  const answer = await generateNaturalLanguageAnswer(userInput, sql, rawResults);
  console.log(`Natural Language Answer: ${answer}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
