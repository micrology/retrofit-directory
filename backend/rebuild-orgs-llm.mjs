/**
 * Rebuild `orgs_llm` and schema files against an existing directory.db
 * without re-importing the Qualtrics export.
 *
 * Usage:
 *   cd backend
 *   node rebuild-orgs-llm.mjs
 *   node rebuild-orgs-llm.mjs path/to/directory.db
 *
 * Writes:
 *   directory.schema            — full (orgs + orgs_llm)
 *   directory.schema.canonical  — orgs_llm only (default text-to-SQL prompt)
 *
 * @license MIT
 * Copyright (c) 2025–2026 Nigel Gilbert and contributors
 * University of Surrey — INHABIT / National Retrofit Hub
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sqlite3 from 'sqlite3'
import {
  CANONICAL_SCHEMA_PATH,
  SCHEMA_PATH,
  recreateOrgsLlmView,
  writeSchemaFiles,
} from './lib/orgsLlmView.mjs'

const DB_PATH =
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'directory.db')

/**
 * @param {import('sqlite3').Database} db
 * @param {string} sql
 * @param {unknown[]} [params]
 */
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err)
      else resolve(this)
    })
  })
}

/**
 * @param {import('sqlite3').Database} db
 * @param {string} sql
 */
function all(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)))
  })
}

/**
 * @param {import('sqlite3').Database} db
 */
function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()))
  })
}

async function main() {
  const db = await new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, (err) =>
      err ? reject(err) : resolve(handle)
    )
  })

  try {
    const mappings = await recreateOrgsLlmView(db, { run, all })
    const { full, canonical } = await writeSchemaFiles(db, { all })
    console.log(`Rebuilt orgs_llm on ${DB_PATH}`)
    console.log(`Aliases: ${mappings.length}`)
    console.log(`Full schema (${full.length} chars): ${SCHEMA_PATH}`)
    console.log(`Canonical schema (${canonical.length} chars): ${CANONICAL_SCHEMA_PATH}`)
    console.log('Sample aliases:', mappings.map((m) => m.alias).slice(0, 12).join(', '), '…')
  } finally {
    await close(db)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
