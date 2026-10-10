#!/bin/sh
# Export the local archive into web/public/data. Does not deploy.
# The weather store is read only. Do not point ISOBAR_STORE at this tree.
set -eu
cd "$(dirname "$0")/.."
if [ ! -x "./node_modules/.bin/tsx" ]; then
  echo "install web dependencies first: npm install" >&2
  exit 1
fi
export ISOBAR_STORE="${ISOBAR_STORE:-$HOME/Data/isobar}"
exec "./node_modules/.bin/tsx" scripts/export-data.ts
