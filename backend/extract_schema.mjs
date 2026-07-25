import sqlite3 from "sqlite3";

function all(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
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

export async function getDatabaseSchema(dbPath) {
  const db = await openDatabase(dbPath);

  try {
    const tables = await all(db, "SELECT name FROM sqlite_master WHERE type='table';");
    const schemaLines = [];

    for (const table of tables) {
      const tableName = table.name;
      schemaLines.push(`Table name: ${tableName}`);
      schemaLines.push("Columns:");

      const safeTableName = tableName.replace(/'/g, "''");
      const columns = await all(db, `PRAGMA table_info('${safeTableName}');`);

      for (const col of columns) {
        const colType = col.type || "TEXT";
        schemaLines.push(`  - ${col.name} (${colType})`);
      }

      schemaLines.push("");
    }

    return schemaLines.join("\n");
  } finally {
    await close(db);
  }
}

// --- Example Usage ---
const dbFile = "directory.db";
const extractedSchema = await getDatabaseSchema(dbFile);
console.log(extractedSchema);
