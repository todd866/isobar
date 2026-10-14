#!/bin/zsh
# A joint gate: production native view and browser Canvas render the same fixture.
set -euo pipefail
cd "${0:A:h}/.."
CC="$(xcrun --find clang)"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
CHECK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/isobar-wind.XXXXXX")
trap 'rm -rf "$CHECK_DIR"' EXIT
"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
 Sources/windmapview.m Sources/fieldrender.m Sources/ownchart.m tools/own-chart.m Sources/pure.m Tests/test_windmapview.m \
 -framework Cocoa -framework QuartzCore -framework Metal -framework CoreText -framework Accelerate -lz -o "$CHECK_DIR/wind"
"$CHECK_DIR/wind"
export ISOBAR_NATIVE_WIND_REPORT="$PWD/build/qa/wind/native-contract.json"
export ISOBAR_WIND_PARITY_OUT="$PWD/build/qa/wind"
cd web
ISOBAR_E2E_FILES=1 npm exec -- playwright test tests/e2e/wind-parity.spec.ts --project=chromium --workers=1 --output=../build/qa/wind/browser
cd ..
python3 tools/measure-wind-parity.py
