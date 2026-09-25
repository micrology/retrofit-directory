# Backend layout and runbook

Node.js query server, directory import pipeline, tests, and policy-corpus
helpers for the Retrofit Directory. Product overview and full API docs live in
the [apex README](../README.md).

## Layout

| Path | Role |
| --- | --- |
| `query.mjs` | Express server (`POST /api/query`, `POST /api/observe`) |
| `csvToDB.mjs` | Qualtrics import → `directory.db` + schema files |
| `rebuild-orgs-llm.mjs` | Refresh `orgs_llm` + schemas without full re-import |
| `verifyImport.mjs` | Post-import integrity checks |
| `lib/` | Shared libraries (`proximity`, `geocode`, `usage`, `orgsLlmView`, `geoPostcodes`) |
| `ops/` | Deploy/refresh shell scripts and systemd unit |
| `test/` | Offline unit tests, security regression, smoke curls |
| `gen-metadata/` | Bedrock KB sidecar generators |
| `Policies/` | Local policy corpus prep (gitignored bulk files) |
| `geo/` | ONSPD zip + geocode cache (gitignored bulk data) |
| `directory.schema` | Full schema text (SQL repair) |
| `directory.schema.canonical` | Slim `orgs_llm` schema (default text-to-SQL) |
| `directory.db` | Org database (gitignored; deploy to host) |
| `usage.db*` | Request/token log (gitignored) |

## Run the query server

```bash
cd backend
npm install
VERBOSE=1 ADMIN_PASSWORD=secret npm start
# http://127.0.0.1:5001
```

Production: install `ops/retrofit-query-server.service` (see unit comments).

## Import / refresh directory data

```bash
cd backend
npm run import -- path/to/qualtrics-export.xlsx
# or weekly wrapper:
./ops/refresh-directory.sh path/to/qualtrics-export.xlsx
./ops/refresh-directory.sh path/to/qualtrics-export.xlsx --deploy
```

After changing `lib/orgsLlmView.mjs` mappings only:

```bash
npm run rebuild-view
```

Deploy DB **and** both schema files:

```bash
./ops/deploy-directory-db.sh
```

## Tests

```bash
npm test                 # offline only
npm run test:security    # live HTTP + Bedrock (~2 min)
```

## Policy metadata

```bash
node gen-metadata/fetch-policy-page.js <url>
node gen-metadata/generate-policy-metadata.js
node gen-metadata/write-metadata.js
```

Outputs land in `Policies/` (not read by the query server at runtime).
