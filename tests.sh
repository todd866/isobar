#!/bin/zsh
# Compile and run unit tests and the offscreen store-refresh regression.
set -euo pipefail
cd "${0:A:h}"

CC="${CC:-$(xcrun --find clang)}"
SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/isobar-tests.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 -m unittest discover -s Tests -p test_check_store.py
python3 -m unittest discover -s Tests -p test_package_release.py

"$CC" -fobjc-arc -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/collector.m Tests/test_collector.m -framework Foundation -o "$WORK_DIR/collector_tests"
"$WORK_DIR/collector_tests"

"$CC" -fobjc-arc -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/notacconnection.m Tests/test_notacconnection.m -framework Foundation -framework Security -o "$WORK_DIR/notacconnection_tests"
"$WORK_DIR/notacconnection_tests"

"$CC" \
    -fobjc-arc -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" \
    "-mmacosx-version-min=$MINIMUM_MACOS" \
    -ISources \
    Sources/pure.m Tests/test_pure.m \
    -framework Foundation -lz \
    -o "$WORK_DIR/isobar_tests"

"$CC" \
    -fobjc-arc -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" \
    "-mmacosx-version-min=$MINIMUM_MACOS" \
    -ISources \
    Sources/ownchart.m Tests/test_ownchart.m \
    -framework Foundation \
    -o "$WORK_DIR/ownchart_tests"

ISOBAR_FIXTURES="${0:A:h}/Tests/fixtures" "$WORK_DIR/isobar_tests"
ISOBAR_COAST="${0:A:h}/Resources/ownchart-coast.bin" "$WORK_DIR/ownchart_tests"

"$CC" -fobjc-arc -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/pure.m Tests/test_menubar.m -framework Cocoa -lz -o "$WORK_DIR/menubar_tests"
"$WORK_DIR/menubar_tests"

for TEST in rain aviation solar atmosphere aircraft traffic; do
    "$CC" -fobjc-arc -Wall -Wextra -Werror \
        -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
        "Sources/${TEST}.m" "Tests/test_${TEST}.m" \
        -framework Foundation -o "$WORK_DIR/${TEST}_tests"
    "$WORK_DIR/${TEST}_tests"
done

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/aviation.m Sources/aviationview.m Sources/solar.m Sources/atmosphere.m Sources/atmosphereview.m Sources/aircraft.m Sources/traffic.m Tests/test_aviationview.m \
    -framework Cocoa -o "$WORK_DIR/aviationview_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/atmosphere.m Sources/atmosphereview.m Sources/solar.m Sources/aircraft.m Sources/traffic.m Tests/test_atmosphereview.m \
    -framework Cocoa -o "$WORK_DIR/atmosphereview_tests"
"$WORK_DIR/atmosphereview_tests"
"$WORK_DIR/aviationview_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/notices.m Tests/test_notices.m \
    -framework Cocoa -o "$WORK_DIR/notices_tests"
ISOBAR_NOTICE_QA="${ISOBAR_NOTICE_QA:-/private/tmp/isobar-notice-qa}" \
    "$WORK_DIR/notices_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/rain.m Sources/rainview.m Tests/test_rainview.m \
    -framework Cocoa -o "$WORK_DIR/rainview_tests"
"$WORK_DIR/rainview_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/pure.m Sources/forecastview.m Tests/test_forecastview.m \
    -framework Cocoa -lz -o "$WORK_DIR/forecastview_tests"
"$WORK_DIR/forecastview_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/pure.m Sources/forecastview.m Sources/surfview.m Tests/test_surfview.m \
    -framework Cocoa -lz -o "$WORK_DIR/surfview_tests"
"$WORK_DIR/surfview_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/motion.m Tests/test_motion.m -framework Cocoa -framework Vision -framework CoreVideo \
    -o "$WORK_DIR/motion_tests"
"$WORK_DIR/motion_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/mapdetail.m Tests/test_mapdetail.m -framework Cocoa -o "$WORK_DIR/mapdetail_tests"
"$WORK_DIR/mapdetail_tests"

for TEST in warnings archive; do
    "$CC" -fobjc-arc -Wall -Wextra -Werror \
        -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
        Sources/pure.m Sources/archive.m "Tests/test_${TEST}.m" \
        -framework Foundation -lz -lsqlite3 -o "$WORK_DIR/${TEST}_tests"
    "$WORK_DIR/${TEST}_tests"
done

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/ownchart.m tools/own-chart.m Tests/test_published_grid.m \
    -framework Cocoa -lz -o "$WORK_DIR/published_grid_tests"
"$WORK_DIR/published_grid_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/ownchart.m tools/own-chart.m Sources/rawmovie.m Sources/scrub.m Tests/test_rawmotion.m \
    -framework Cocoa -framework AVFoundation -framework CoreVideo -framework CoreMedia -lz \
    -o "$WORK_DIR/rawmotion_tests"
"$WORK_DIR/rawmotion_tests"

"$CC" \
    -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/rain.m Sources/rainview.m Sources/aviation.m Sources/forecastview.m Sources/aviationview.m Sources/solar.m Sources/atmosphere.m Sources/atmosphereview.m Sources/aircraft.m Sources/traffic.m Sources/notices.m Sources/notacconnection.m Sources/surfview.m Sources/motion.m Sources/rawmovie.m Sources/scrub.m Sources/mapdetail.m Sources/collector.m Sources/archive.m Sources/ownchart.m tools/own-chart.m Sources/fullscreenwindow.m Tests/test_store_refresh.m \
    -framework Cocoa -framework Security -framework ServiceManagement -framework CoreLocation -framework Vision -framework CoreVideo -framework CoreMedia -framework AVFoundation -framework QuartzCore -lz -lsqlite3 \
    -o "$WORK_DIR/store_refresh_tests"
ISOBAR_FIXTURES="${0:A:h}/Tests/fixtures" \
    ISOBAR_COAST="${0:A:h}/Resources/ownchart-coast.bin" "$WORK_DIR/store_refresh_tests"

# Exercise real menu actions and rendered layer pixels on every build. The
# fixed clock keeps the checked-in archive useful after its forecast expires.
ISOBAR_CHECK_NOW="2026-09-26T00:30:00Z" \
    ./tools/check-layers.sh Tests/fixtures/store "$WORK_DIR/layers"
