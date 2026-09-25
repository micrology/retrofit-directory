/**
 * Canonical `orgs_llm` view mappings and schema text for text-to-SQL.
 *
 * Kept separate from csvToDB.mjs so the view can be rebuilt against an existing
 * directory.db (without re-importing the survey) and so query.mjs can load a
 * slim canonical schema by default.
 *
 * Library module. Used by:
 *   csvToDB.mjs           — create view + write schema files on import
 *   rebuild-orgs-llm.mjs  — refresh view/schema on an existing DB
 *   query.mjs             — optional runtime consumers of schema helpers
 *
 * @license MIT
 * Copyright (c) 2025–2026 Nigel Gilbert and contributors
 * University of Surrey — INHABIT / National Retrofit Hub
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENRICHMENT_COLUMNS } from './geoPostcodes.mjs'

export const LLM_VIEW_NAME = 'orgs_llm'
export const TABLE_NAME = 'orgs'
const SCHEMA_EXAMPLE_LIMIT = 3

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_ROOT = path.join(MODULE_DIR, '..')
export const SCHEMA_PATH = path.join(BACKEND_ROOT, 'directory.schema')
export const CANONICAL_SCHEMA_PATH = path.join(BACKEND_ROOT, 'directory.schema.canonical')

/**
 * Ordered list of canonical alias names exposed on orgs_llm.
 * Keep in sync with buildLlmViewMappings aliases (order may differ if a source
 * column is missing on an older export).
 */
export const CANONICAL_LLM_COLUMNS = [
  'org_name',
  'department_or_unit',
  'org_main_type',
  'org_type_other_public',
  'org_type_other_private',
  'org_type_other_nonprofit',
  'county',
  'postcode',
  'local_authority',
  'parish',
  'hq_latitude',
  'hq_longitude',
  'geographic_scope',
  'countries',
  'operating_areas',
  'operating_areas_other',
  'main_mission_or_remit',
  'retrofit_relevance',
  'primary_activity',
  'primary_activity_other',
  'other_activities',
  'other_activities_other',
  'specialisms',
  'specialisms_other',
  'methods_or_skills',
  'methods_or_skills_other',
  'works_with_fuel_poverty',
  'works_with_health_housing',
  'works_with_inequalities',
  'works_with_tenants_associations',
  'works_with_community_groups',
  'works_with_general_public',
  'works_with_local_authorities',
  'works_with_central_government',
  'works_with_regulators',
  'works_with_funders',
  'works_with_social_housing',
  'works_with_housing_associations',
  'works_with_private_housing',
  'works_with_developers_installers',
  'works_with_product_suppliers',
  'works_with_architects',
  'works_with_building_managers',
  'works_with_researchers',
  'works_with_network_convenors',
  'works_with_consultants',
  'works_with_other_audiences',
  'works_with_other_audiences_text',
  'schemes_delivered',
  'schemes_la_finance_detail',
  'schemes_other_detail',
  'website',
  'contact_email',
  'employee_count_band',
]

/**
 * Normalize text for fuzzy semantic token matching.
 * @param {string} value
 * @returns {string}
 */
