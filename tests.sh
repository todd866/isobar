#!/bin/zsh
# Compile and run unit tests and the offscreen store-refresh regression.
set -euo pipefail
cd "${0:A:h}"
# An installed app runs from /, where a checkout-relative coast path does not
# exist. Every renderer resolves the coastline through OwnCoastPath().
if grep -n '"Resources/ownchart-coast.bin"' Sources/*.m | grep -v '^Sources/ownchart.m:'; then
    echo "FAIL resolve the coastline with OwnCoastPath(), not a checkout-relative path" >&2; exit 1
fi

SHORT=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Info.plist)
BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' Info.plist)
if [[ "$SHORT" != "1.11.0" || "$BUILD" != "36" ]]; then
    echo "tests.sh: Info.plist version is ${SHORT} (${BUILD}); expected 1.11.0 (36)." >&2
    exit 1
fi

CC="${CC:-$(xcrun --find clang)}"
SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/isobar-tests.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Helper scripts build with the toolchain's clang for the app's minimum macOS.
if grep -nE -- '-mmacosx-version-min=[0-9]|^[[:space:]]*clang[[:space:]]' build.sh tools/*.sh; then
    echo 'tests.sh: build with "$(xcrun --find clang)" and LSMinimumSystemVersion, as tools/check-app.sh does.' >&2
    exit 1
fi

python3 tools/run-python-tests.py Tests test_check_store.py
python3 tools/run-python-tests.py Tests test_check_bundle.py
python3 tools/run-python-tests.py Tests test_package_release.py
python3 tools/run-python-tests.py Tests test_public_weather.py
python3 tools/run-python-tests.py Tests test_native_gate.py
python3 tools/run-python-tests.py Tests test_deployment_coherence.py

"$CC" -fobjc-arc -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/collector.m Tests/test_collector.m -framework Foundation -o "$WORK_DIR/collector_tests"
"$WORK_DIR/collector_tests"

"$CC" -fobjc-arc -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/notacconnection.m Tests/test_notacconnection.m -framework Foundation -framework Security -o "$WORK_DIR/notacconnection_tests"
"$WORK_DIR/notacconnection_tests"

"$CC" -fobjc-arc -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/fullscreenwindow.m Tests/test_fullscreenwindow.m -framework Cocoa -o "$WORK_DIR/fullscreenwindow_tests"
"$WORK_DIR/fullscreenwindow_tests"

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
    -framework Foundation -framework Accelerate \
    -o "$WORK_DIR/ownchart_tests"

ISOBAR_FIXTURES="${0:A:h}/Tests/fixtures" "$WORK_DIR/isobar_tests"
ISOBAR_COAST="${0:A:h}/Resources/ownchart-coast.bin" "$WORK_DIR/ownchart_tests"

"$CC" -fobjc-arc -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/fieldrender.m Sources/ownchart.m Sources/hazard.m Tests/test_fieldrender.m \
    -framework Foundation -framework Metal -framework CoreGraphics -framework CoreText -framework Accelerate \
    -o "$WORK_DIR/fieldrender_tests"
ISOBAR_COAST="${0:A:h}/Resources/ownchart-coast.bin" "$WORK_DIR/fieldrender_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/windmapview.m Sources/fieldrender.m Sources/ownchart.m tools/own-chart.m Sources/pure.m Tests/test_windmapview.m \
    -framework Cocoa -framework Metal -framework CoreText -framework Accelerate -lz \
    -o "$WORK_DIR/windmap_tests"
"$WORK_DIR/windmap_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/hazard.m Sources/fieldrender.m Sources/ownchart.m Tests/test_hazard.m \
    -framework Foundation -framework Metal -framework CoreGraphics -framework CoreText -framework Accelerate -framework ImageIO \
    -o "$WORK_DIR/hazard_tests"
ISOBAR_FIXTURES="${0:A:h}/Tests/fixtures" "$WORK_DIR/hazard_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/mapcamera.m Sources/gpumapview.m Sources/windmapview.m Sources/hazard.m Sources/atmospheremapview.m Sources/atmosphere.m Sources/traffic.m Sources/trafficroute.m Sources/fieldrender.m Sources/ownchart.m tools/own-chart.m Sources/pure.m Sources/playback.m Tests/test_traffic_overlay.m \
    -framework Cocoa -framework Metal -framework QuartzCore -framework CoreText -framework Accelerate -lz \
    -o "$WORK_DIR/traffic_overlay_tests"
ISOBAR_FIELD_FIXTURE="${0:A:h}/Tests/fixtures/fieldrender" \
    ISOBAR_COAST="${0:A:h}/Resources/ownchart-coast.bin" "$WORK_DIR/traffic_overlay_tests"


"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/mapcamera.m Sources/gpumapview.m Sources/windmapview.m Sources/hazard.m Sources/atmospheremapview.m Sources/atmosphere.m Sources/traffic.m Sources/trafficroute.m Sources/fieldrender.m Sources/ownchart.m tools/own-chart.m Sources/pure.m Sources/playback.m Tests/test_gpumapview.m \
    -framework Cocoa -framework Metal -framework QuartzCore -framework CoreText -framework Accelerate -lz \
    -o "$WORK_DIR/gpumap_tests"
ISOBAR_FIELD_FIXTURE="${0:A:h}/Tests/fixtures/fieldrender" \
    ISOBAR_COAST="${0:A:h}/Resources/ownchart-coast.bin" "$WORK_DIR/gpumap_tests"

# The real global archive is generated by the data build and is optional in a
# clean source checkout. When present, exercise the complete native path:
# archive selection, 720x361 upload, Metal rendering and worldwide picks.
if [[ -d "${0:A:h}/build/global-archive" ]]; then
    [[ -s "${0:A:h}/Resources/world-coast.bin" ]] || { echo "missing world coastline asset" >&2; exit 1; }
    "$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
        -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
        Sources/mapcamera.m Sources/fieldrender.m Sources/ownchart.m Sources/hazard.m \
        Sources/pure.m tools/own-chart.m Tests/test_global_native.m \
        -framework Cocoa -framework Metal -framework QuartzCore -framework CoreText \
        -framework Accelerate -framework ImageIO -lz -o "$WORK_DIR/global_native_tests"
    ISOBAR_DATA_ROOT="${0:A:h}/build/global-archive" \
    ISOBAR_WORLD_COAST="${0:A:h}/Resources/world-coast.bin" \
        "$WORK_DIR/global_native_tests"
    "$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
        -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
        Sources/ownchart.m Sources/pure.m tools/own-chart.m Tests/test_global_classic.m \
        -framework Cocoa -framework Accelerate -framework ImageIO -lz -o "$WORK_DIR/global_classic_tests"
    ISOBAR_DATA_ROOT="${0:A:h}/build/global-archive" \
        ISOBAR_WORLD_COAST="${0:A:h}/Resources/world-coast.bin" \
        "$WORK_DIR/global_classic_tests"
fi

"$CC" -fobjc-arc -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/pure.m Tests/test_menubar.m -framework Cocoa -lz -o "$WORK_DIR/menubar_tests"
"$WORK_DIR/menubar_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/fieldrender.m Sources/ownchart.m tools/own-chart.m Sources/pure.m Sources/atmosphere.m Sources/atmospheremapview.m Sources/mapcamera.m Tests/test_atmospheremapview.m \
    -framework Cocoa -framework Metal -framework QuartzCore -framework CoreText -framework Accelerate -lz -o "$WORK_DIR/atmospheremap_tests"
"$WORK_DIR/atmospheremap_tests"

for TEST in rain aviation solar atmosphere aircraft traffic trafficroute; do
    "$CC" -fobjc-arc -Wall -Wextra -Werror \
        -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
        "Sources/${TEST}.m" "Tests/test_${TEST}.m" \
        -framework Foundation -o "$WORK_DIR/${TEST}_tests"
    "$WORK_DIR/${TEST}_tests"
done

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/aviation.m Sources/aviationview.m Sources/skyview.m Sources/solar.m Sources/atmosphere.m Sources/atmosphereview.m Sources/aircraft.m Sources/traffic.m Sources/trafficroute.m Tests/test_aviationview.m \
    -framework Cocoa -framework WebKit -o "$WORK_DIR/aviationview_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/atmosphere.m Sources/atmosphereview.m Sources/solar.m Sources/aircraft.m Sources/traffic.m Sources/trafficroute.m Tests/test_atmosphereview.m \
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

# Training mode. The web suite and the fixture snapshot always run. The
# headless window against the real archive is opt-in, so this file does not
# read ~/Data/isobar unless ISOBAR_QA_STORE is set.
if [[ ! -x training/node_modules/.bin/esbuild || ! -x training/node_modules/.bin/tsc ]]; then
    (cd training && npm install --ignore-scripts)
fi
(cd training && npm test && npm run build)

# The sky section page (training/src/sky, the web's renderer) in an offscreen
# WKWebView with the fixture store: the native feed, the drawn layers read
# back, a METAR base at its ft AMSL on the axis, no profile beyond 3 h.
"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/skyview.m Tests/test_skyview.m \
    -framework Cocoa -framework WebKit -framework QuartzCore -o "$WORK_DIR/skyview_tests"
ISOBAR_TRAINING_DIST="${0:A:h}/training/dist" "$WORK_DIR/skyview_tests" Tests/fixtures/store

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/archive.m Sources/aviation.m Sources/ownchart.m tools/own-chart.m Sources/trainingdata.m \
    Tests/test_trainingdata.m \
    -framework Cocoa -framework Accelerate -lz -lsqlite3 \
    -o "$WORK_DIR/trainingdata_tests"
"$WORK_DIR/trainingdata_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/archive.m Sources/aviation.m Sources/ownchart.m tools/own-chart.m \
    Sources/trainingdata.m Sources/trainingwindow.m \
    Tests/test_trainingwindow.m \
    -framework Cocoa -framework WebKit -framework Accelerate -lz -lsqlite3 \
    -o "$WORK_DIR/trainingwindow_tests"
"$WORK_DIR/trainingwindow_tests"

if [[ -n "${ISOBAR_QA_STORE:-}" ]]; then
    "$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
        -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
        Sources/pure.m Sources/archive.m Sources/aviation.m Sources/ownchart.m tools/own-chart.m \
        Sources/trainingdata.m Sources/trainingwindow.m tools/render-training.m \
        -framework Cocoa -framework WebKit -framework Accelerate -lz -lsqlite3 \
        -o "$WORK_DIR/render_training"
    mkdir -p build/qa/training
    for SPEC in "light 1440 900" "dark 1440 900" "light 1280 720" "dark 1280 720"; do
        APPEARANCE=${SPEC%% *}
        REST=${SPEC#* }
        WIDTH=${REST%% *}
        HEIGHT=${REST#* }
        PROGRESS="$(mktemp "${TMPDIR:-/tmp}/isobar-training-progress.XXXXXX")"
        "$WORK_DIR/render_training" "$ISOBAR_QA_STORE" "${0:A:h}/training/dist" "$APPEARANCE" "$WIDTH" "$HEIGHT" \
            "build/qa/training/${APPEARANCE}-${WIDTH}x${HEIGHT}.png" "${0:A:h}/Resources/ownchart-coast.bin" "$PROGRESS"
        rm -f "$PROGRESS"
    done
fi

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/ownchart.m tools/own-chart.m Tests/test_published_grid.m \
    -framework Cocoa -framework Accelerate -lz -o "$WORK_DIR/published_grid_tests"
"$WORK_DIR/published_grid_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/ownchart.m tools/own-chart.m Sources/rawmovie.m Sources/scrub.m Tests/test_rawmotion.m \
    -framework Cocoa -framework AVFoundation -framework CoreVideo -framework CoreMedia -framework Accelerate -lz \
    -o "$WORK_DIR/rawmotion_tests"

# The coastline must load from inside an app bundle with no environment help.
COAST_APP="$WORK_DIR/CoastCheck.app/Contents"
mkdir -p "$COAST_APP/MacOS" "$COAST_APP/Resources"
cp Resources/ownchart-coast.bin Resources/world-coast.bin "$COAST_APP/Resources/"
"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/ownchart.m Tests/test_coastbundle.m \
    -framework Cocoa -framework Accelerate -lz -o "$COAST_APP/MacOS/CoastCheck"
(unset ISOBAR_COAST; "$COAST_APP/MacOS/CoastCheck")
"$WORK_DIR/rawmotion_tests"

"$CC" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/ownchart.m tools/own-chart.m Sources/playback.m Tests/test_playback.m \
    -framework Cocoa -framework Accelerate -lz -o "$WORK_DIR/playback_tests"
"$WORK_DIR/playback_tests"

"$CC" -fobjc-arc -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    Sources/daystrip.m Sources/pure.m Tests/test_daystrip.m \
    -framework Cocoa -lz -o "$WORK_DIR/daystrip_tests"
"$WORK_DIR/daystrip_tests"

"$CC" \
    -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/rain.m Sources/rainview.m Sources/aviation.m Sources/forecastview.m Sources/aviationview.m Sources/skyview.m Sources/solar.m Sources/atmosphere.m Sources/atmosphereview.m Sources/aircraft.m Sources/traffic.m Sources/trafficroute.m Sources/notices.m Sources/notacconnection.m Sources/surfview.m Sources/motion.m Sources/rawmovie.m Sources/scrub.m Sources/mapdetail.m Sources/collector.m Sources/archive.m Sources/ownchart.m tools/own-chart.m Sources/daystrip.m Sources/fullscreenwindow.m Sources/playback.m Sources/storereload.m     Sources/mapcamera.m Sources/gpumapview.m Sources/windmapview.m Sources/hazard.m Sources/atmospheremapview.m Sources/fieldrender.m Sources/trainingdata.m Sources/trainingwindow.m Tests/test_store_refresh.m \
    -framework Cocoa -framework WebKit -framework Security -framework ServiceManagement -framework CoreLocation -framework Vision -framework CoreVideo -framework CoreMedia -framework AVFoundation -framework QuartzCore -framework Metal -framework CoreText -framework Accelerate -lz -lsqlite3 \
    -o "$WORK_DIR/store_refresh_tests"
ISOBAR_FIXTURES="${0:A:h}/Tests/fixtures" \
    ISOBAR_COAST="${0:A:h}/Resources/ownchart-coast.bin" "$WORK_DIR/store_refresh_tests"
# Score what the viewer sees: displayed autoplay, a hover sweep, and a 256x
# run long enough for two loops. A jumpy verdict fails the suite.
for MOVIE in autoplay hover fastplay; do
    JANK_ARGS=()
    # A hover starts with one intended jump from now; judge numbers per forecast hour swept.
    [[ $MOVIE == hover ]] && JANK_ARGS=(--skip 0.1 --forecast-hours "$(cat build/qa/hover.hours)")
    # Fast play opens on a fresh frame, then dissolves at each loop. Those
    # windows are intended; the spike rule is unchanged.
    if [[ $MOVIE == fastplay ]]; then
        [[ -f build/qa/fastplay.seams ]] || { echo "missing build/qa/fastplay.seams" >&2; exit 1; }
        # The open's first label set lands on frame 3 (t = 0.100), on the
        # skip boundary; skip through it, as the opening frame is meant to be.
        JANK_ARGS=(--skip 0.15)
        while IFS= read -r seam || [[ -n $seam ]]; do
            [[ -z $seam ]] && continue
            JANK_ARGS+=(--seam "$seam")
        done < build/qa/fastplay.seams
    fi
    python3 tools/measure-jank.py "build/qa/${MOVIE}.mov" --out "build/qa/${MOVIE}" "${JANK_ARGS[@]}" > "$WORK_DIR/jank-${MOVIE}.json"
    python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print("jank", sys.argv[2], s["verdict"], "numbers/min", s["number_events_per_minute"], "spikes", s["spikes"], "irregularity", s["update_gap_ms"]["irregularity"]); sys.exit(0 if s["verdict"] == "smooth" else 1)' "$WORK_DIR/jank-${MOVIE}.json" "$MOVIE"
done
# The 6 h step after 144 h. Judged per forecast hour so a short clip is not a per-minute false alarm.
python3 tools/measure-jank.py build/qa/step-boundary.mov --out build/qa/step-boundary \
    --forecast-hours "$(cat build/qa/step-boundary.hours)" > "$WORK_DIR/jank-step-boundary.json"
python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print("jank", "step-boundary", s["verdict"], "numbers/h", s.get("number_events_per_forecast_hour"), "spikes", s["spikes"], "irregularity", s["update_gap_ms"]["irregularity"]); sys.exit(0 if s["verdict"] == "smooth" else 1)' "$WORK_DIR/jank-step-boundary.json"

# Exercise real menu actions and rendered layer pixels on every build. The
# fixed clock keeps the checked-in archive useful after its forecast expires.
ISOBAR_CHECK_NOW="2026-09-26T00:30:00Z" \
    ./tools/check-layers.sh Tests/fixtures/store "$WORK_DIR/layers"
ISOBAR_CHECK_NOW="2026-09-26T00:30:00Z" \
    ./tools/check-app.sh Tests/fixtures/store "$WORK_DIR/acceptance"
# The expanded window: one header row, the popover's deck, a map that fills
# the window, docked cards, the warning badge and native Settings.
./tools/check-expanded.sh Tests/fixtures/store "$WORK_DIR/expanded"
# Exercise the controller entry point as well as the direct renderer when the
# prepared worldwide archive is available. Its model clock keeps this replay
# useful after the archived forecast expires.
if [[ -d "${0:A:h}/build/global-archive" ]]; then
    GLOBAL_ARCHIVE="${0:A:h}/build/global-archive"
    GLOBAL_CLOCK=$(python3 - "$GLOBAL_ARCHIVE" <<'PY'
import json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
family = Path(sys.argv[1]) / 'products/grids/ecmwf_ifs_global'
run = json.loads((family / 'current.json').read_text())['latest']
clock = datetime.strptime(run, '%Y%m%dT%HZ').replace(tzinfo=timezone.utc) + timedelta(minutes=30)
print(clock.isoformat().replace('+00:00', 'Z'))
PY
)
    ISOBAR_CHECK_NOW="$GLOBAL_CLOCK" \
    ISOBAR_WORLD_COAST="${0:A:h}/Resources/world-coast.bin" \
        ./tools/check-expanded.sh "$GLOBAL_ARCHIVE" "$WORK_DIR/global-expanded"
fi
ISOBAR_CHECK_NOW="2026-09-26T00:30:00Z" \
    ./tools/check-popover-live.sh Tests/fixtures/store "$WORK_DIR/popover-live"
# What people do (docs/design/user-journeys.md): zoom in, change lens, pan,
# hold. The view and the forecast time must stay where the user put them.
./tools/check-journeys.sh Tests/fixtures/store
if [[ -d "${0:A:h}/build/global-archive" ]]; then
    ISOBAR_CHECK_NOW="$GLOBAL_CLOCK" ISOBAR_WORLD_COAST="${0:A:h}/Resources/world-coast.bin" \
        ./tools/check-journeys.sh "${0:A:h}/build/global-archive"
fi

# Map Lab is a developer viewer, offscreen only. The suite uses the checked-in
# field fixture and does not read ~/Data/isobar or open a window.
MAP_STORE="${0:A:h}/Tests/fixtures/fieldrender"
if [[ ! -f "$MAP_STORE/header.json" || ! -f "$MAP_STORE/mslp-0.f16" || ! -f "$MAP_STORE/mslp-1.f16" ]]; then
    echo "map-lab self-test: SKIP no field fixture"
else
    ./tools/build-map-lab.sh
    ISOBAR_COAST="${0:A:h}/Resources/ownchart-coast.bin" \
        ./build/MapLab.app/Contents/MacOS/MapLab --selftest --store "$MAP_STORE"
fi
