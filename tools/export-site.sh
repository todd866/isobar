#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
if (( $# != 2 )); then
    echo 'Usage: tools/export-site.sh ARCHIVE OUTPUT' >&2
    exit 2
fi
WORK=$(mktemp -d "${TMPDIR:-/tmp}/isobar-site.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
clang -fobjc-arc -O2 -Wall -Wextra -Werror -mmacosx-version-min=13.0 -ISources -DISOBAR_APP \
    Sources/pure.m Sources/archive.m Sources/ownchart.m Sources/surfview.m Sources/forecastview.m Sources/rawmovie.m tools/own-chart.m tools/export-site.m \
    -framework Cocoa -framework AVFoundation -framework CoreVideo -framework CoreMedia -framework Accelerate -lz -lsqlite3 -o "$WORK/export-site"
"$WORK/export-site" "$1" "$2" Resources/ownchart-coast.bin