export function normalizeForMatch(value) {
  return String(value)
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Find the first matching column by semantic tokens.
 * @param {string[]} columns
 * @param {string[]} requiredTokens
 * @returns {string | null}
 */
export function findColumnByTokens(columns, requiredTokens) {
  for (const column of columns) {
    const normalized = normalizeForMatch(column)
    if (requiredTokens.every((token) => normalized.includes(token))) {
      return column
    }
  }
  return null
}

/**
 * Safely quote a SQLite identifier.
 * @param {unknown} identifier
 * @returns {string}
 */
export function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

/**
 * Build canonical alias mappings for the LLM-facing SQL view.
 * @param {string[]} columns
 * @returns {Array<{ alias: string, source: string }>}
 */
export function buildLlmViewMappings(columns) {
  const mappings = []
  /** @type {Set<string>} */
  const usedSources = new Set()

  /**
   * Register an alias if a source column matching `tokens` exists and is unused.
   * @param {string} alias
   * @param {string[]} tokens
   * @returns {void}
   */
  const addMapping = (alias, tokens) => {
    const source = findColumnByTokens(columns, tokens)
    if (!source || usedSources.has(source)) return
    usedSources.add(source)
    mappings.push({ alias, source })
  }

  addMapping('org_name', ['name', 'organisation', 'wish', 'add', 'directory'])
  addMapping('department_or_unit', ['department', 'team', 'unit', 'directory'])
  addMapping('org_main_type', ['main', 'type', 'selected', 'choice'])
  addMapping('org_type_other_public', ['main', 'type', 'other', 'public', 'body', 'text'])
  addMapping('org_type_other_private', ['main', 'type', 'other', 'private', 'company', 'text'])
  addMapping('org_type_other_nonprofit', ['main', 'type', 'other', 'nonprofit', 'text'])
  addMapping('county', ['ukbased', 'county', 'based'])
  addMapping('postcode', ['postcode', 'organisation', 'headquarters'])

  for (const { name } of ENRICHMENT_COLUMNS) {
    if (columns.includes(name) && !usedSources.has(name)) {
      usedSources.add(name)
      mappings.push({ alias: name, source: name })
    }
  }

  addMapping('geographic_scope', ['geographic', 'scope', 'cover'])
  addMapping('countries', ['list', 'of', 'countries'])
  addMapping('operating_areas', ['geographic', 'areas', 'operating', 'selected', 'choice'])
  addMapping('operating_areas_other', ['geographic', 'areas', 'operating', 'other', 'please', 'specify', 'text'])
  addMapping('main_mission_or_remit', ['main', 'mission', 'remit', 'organisation'])
  addMapping('retrofit_relevance', ['work', 'relevant', 'retrofit'])
  addMapping('primary_activity', ['primary', 'activity', 'selected', 'choice'])
  addMapping('primary_activity_other', ['primary', 'activity', 'none', 'above', 'other', 'text'])
  addMapping('other_activities', ['other', 'activities', 'carry', 'out', 'selected', 'choice'])
  addMapping('other_activities_other', ['other', 'activities', 'carry', 'out', 'none', 'above', 'text'])
  addMapping('specialisms', ['areas', 'specialism', 'selected', 'choice'])
  addMapping('specialisms_other', ['areas', 'specialism', 'none', 'above', 'text'])
  addMapping('methods_or_skills', ['methods', 'technical', 'skills', 'selected', 'choice'])
  addMapping('methods_or_skills_other', ['methods', 'technical', 'skills', 'none', 'above', 'text'])

  // Audience multi-selects (Directly / Indirectly when populated).
  addMapping('works_with_fuel_poverty', ['work', 'with', 'fuel', 'poverty'])
  addMapping('works_with_health_housing', ['work', 'with', 'health', 'conditions', 'housing'])
  addMapping('works_with_inequalities', ['work', 'with', 'inequalities', 'vulnerabilities'])
  addMapping('works_with_tenants_associations', ['work', 'with', 'tenants', 'residents', 'associations'])
  addMapping('works_with_community_groups', ['work', 'with', 'community', 'groups'])
  addMapping('works_with_general_public', ['work', 'with', 'general', 'public'])
  addMapping('works_with_local_authorities', ['work', 'with', 'local', 'combined', 'authority'])
  addMapping('works_with_central_government', ['work', 'with', 'central', 'government'])
  addMapping('works_with_regulators', ['work', 'with', 'regulators', 'standards'])
  addMapping('works_with_funders', ['work', 'with', 'funders', 'investors', 'grant'])
  addMapping('works_with_social_housing', ['work', 'with', 'social', 'housing', 'providers'])
  addMapping('works_with_housing_associations', ['work', 'with', 'housing', 'associations', 'nonprofit'])
  addMapping('works_with_private_housing', ['work', 'with', 'private', 'housing', 'landlords'])
  addMapping('works_with_developers_installers', [
    'work',
    'with',
    'developers',
    'builders',
    'contractors',
    'installers',
  ])
  addMapping('works_with_product_suppliers', [
    'work',
    'with',
    'product',
    'developers',
    'manufacturers',
    'suppliers',
  ])
  addMapping('works_with_architects', [
    'work',
    'with',
    'architects',
    'engineers',
    'design',
    'professionals',
  ])
  addMapping('works_with_building_managers', ['work', 'with', 'building', 'facilities', 'managers'])
  addMapping('works_with_researchers', ['work', 'with', 'researchers'])
  addMapping('works_with_network_convenors', ['work', 'with', 'network', 'convenors'])
  addMapping('works_with_consultants', ['work', 'with', 'consultants', 'advisors'])
  addMapping('works_with_other_audiences', ['work', 'with', 'other', 'groups', 'audiences', 'please', 'specify'])
  addMapping('works_with_other_audiences_text', [
    'work',
    'with',
    'other',
    'groups',
    'audiences',
    'please',
    'specify',
    'text',
  ])

  addMapping('schemes_delivered', ['managed', 'delivery', 'local', 'initiatives', 'funded', 'selected', 'choice'])
  addMapping('schemes_la_finance_detail', [
    'managed',
    'delivery',
    'local',
    'authority',
    'finance',
    'fund',
    'text',
  ])
  addMapping('schemes_other_detail', ['managed', 'delivery', 'local', 'initiatives', 'other', 'please', 'specify', 'text'])

  addMapping('website', ['link', 'organisation', 'website', 'web', 'page'])
  addMapping('contact_email', ['general', 'contact', 'email', 'organisation'])
  addMapping('employee_count_band', ['approximately', 'employees', 'organisation', 'have'])

  return mappings
}

/**
 * DROP + CREATE orgs_llm from current orgs columns.
 * @param {import('sqlite3').Database} db
 * @param {{ run: Function, all: Function }} sql
 * @returns {Promise<Array<{ alias: string, source: string }>>}
 */
export async function recreateOrgsLlmView(db, sql) {
  const columns = (await sql.all(db, `PRAGMA table_info(${quoteIdentifier(TABLE_NAME)})`)).map(
    (row) => row.name
  )
  if (!columns.length) {
    throw new Error(`Table ${TABLE_NAME} has no columns; cannot build ${LLM_VIEW_NAME}`)
  }

  const mappings = buildLlmViewMappings(columns)
  if (!mappings.length) {
    throw new Error(`No LLM view mappings matched columns on ${TABLE_NAME}`)
  }

  await sql.run(db, `DROP VIEW IF EXISTS ${quoteIdentifier(LLM_VIEW_NAME)}`)
  const viewSelect = mappings
    .map(({ alias, source }) => `${quoteIdentifier(source)} AS ${quoteIdentifier(alias)}`)
    .join(',\n      ')
  await sql.run(
    db,
    `CREATE VIEW ${quoteIdentifier(LLM_VIEW_NAME)} AS
         SELECT
           ${viewSelect}
         FROM ${quoteIdentifier(TABLE_NAME)}`
  )
  return mappings
}

/**
 * Read table/view metadata into annotated schema text.
 * @param {import('sqlite3').Database} db
 * @param {{ run?: Function, all: Function }} sql
 * @param {{ mode?: 'full' | 'canonical' }} [options]
 * @returns {Promise<string>}
 */
export async function getDatabaseSchema(db, sql, options = {}) {
  const mode = options.mode === 'canonical' ? 'canonical' : 'full'
  const objects = await sql.all(
    db,
    `SELECT name, type FROM sqlite_master
     WHERE type IN ('table', 'view')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY CASE WHEN type='table' THEN 0 ELSE 1 END, name`
  )

  const filtered =
    mode === 'canonical'
      ? objects.filter((obj) => obj.type === 'view' && obj.name === LLM_VIEW_NAME)
      : objects

  const schemaLines = []
  if (mode === 'canonical') {
    schemaLines.push(
      'Canonical directory view for text-to-SQL. Query ONLY this view (FROM orgs_llm).',
      'Audience columns (works_with_*): a non-empty value is usually Directly or Indirectly.',
      'Filter those with: col IS NOT NULL AND TRIM(col) != \'\' (do not require the word Yes).',
      ''
    )
  }

  for (const table of filtered) {
    const tableName = table.name
    const objectType = table.type
    schemaLines.push(`${objectType === 'view' ? 'View name' : 'Table name'}: ${tableName}`)
    schemaLines.push('Columns:')

    const safeTableName = tableName.replace(/'/g, "''")
    const columns = await sql.all(db, `PRAGMA table_info('${safeTableName}')`)
    const [{ row_count: rowCount }] = await sql.all(
      db,
      `SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(tableName)}`
    )

    for (const col of columns) {
      const colType = col.type || 'TEXT'
      const quotedCol = quoteIdentifier(col.name)
      const [{ populated_count: populatedCount }] = await sql.all(
        db,
        `SELECT COUNT(*) AS populated_count FROM ${quoteIdentifier(tableName)} WHERE ${quotedCol} IS NOT NULL AND TRIM(CAST(${quotedCol} AS TEXT)) != ''`
      )

      if (!populatedCount) {
        schemaLines.push(`  - ${col.name} (${colType}) [EMPTY - no data]`)
        continue
      }

      const examples = await sql.all(
        db,
        `SELECT DISTINCT TRIM(CAST(${quotedCol} AS TEXT)) AS example_value FROM ${quoteIdentifier(tableName)} WHERE ${quotedCol} IS NOT NULL AND TRIM(CAST(${quotedCol} AS TEXT)) != '' ORDER BY LENGTH(TRIM(CAST(${quotedCol} AS TEXT))) ASC, TRIM(CAST(${quotedCol} AS TEXT)) ASC LIMIT ${SCHEMA_EXAMPLE_LIMIT}`
      )
      const formattedExamples = examples
        .map(
          ({ example_value: value }) =>
            `"${String(value).replace(/\s+/g, ' ').trim().slice(0, 80).replace(/"/g, "'")}"`
        )
        .join(', ')
      schemaLines.push(
        `  - ${col.name} (${colType}) [populated ${populatedCount}/${rowCount}] examples: ${formattedExamples}`
      )
    }

    schemaLines.push('')
  }

  return schemaLines.join('\n').trimEnd() + '\n'
}

/**
 * Write full + canonical schema files next to directory.db.
 * @param {import('sqlite3').Database} db
 * @param {{ all: Function }} sql
 * @param {{ fullPath?: string, canonicalPath?: string }} [paths]
 * @returns {Promise<{ full: string, canonical: string }>}
 */
export async function writeSchemaFiles(db, sql, paths = {}) {
  const fullPath = paths.fullPath || SCHEMA_PATH
  const canonicalPath = paths.canonicalPath || CANONICAL_SCHEMA_PATH
  const full = await getDatabaseSchema(db, sql, { mode: 'full' })
  const canonical = await getDatabaseSchema(db, sql, { mode: 'canonical' })
  fs.writeFileSync(fullPath, full, 'utf8')
  fs.writeFileSync(canonicalPath, canonical, 'utf8')
  return { full, canonical }
}
