import sqlite3
import json
import boto3

# Initialize Bedrock client (adjust region as needed)
bedrock = boto3.client(service_name="bedrock-runtime", region_name="eu-west-2")

def get_database_schema(db_path: str, sample_values: int = 3) -> str:
  """Connects to the SQLite database and dynamically extracts an enriched schema.

  For each column we include the declared type, how many rows are actually
  populated (non-null / non-empty), and a few representative sample values.
  This extra context is essential for natural-language-to-SQL over survey
  exports, where column names are full question text and many metadata
  columns are entirely empty.
  """
  conn = sqlite3.connect(db_path)
  cursor = conn.cursor()

  # Get a list of all tables in the database
  cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
  tables = cursor.fetchall()

  schema_lines = []

  for table_tuple in tables:
    table_name = table_tuple[0]

    cursor.execute(f'SELECT COUNT(*) FROM "{table_name}";')
    total_rows = cursor.fetchone()[0]

    schema_lines.append(f"Table name: {table_name} ({total_rows} rows)")
    schema_lines.append("Columns:")

    # Fetch column details for each table
    cursor.execute(f"PRAGMA table_info('{table_name}');")
    columns = cursor.fetchall()

    for col in columns:
      col_id, col_name, col_type, not_null, default_val, pk = col
      # Format type neatly; default to TEXT if empty
      col_type_str = col_type if col_type else "TEXT"

      # Count populated rows (non-null and non-empty-string).
      cursor.execute(
          f'SELECT COUNT(*) FROM "{table_name}" '
          f'WHERE "{col_name}" IS NOT NULL AND TRIM(CAST("{col_name}" AS TEXT)) != \'\';'
      )
      populated = cursor.fetchone()[0]

      if populated == 0:
        # Flag empty columns so the model avoids selecting them.
        schema_lines.append(f"  - {col_name} ({col_type_str}) [EMPTY - no data]")
        continue

      # Gather a few distinct sample values to reveal how the column is used.
      cursor.execute(
          f'SELECT DISTINCT "{col_name}" FROM "{table_name}" '
          f'WHERE "{col_name}" IS NOT NULL AND TRIM(CAST("{col_name}" AS TEXT)) != \'\' '
          f'LIMIT {sample_values};'
      )
      samples = [str(r[0]).replace("\n", " ").strip() for r in cursor.fetchall()]
      # Truncate long free-text samples for readability.
      samples = [(s[:60] + "...") if len(s) > 60 else s for s in samples]
      sample_str = "; ".join(samples)

      schema_lines.append(
          f"  - {col_name} ({col_type_str}) "
          f"[{populated}/{total_rows} populated] e.g. {sample_str}"
      )

    schema_lines.append("")  # Blank line between tables

  conn.close()
  return "\n".join(schema_lines)

def generate_sql_from_query(user_query: str) -> str:
  # Dynamically fetch the latest schema directly from your SQLite file
  schema = get_database_schema("directory.db")

  prompt = f"""You are an expert SQLite data analyst. Your job is to convert a user's natural language question into a valid, safe SQLite SELECT query based on the provided schema.

    This database is a survey export: column names are the full survey question text, and each column annotation shows how many rows are populated plus example values.

    Rules:
    - Return ONLY the raw SQL query. Do not include markdown formatting (like ```sql), code blocks, or explanatory text.
    - Only use SELECT statements. Never generate INSERT, UPDATE, DELETE, or DROP statements.
    - Use case-insensitive matching where appropriate (e.g., LIKE '%Manchester%') for text filters.
    - If the user asks for a count, use COUNT(*).
    - Never select or filter on columns marked [EMPTY - no data]; they contain no values. For example, an organisation's "name" is the answer to the "name of the organisation" question column, NOT the empty recipient_first_name/recipient_last_name metadata columns.
    - Use the example values to map the user's terms to the correct column and its stored values. For multi-select questions, a populated cell (e.g. 'Directly'/'Indirectly') means the option was chosen; filter with "col" IS NOT NULL AND TRIM("col") != '' rather than assuming a 'Yes' value.
    - IMPORTANT: location_latitude/location_longitude are the survey respondent's IP-based geolocation at submission time, NOT the organisation's location. Do not use them for distance/proximity questions - they are unreliable and often disagree with the organisation's actual location. For any location or proximity question, use the self-reported county column ("for_uk-based_organisations,_in_which_county_is_it_based?") instead.

    Schema:
    {schema}

    User Question: "{user_query}"
    SQL Query:"""

  body = json.dumps({
      "anthropic_version": "bedrock-2023-05-31",
      "max_tokens": 300,
      "temperature": 0.0,
      "messages": [{"role": "user", "content": prompt}],
  })

  response = bedrock.invoke_model(
      modelId="eu.anthropic.claude-haiku-4-5-20251001-v1:0", body=body
  )

  response_body = json.loads(response["body"].read())
  return response_body["content"][0]["text"].strip()

def query_database(sql_query):
  conn = sqlite3.connect("directory.db")
  cursor = conn.cursor()
  cursor.execute(sql_query)
  results = cursor.fetchall()
  conn.close()
  return results

def generate_natural_language_answer(
    user_query: str, sql_query: str, raw_results: list
) -> str:
  """Takes the user query, SQL query, and raw DB results and generates a natural language response."""

  prompt = f"""You are a helpful assistant for a public retrofit organisation database. 
    A user asked a question, a SQL query was run against the database, and raw results were returned.
    Your job is to write a clear, concise, and natural language response answering the user's question based on the data provided.

    Rules:
    - Be polite and conversational.
    - If the result is a count (e.g., a number), state it clearly (e.g., "There are 4 organisations...").
    - If the result is a list of names/records, list them nicely.
    - If the results are empty, politely state that no matching records were found.
    - Do not mention SQL or technical database details in your response.

    User Question: "{user_query}"
    SQL Query Used: "{sql_query}"
    Raw Database Results: {raw_results}

    Natural Language Answer:"""

  body = json.dumps({
      "anthropic_version": "bedrock-2023-05-31",
      "max_tokens": 300,
      "temperature": 0.3,  # Slight temperature for a natural, human-like tone
      "messages": [{"role": "user", "content": prompt}],
  })

  response = bedrock.invoke_model(
      modelId="eu.anthropic.claude-haiku-4-5-20251001-v1:0", body=body
  )

  response_body = json.loads(response["body"].read())
  return response_body["content"][0]["text"].strip()

# --- Example End-to-End Execution ---
print(f"Enter your natural language query:")
user_input = input()

# Step 1: Generate the SQL
sql = generate_sql_from_query(user_input)
print(f"Generated SQL: {sql}")

# Step 2: Run it against your SQLite database
raw_results = query_database(sql)
print(f"Raw Results: {raw_results}")

# Step 3: Generate a natural language answer
answer = generate_natural_language_answer(user_input, sql, raw_results)
print(f"Natural Language Answer: {answer}")