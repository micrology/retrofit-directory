#!/usr/bin/env bash
# Rebuild directory.db from a Qualtrics export, verify integrity, optionally deploy.
#
# Usage:
#   ./refresh-directory.sh path/to/export.xlsx
#   ./refresh-directory.sh path/to/export.xlsx --deploy
#   ./refresh-directory.sh path/to/export.xlsx --deploy --min-match-rate 0.90
#
# Environment:
#   MIN_MATCH_RATE   Minimum fraction of non-blank HQ postcodes that must resolve
#                    to a local_authority (default: 0.95). Overridden by --min-match-rate.
#   SKIP_ONSPD_CHECK Set to 1 to allow import when ONSPD is missing (not recommended).
#
# Exits non-zero if import, verify, match-rate gate, or deploy fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

INPUT=""
DEPLOY=0
MIN_MATCH_RATE="${MIN_MATCH_RATE:-0.95}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage ;;
    --deploy) DEPLOY=1; shift ;;
    --min-match-rate)
      MIN_MATCH_RATE="${2:?--min-match-rate requires a value (e.g. 0.95)}"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage
      ;;
    *)
      if [[ -n "$INPUT" ]]; then
        echo "error: unexpected argument: $1" >&2
        usage
      fi
      INPUT=$1
      shift
      ;;
  esac
done

if [[ -z "$INPUT" ]]; then
  echo "error: path to Qualtrics CSV/XLSX export is required" >&2
  usage
fi
if [[ ! -f "$INPUT" ]]; then
  echo "error: input file not found: $INPUT" >&2
  exit 1
fi

# Resolve to an absolute path before cd-sensitive steps (already in ROOT).
if [[ "$INPUT" != /* ]]; then
  INPUT="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
fi

if ! [[ "$MIN_MATCH_RATE" =~ ^0(\.[0-9]+)?$|^1(\.0+)?$ ]]; then
  echo "error: MIN_MATCH_RATE must be a fraction between 0 and 1 (got: $MIN_MATCH_RATE)" >&2
  exit 1
fi

ONSPD_ZIP="$(ls -1 "$ROOT"/geo/ONSPD_*.zip 2>/dev/null | sort | tail -n 1 || true)"
if [[ -z "${ONSPD_ZIP}" && "${SKIP_ONSPD_CHECK:-0}" != "1" ]]; then
  echo "error: no ONSPD zip found under backend/geo/ONSPD_*.zip" >&2
  echo "       Download the free ONS Postcode Directory into backend/geo/ (see backend/geo/README.md)." >&2
  echo "       Or set SKIP_ONSPD_CHECK=1 to proceed without place enrichment (not recommended)." >&2
  exit 1
fi

echo "==> Import: $INPUT"
if [[ -n "${ONSPD_ZIP}" ]]; then
  echo "    ONSPD: $ONSPD_ZIP"
else
  echo "    ONSPD: (none — enrichment skipped)"
fi

IMPORT_LOG="$(mktemp -t retrofit-import.XXXXXX)"
trap 'rm -f "$IMPORT_LOG"' EXIT

if ! node csvToDB.mjs "$INPUT" 2>&1 | tee "$IMPORT_LOG"; then
  echo "error: csvToDB.mjs failed" >&2
  exit 1
fi

if [[ ! -f "$ROOT/directory.db" ]]; then
  echo "error: directory.db was not created" >&2
  exit 1
fi

echo "==> Postcode match-rate gate (threshold ${MIN_MATCH_RATE})"
# shellcheck disable=SC2016
read -r WITH_POSTCODE MATCHED_LA BLANK_POSTCODE < <(
  sqlite3 -separator ' ' "$ROOT/directory.db" \
    "SELECT
       SUM(CASE WHEN postcode IS NOT NULL AND TRIM(postcode) != '' THEN 1 ELSE 0 END),
       SUM(CASE WHEN postcode IS NOT NULL AND TRIM(postcode) != ''
                 AND local_authority IS NOT NULL AND TRIM(local_authority) != '' THEN 1 ELSE 0 END),
       SUM(CASE WHEN postcode IS NULL OR TRIM(IFNULL(postcode,'')) = '' THEN 1 ELSE 0 END)
     FROM orgs_llm;"
)

WITH_POSTCODE=${WITH_POSTCODE:-0}
MATCHED_LA=${MATCHED_LA:-0}
BLANK_POSTCODE=${BLANK_POSTCODE:-0}

if [[ "$WITH_POSTCODE" -eq 0 ]]; then
  echo "error: no headquarters postcodes found in orgs_llm — cannot compute match rate" >&2
  exit 1
fi

# Use awk for portable float compare / ratio.
MATCH_RATE="$(awk -v m="$MATCHED_LA" -v t="$WITH_POSTCODE" 'BEGIN { printf "%.6f", (t > 0 ? m / t : 0) }')"
PASS="$(awk -v r="$MATCH_RATE" -v min="$MIN_MATCH_RATE" 'BEGIN { print (r + 0 >= min + 0) ? 1 : 0 }')"

echo "    rows with HQ postcode:     $WITH_POSTCODE"
echo "    postcodes with LA match:   $MATCHED_LA"
echo "    rows with blank postcode:  $BLANK_POSTCODE"
echo "    match rate:                $MATCH_RATE (minimum $MIN_MATCH_RATE)"

if [[ "$PASS" -ne 1 ]]; then
  echo "error: postcode→local_authority match rate $MATCH_RATE is below threshold $MIN_MATCH_RATE" >&2
  echo "       Check unmatched postcodes in the import log above, or refresh ONSPD." >&2
  if grep -q 'Unmatched postcodes:' "$IMPORT_LOG" 2>/dev/null; then
    grep 'Unmatched postcodes:' "$IMPORT_LOG" >&2 || true
  fi
  exit 1
fi
echo "    match-rate gate: PASS"

echo "==> verifyImport.mjs"
if ! node verifyImport.mjs "$INPUT" "$ROOT/directory.db" "$ROOT/directory.schema"; then
  echo "error: verifyImport.mjs failed" >&2
  exit 1
fi

if [[ "$DEPLOY" -eq 1 ]]; then
  echo "==> deploy-directory-db.sh"
  if [[ ! -x "$ROOT/deploy-directory-db.sh" ]]; then
    echo "error: deploy-directory-db.sh missing or not executable" >&2
    exit 1
  fi
  "$ROOT/deploy-directory-db.sh"
  echo "    deploy: done (restart retrofit-query-server on the host if it does not reload the DB)"
else
  echo "==> deploy skipped (pass --deploy to run deploy-directory-db.sh)"
fi

echo "==> Refresh complete"
echo "    database: $ROOT/directory.db"
echo "    schema:   $ROOT/directory.schema"
