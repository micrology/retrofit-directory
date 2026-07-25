import sqlite3
import pandas as pd

# Load your spreadsheet
df = pd.read_csv("directory.csv", header=1, skiprows=[2])  # Adjust header and skiprows as needed

# Clean column names (remove spaces, special characters)
df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

# Save to SQLite
conn = sqlite3.connect("directory.db")
df.to_sql("orgs", conn, if_exists="replace", index=False)
conn.close()