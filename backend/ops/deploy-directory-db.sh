#!/usr/bin/env bash
# Copy local directory.db and text-to-SQL schema files to the production host.
#
# Usage (from backend/):
#   ./ops/deploy-directory-db.sh
#
# Prerequisites:
#   - ./directory.db present (build with csvToDB.mjs or ops/refresh-directory.sh)
#   - ./directory.schema and ./directory.schema.canonical present
#   - SSH host alias AWS-CRESS configured for the production server
#
# After deploy, restart retrofit-query-server on the host if it keeps a DB
# handle open across file replaces:
#   sudo systemctl restart retrofit-query-server
#
# Prefer weekly flow:
#   ./ops/refresh-directory.sh path/to/export.xlsx --deploy
#
set -euo pipefail
OPS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ROOT="$(cd "$OPS_ROOT/.." && pwd)"
cd "$BACKEND_ROOT"

REMOTE_DIR='AWS-CRESS:/data/retrofit-directory/backend'

missing=0
for f in directory.db directory.schema directory.schema.canonical; do
  if [[ ! -f "./$f" ]]; then
    echo "error: ./$f not found — run csvToDB.mjs, rebuild-orgs-llm.mjs, or ops/refresh-directory.sh first" >&2
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

scp ./directory.db ./directory.schema ./directory.schema.canonical "$REMOTE_DIR/"
echo "deployed to $REMOTE_DIR/:"
echo "  directory.db"
echo "  directory.schema"
echo "  directory.schema.canonical"
