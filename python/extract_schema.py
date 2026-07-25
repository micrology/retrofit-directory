import sqlite3


def get_database_schema(db_path: str) -> str:
  """Connects to the SQLite database and dynamically extracts the schema for all tables."""
  conn = sqlite3.connect(db_path)
  cursor = conn.cursor()

  # Get a list of all tables in the database
  cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
  tables = cursor.fetchall()

  schema_lines = []

  for table_tuple in tables:
    table_name = table_tuple[0]
    schema_lines.append(f"Table name: {table_name}")
    schema_lines.append("Columns:")

    # Fetch column details for each table
    cursor.execute(f"PRAGMA table_info('{table_name}');")
    columns = cursor.fetchall()

    for col in columns:
      col_id, col_name, col_type, not_null, default_val, pk = col
      # Format type neatly; default to TEXT if empty
      col_type_str = col_type if col_type else "TEXT"
      schema_lines.append(f"  - {col_name} ({col_type_str})")

    schema_lines.append("")  # Blank line between tables

  conn.close()
  return "\n".join(schema_lines)


# --- Example Usage ---
db_file = "directory.db"
extracted_schema = get_database_schema(db_file)
print(extracted_schema)