#!/usr/bin/env bash
# Copy local directory.db to the production host over scp.
#
# Usage (from backend/):
#   ./deploy-directory-db.sh
#
# Prerequisites:
#   - ./directory.db present (build with csvToDB.mjs or refresh-directory.sh)
#   - SSH host alias AWS-CRESS configured for the production server
#
# After deploy, restart retrofit-query-server on the host if it keeps a DB
# handle open across file replaces:
#   sudo systemctl restart retrofit-query-server
#
# Prefer weekly flow:
#   ./refresh-directory.sh path/to/export.xlsx --deploy
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f ./directory.db ]]; then
  echo "error: ./directory.db not found — run csvToDB.mjs or refresh-directory.sh first" >&2
  exit 1
fi

scp ./directory.db AWS-CRESS:/data/retrofit-directory/backend/directory.db
echo "deployed directory.db to AWS-CRESS:/data/retrofit-directory/backend/directory.db"
