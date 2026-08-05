# Cut SQL-generation input tokens ~69% via a view-only schema

Status: proposed, not implemented. Recorded 2026-08-05.

## Problem

Every user question costs about 5,510 input tokens at the SQL-generation stage, because the whole of `backend/directory.schema` is injected into the prompt at `backend/query.mjs:231`. Measured against the verbatim production prompt, the schema is 5,034 of those 5,510 tokens — 91% of the call. The SQL stage accounted for 22,053 of 22,676 total input tokens (97%) in test traffic, so it is effectively the entire cost of the service.

## Measured options

All figures are exact `usage.inputTokens` values returned by Bedrock for the real prompt against `eu.anthropic.claude-haiku-4-5-20251001-v1:0`, not estimates.

- Current, `orgs` + `orgs_llm`: 5,510 tokens — $5.51 per 1,000 questions at $1/Mtok
- Strip only survey metadata and `[EMPTY]` columns: 4,716 (−14%)
- Drop the view, keep the raw table: 4,979 (−10%)
- `orgs_llm` view only, as it exists today: 1,006 (−82%) — but coverage is incomplete, see below
- `orgs_llm` extended to full coverage, view only: 1,711 (−69%) — $1.71 per 1,000 questions

The recommended target is the last option: **5,510 → 1,711 tokens, a 69% reduction.**

## Why the raw table is so expensive

Column names *are* the full survey question text, and that text repeats. The 21 "who does the organisation work with" columns (`backend/directory.schema` lines 52-73) restate the same ~90-character stem 21 times, costing 4,682 bytes / roughly 1,400 tokens to convey 21 boolean-ish flags. As short aliases (`works_with_fuel_poverty` etc.) the same information costs about a third of that.

There is a compounding saving. Two prompt rules exist *only* to defend against columns that appear in the raw dump: the `[EMPTY - no data]` rule and the `location_latitude`/`location_longitude` warning (`backend/query.mjs:225` and `backend/query.mjs:228`). Remove the raw table from the prompt and both rules become dead weight — today we pay to list columns and then pay again to tell the model to ignore them.

## Current state

- `buildLlmViewMappings` (`backend/csvToDB.mjs:326`) aliases 15 columns into the `orgs_llm` view, using `findColumnByTokens` heuristics against the cleaned survey headers.
- Of the 21 audience columns, only `works_with_architects` is aliased.
- `getDatabaseSchema` (`backend/csvToDB.mjs:112`) walks every table *and* view in `sqlite_master` and writes them all to `directory.schema`, which is what makes the file so large.
- `readSchema()` (`backend/query.mjs:154`) loads that single file, and both `generateSqlFromQuery` and `regenerateSqlFromError` inject it.

## Proposed changes

### 1. Extend the LLM view to full coverage

In `csvToDB.mjs`, grow `orgs_llm` from 15 to roughly 37 columns so nothing is reachable only via the raw table:

- the 20 missing audience columns, as `works_with_*` aliases
- `funding_schemes` (and the two funding free-text columns if worth keeping)
- `department_or_unit`
- `org_main_type_other`, consolidating the three "other (please specify)" type columns

Match the 21 audience columns by prefix-and-suffix extraction rather than 21 hand-written token lists in `findColumnByTokens`; the latter would be fragile if the survey wording changes. Deliberately exclude survey platform metadata (`start_date`, `ip_address`, `progress`, `response_id`, `location_latitude`/`longitude`, etc.) and all `[EMPTY]` columns.

### 2. Emit an LLM-facing schema containing only the view

Have `csvToDB.mjs` write a second, view-only artefact (e.g. `directory.llm.schema`) alongside the existing full `directory.schema`. Keeping the full file is useful for human inspection and debugging; only the trimmed one goes into prompts. Keep the `examples:` annotations — they earn their keep, since `"Kent (England)"` is what tells the model the county format for a `LIKE` filter.

### 3. Point both prompt sites at the trimmed schema

Update `readSchema()` to load the view-only file, and simplify the rule list in `generateSqlFromQuery`: drop the `[EMPTY]` rule, drop the latitude/longitude warning, and reword the "prefer `orgs_llm`" and "you MUST query FROM orgs_llm" rules now that no other table is on offer. Apply the same trimmed schema to `regenerateSqlFromError` (`backend/query.mjs:260`), which currently also sends the full schema.

## Risks and verification

The main risk is a coverage gap: if a question needs an unaliased column, the model will likely invent a column name, hit a SQLite error, and trigger the repair stage — costing a second call and partially eroding the saving. Verification should therefore be behavioural, not just a token count:

- Run a suite of representative questions covering counts, name lists, county filters, specialisms, employee bands, funding schemes and several audience columns.
- Assert each generated query executes against the database without error, not merely that the SQL looks plausible.
- Confirm via the `/api/observe` `byStage` breakdown that `sql` stage tokens drop as predicted and that `repair` calls do not increase.

## Prompt caching: do this second, if at all

Caching is second-order compared with the structural cut, and it has a trap worth recording. Anthropic's minimum cacheable prefix is 1,024 tokens, so a 1,711-token prefix still qualifies. But the cache TTL is 5 minutes: an isolated visitor asking a single question pays the 1.25x cache-*write* premium and never benefits from a read, which would *increase* cost at low traffic. It pays off within a conversation, where follow-ups arrive seconds apart — a real pattern here, since the reformulation stage exists precisely for follow-ups. Revisit only after the view-only change lands, and judge it against the observed daily request pattern in `usage.db`.

## Note on rate accuracy

The cost figures depend on `MODEL_RATES_USD_PER_MTOK` in `backend/usage.mjs:28`, which was set from best understanding rather than verified AWS pricing output. Only raw token counts are stored, so correcting those two rates retroactively fixes every reported cost.
