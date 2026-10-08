#!/bin/zsh
# Shown-popover acceptance. The anchor window stays fully off-screen.
set -euo pipefail
cd "${0:A:h}/.."
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/isobar-popover-live.XXXXXX")"
trap 'rm -rf "$CHECK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$(xcrun --find clang)" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$(xcrun --sdk macosx --show-sdk-path)" "-mmacosx-version-min=$MINIMUM_MACOS" \
    -ISources -DISOBAR_APP Sources/pure.m Sources/rain.m Sources/rainview.m Sources/aviation.m Sources/forecastview.m Sources/aviationview.m Sources/skyview.m Sources/solar.m Sources/atmosphere.m Sources/atmosphereview.m Sources/aircraft.m Sources/traffic.m Sources/notices.m Sources/notacconnection.m Sources/surfview.m Sources/motion.m Sources/rawmovie.m Sources/scrub.m Sources/mapdetail.m Sources/collector.m Sources/archive.m Sources/ownchart.m Sources/daystrip.m Sources/fullscreenwindow.m Sources/playback.m Sources/storereload.m Sources/mapcamera.m Sources/gpumapview.m Sources/hazard.m Sources/fieldrender.m Sources/trainingdata.m Sources/trainingwindow.m \
    tools/own-chart.m tools/check-popover-live.m \
    -framework Cocoa -framework WebKit -framework Security -framework ServiceManagement -framework CoreLocation -framework Vision -framework CoreVideo -framework CoreMedia -framework AVFoundation -framework QuartzCore -framework Metal -framework CoreText -framework Accelerate -lz -lsqlite3 \
    -o "$CHECK_DIR/check-popover-live"
ISOBAR_CHECK_NOW="${ISOBAR_CHECK_NOW:-2026-09-26T00:30:00Z}" \
ISOBAR_COAST="$PWD/Resources/ownchart-coast.bin" "$CHECK_DIR/check-popover-live" \
    "${1:-$HOME/Data/isobar}" "${2:-$PWD/build/popover-live}"
