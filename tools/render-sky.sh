#!/bin/zsh
# Offscreen renders of the Fly card and Atmosphere window with the sky section. No network or visible windows.
set -euo pipefail
cd "${0:A:h}/.."
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
mkdir -p build/qa
CHECK_DIR="$(mktemp -d "$PWD/build/qa/.render-sky.XXXXXX")"
trap 'rm -rf "$CHECK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
CC="$(xcrun --find clang)"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" \
    -ISources -DISOBAR_APP \
    Sources/pure.m Sources/rain.m Sources/rainview.m Sources/aviation.m Sources/forecastview.m Sources/aviationview.m Sources/skyview.m \
    Sources/solar.m Sources/atmosphere.m Sources/atmosphereview.m Sources/aircraft.m Sources/traffic.m Sources/notices.m \
    Sources/notacconnection.m Sources/surfview.m Sources/motion.m Sources/rawmovie.m Sources/scrub.m Sources/mapdetail.m \
    Sources/collector.m Sources/archive.m Sources/ownchart.m Sources/daystrip.m Sources/fullscreenwindow.m Sources/playback.m \
    Sources/storereload.m Sources/mapcamera.m Sources/gpumapview.m Sources/hazard.m Sources/fieldrender.m \
    Sources/trainingdata.m Sources/trainingwindow.m tools/own-chart.m tools/render-sky.m \
    -framework Cocoa -framework WebKit -framework Security -framework ServiceManagement -framework CoreLocation \
    -framework Vision -framework CoreVideo -framework CoreMedia -framework AVFoundation -framework QuartzCore \
    -framework Metal -framework CoreText -framework Accelerate -lz -lsqlite3 -o "$CHECK_DIR/render-sky"
STORE="${1:-Tests/fixtures/store}"
OUT="${2:-build/qa/sky}"
# A real archive renders at the real clock; the fixture at its own.
if [[ "$STORE" == Tests/fixtures/store ]]; then export ISOBAR_CHECK_NOW="${ISOBAR_CHECK_NOW:-2026-09-26T00:30:00Z}" ISOBAR_FIXTURES="$PWD/Tests/fixtures"; fi
ISOBAR_TRAINING_DIST="$PWD/training/dist" ISOBAR_COAST="$PWD/Resources/ownchart-coast.bin" \
    ISOBAR_WORLD_COAST="${ISOBAR_WORLD_COAST:-$PWD/Resources/world-coast.bin}" \
    "$CHECK_DIR/render-sky" "$STORE" "$OUT"
