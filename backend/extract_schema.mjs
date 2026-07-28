import sqlite3 from "sqlite3";
/**
 * Utility script for extracting a readable schema summary from SQLite.
 */

/**
 * Promise-based wrapper around sqlite3 `db.all`.
 * @param {sqlite3.Database} db
 * @param {string} sql
 * @returns {Promise<any[]>}
 */
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
 * Open a SQLite database from path.
 * @param {string} dbPath
 * @returns {Promise<sqlite3.Database>}
 */
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

/**
 * Return a formatted schema summary for all tables/columns in the database.
 * @param {string} dbPath
 * @returns {Promise<string>}
 */
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

// --- Example usage when invoked directly ---
const dbFile = "directory.db";
const extractedSchema = await getDatabaseSchema(dbFile);
console.log(extractedSchema);
