#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
MANIFEST=${1:-site/data/current.json}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/isobar-check-movies.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
clang -fobjc-arc -O2 -Wall -Wextra -Werror -mmacosx-version-min=13.0 \
  tools/check-site-movies.m -framework Foundation -framework AVFoundation -framework CoreMedia \
  -o "$WORK/check-site-movies"
"$WORK/check-site-movies" "$MANIFEST"
