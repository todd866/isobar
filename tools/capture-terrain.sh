#!/bin/zsh
# Build and capture without creating a window. Pass an evidence directory.
set -euo pipefail
cd "${0:A:h}/.."
OUT="${1:?usage: capture-terrain.sh EVIDENCE_DIRECTORY}"
mkdir -p "$OUT/build" "$OUT/shots"
CC="$(xcrun --find clang)"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/mapcamera.m Sources/terrain.m Sources/terrainmap.m Sources/terrainscene.m Sources/gpumapview.m Sources/windmapview.m Sources/hazard.m \
    Sources/atmospheremapview.m Sources/atmosphere.m Sources/traffic.m Sources/trafficroute.m \
    Sources/fieldrender.m Sources/ownchart.m tools/own-chart.m Sources/pure.m Sources/playback.m tools/capture-terrain.m \
    -framework Cocoa -framework ImageIO -framework Metal -framework QuartzCore -framework CoreText -framework Accelerate -framework ImageIO -lz \
    -o "$OUT/build/capture-terrain"
ISOBAR_COAST="$PWD/Resources/ownchart-coast.bin" "$OUT/build/capture-terrain" "$OUT/shots"
