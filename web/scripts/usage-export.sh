#!/bin/sh
# Nightly export for a LaunchAgent. Install is the owner's step.
# Writes ~/Data/isobar-usage/YYYY-MM-DD.ndjson.gz and does not print the rows.
# Requires ISOBAR_DIGEST_SECRET. Optional ISOBAR_ORIGIN (default https://isobar.md).
set -eu
origin="${ISOBAR_ORIGIN:-https://isobar.md}"
secret="${ISOBAR_DIGEST_SECRET:?ISOBAR_DIGEST_SECRET is required}"
dest="${HOME}/Data/isobar-usage"
mkdir -p "$dest"
day="$(date -u +%Y-%m-%d)"
since="${day}T00:00:00Z"
tmp="${dest}/${day}.ndjson.gz.tmp"
curl -fsS \
  -H "x-isobar-digest: ${secret}" \
  "${origin}/api/admin/usage/export?since=${since}" \
  | gzip -c > "$tmp"
mv "$tmp" "${dest}/${day}.ndjson.gz"
