/**
 * Offline unit tests for SQL guardrails used by query.mjs.
 * Keep in sync with extractSqlFromLlmOutput / validateSql there.
 */
function stripSqlComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

function maskSqlStringLiterals(sql) {
  return String(sql || '')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
}

function extractSqlFromLlmOutput(text) {
  let sql = String(text || '').trim()
  if (!sql) return ''
  const fence = sql.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  if (fence) sql = fence[1].trim()
  const start = sql.search(/\b(?:WITH|SELECT)\b/i)
  if (start > 0) sql = sql.slice(start).trim()
  return sql
}

const FORBIDDEN_SQL_KEYWORD =
  /\b(?:ATTACH|DETACH|DROP|INSERT|UPDATE|DELETE|ALTER|CREATE|REINDEX|VACUUM|PRAGMA|ANALYZE|GRANT|REVOKE|TRUNCATE|MERGE|CALL|EXEC(?:UTE)?|LOAD_EXTENSION|INTO)\b/i
const FORBIDDEN_SQL_REPLACE_STMT = /\bREPLACE\s+(?:OR\s+\w+\s+)?(?:INTO\b|\w+)/i

function validateSql(sql) {
  const original = String(sql || '')
  const withoutComments = stripSqlComments(original).trim()
  if (!withoutComments) throw new Error('Rejected')
  const single = withoutComments.replace(/;\s*$/, '').trim()
  const masked = maskSqlStringLiterals(single)
  if (!single || masked.includes(';')) throw new Error('Rejected')
  if (!/^(?:WITH|SELECT)\b/i.test(single)) throw new Error('Rejected')
  if (FORBIDDEN_SQL_KEYWORD.test(masked) || FORBIDDEN_SQL_REPLACE_STMT.test(masked)) {
    throw new Error('Rejected')
  }
}

const tests = [
  ['SELECT * FROM organisations', true, 'plain SELECT'],
  ['  select count(*) from organisations', true, 'lowercase select'],
  ['-- comment\nSELECT 1', true, 'line comment before SELECT'],
  ['/* comment */ SELECT id FROM orgs', true, 'block comment before SELECT'],
  ['WITH x AS (SELECT 1 AS n) SELECT * FROM x', true, 'WITH CTE SELECT'],
  ["SELECT REPLACE(org_name, 'a', 'b') FROM orgs_llm", true, 'REPLACE() expression'],
  ['SELECT 1;', true, 'trailing semicolon only'],
  ["SELECT * FROM orgs_llm WHERE remit LIKE '%into%'", true, 'INTO inside string literal'],
  ["SELECT * FROM orgs_llm WHERE note LIKE 'a;b'", true, 'semicolon inside string literal'],
  [
    extractSqlFromLlmOutput('```sql\nSELECT org_name FROM orgs_llm\n```'),
    true,
    'markdown fenced SELECT after extract',
  ],
  [
    extractSqlFromLlmOutput(
      '```sql\nSELECT DISTINCT org_name FROM orgs_llm WHERE org_main_type LIKE \'%Architect%\' AND county LIKE \'%Hampshire%\'\n```'
    ),
    true,
    'markdown fenced Hampshire architect query',
  ],
  ['DROP TABLE organisations', false, 'DROP TABLE'],
  ['INSERT INTO organisations VALUES (1)', false, 'INSERT'],
  ["UPDATE organisations SET name='x'", false, 'UPDATE'],
  ['DELETE FROM organisations', false, 'DELETE'],
  ['/* comment */ DROP TABLE organisations', false, 'block comment then DROP'],
  ['-- comment\nDROP TABLE organisations\n', false, 'line comment then DROP'],
  ['SELECT 1; DROP TABLE organisations', false, 'SELECT with appended DROP'],
  ['SELECT 1; SELECT 2', false, 'multi SELECT'],
  ['PRAGMA table_info(orgs)', false, 'PRAGMA'],
  ["ATTACH DATABASE ':memory:' AS evil", false, 'ATTACH'],
  ['SELECT * FROM orgs INTO outfile', false, 'SELECT INTO'],
  ['CREATE TABLE t(a)', false, 'CREATE'],
  ['SELECTFOO FROM bar', false, 'word boundary check (SELECTFOO)'],
]

let fail = 0
for (const [sql, expectPass, label] of tests) {
  let accepted
  try {
    validateSql(sql)
    accepted = true
  } catch {
    accepted = false
  }
  const ok = accepted === expectPass
  if (!ok) fail += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}\n`)
}
process.exit(fail)
