#!/bin/zsh
# Offscreen acceptance and viewport captures against a supplied archive.
set -euo pipefail
cd "${0:A:h}/.."
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/isobar-acceptance.XXXXXX")"
trap 'rm -rf "$CHECK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$(xcrun --find clang)" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$(xcrun --sdk macosx --show-sdk-path)" "-mmacosx-version-min=$MINIMUM_MACOS" \
    -ISources -DISOBAR_APP Sources/pure.m Sources/rain.m Sources/rainview.m Sources/aviation.m Sources/forecastview.m Sources/aviationview.m Sources/solar.m Sources/atmosphere.m Sources/atmosphereview.m Sources/aircraft.m Sources/traffic.m Sources/notices.m Sources/notacconnection.m Sources/surfview.m Sources/motion.m Sources/rawmovie.m Sources/scrub.m Sources/mapdetail.m Sources/collector.m Sources/archive.m Sources/ownchart.m Sources/fullscreenwindow.m \
    tools/own-chart.m tools/check-app.m \
    -framework Cocoa -framework Security -framework ServiceManagement -framework CoreLocation -framework Vision -framework CoreVideo -framework CoreMedia -framework AVFoundation -framework QuartzCore -lz -lsqlite3 \
    -o "$CHECK_DIR/check-app"
ISOBAR_COAST="$PWD/Resources/ownchart-coast.bin" "$CHECK_DIR/check-app" \
    "${1:-$HOME/Data/isobar}" "${2:-$PWD/build/acceptance}"
