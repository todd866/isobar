#!/bin/zsh
# Build Isobar.app and its self-contained weather collector.
set -euo pipefail
cd "${0:A:h}"

CC="${CC:-$(xcrun --find clang)}"
SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
BUILD_DIR="build"
OUTPUT_APP="$BUILD_DIR/Isobar.app"
mkdir -p "$BUILD_DIR"
STAGING_DIR="$(mktemp -d "$BUILD_DIR/.isobar-build.XXXXXX")"
APP="$STAGING_DIR/Isobar.app"

cleanup() { rm -rf "$STAGING_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

./tests.sh
plutil -lint Info.plist >/dev/null
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
if [[ ! "$MINIMUM_MACOS" =~ '^[0-9]+\.[0-9]+(\.[0-9]+)?$' ]]; then
    echo "build.sh: ERROR — Info.plist must declare a numeric minimum macOS version." >&2
    exit 1
fi
SHORT=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Info.plist)
BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' Info.plist)
if [[ "$SHORT" != "1.10.3" || "$BUILD" != "32" ]]; then
    echo "build.sh: ERROR — Info.plist version is ${SHORT} (${BUILD}); expected 1.10.3 (32)." >&2
    exit 1
fi

ARCH_FLAGS=()
ARCH_DESCRIPTION="native"
ARCHS_VALUE="${ISOBAR_ARCHS:-native}"
if [[ "$ARCHS_VALUE" != "native" ]]; then
    ARCHS=("${(@z)ARCHS_VALUE}")
    if (( ${#ARCHS[@]} == 0 )); then
        echo "build.sh: ERROR — ISOBAR_ARCHS must be 'native' or a space-separated architecture list." >&2
        exit 1
    fi
    for ARCH in "${ARCHS[@]}"; do
        case "$ARCH" in
            arm64|x86_64) ARCH_FLAGS+=(-arch "$ARCH") ;;
            *)
                echo "build.sh: ERROR — unsupported architecture '$ARCH' (expected arm64 or x86_64)." >&2
                exit 1
                ;;
        esac
    done
    ARCH_DESCRIPTION="${(j: :)ARCHS}"
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
"$CC" \
    -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" \
    "-mmacosx-version-min=$MINIMUM_MACOS" \
    "${ARCH_FLAGS[@]}" \
    -ISources \
    -DISOBAR_APP \
    Sources/pure.m Sources/rain.m Sources/rainview.m Sources/aviation.m Sources/forecastview.m Sources/aviationview.m Sources/solar.m Sources/atmosphere.m Sources/atmosphereview.m Sources/aircraft.m Sources/traffic.m Sources/notices.m Sources/notacconnection.m Sources/surfview.m Sources/motion.m Sources/rawmovie.m Sources/scrub.m Sources/mapdetail.m Sources/collector.m Sources/archive.m Sources/ownchart.m tools/own-chart.m Sources/daystrip.m Sources/fullscreenwindow.m Sources/playback.m Sources/storereload.m     Sources/mapcamera.m Sources/gpumapview.m Sources/hazard.m Sources/fieldrender.m Sources/trainingdata.m Sources/trainingwindow.m Sources/main.m \
    -framework Cocoa -framework WebKit -framework Security -framework ServiceManagement -framework CoreLocation -framework Vision -framework CoreVideo -framework CoreMedia -framework AVFoundation -framework QuartzCore -framework Metal -framework CoreText -framework Accelerate -lz -lsqlite3 \
    -o "$APP/Contents/MacOS/Isobar"
install -m 0644 Info.plist "$APP/Contents/Info.plist"
for catalogue in stations-wa.json stations-nsw.json stations-vic.json; do
    install -m 0644 "Tests/fixtures/$catalogue" "$APP/Contents/Resources/$catalogue"
done
install -m 0644 Resources/ownchart-coast.bin "$APP/Contents/Resources/ownchart-coast.bin"
install -m 0644 Resources/world-coast.bin "$APP/Contents/Resources/world-coast.bin"
install -m 0644 Resources/world-places.json "$APP/Contents/Resources/world-places.json"
ditto Resources/Aviation "$APP/Contents/Resources/Aviation"
if ! command -v npm >/dev/null 2>&1; then
    echo "build.sh: ERROR — npm is not available, so the offline trainer cannot be built from training/." >&2
    exit 1
fi
if [[ ! -x training/node_modules/.bin/esbuild ]]; then
    (cd training && npm install --ignore-scripts) || {
        echo "build.sh: ERROR — npm install failed in training/. The trainer is built in this step and is not downloaded later." >&2
        exit 1
    }
fi
(cd training && npm run build) || {
    echo "build.sh: ERROR — the trainer failed to build from training/." >&2
    exit 1
}
for need in training/dist/index.html training/dist/app.js training/dist/app.css; do
    if [[ ! -f $need ]]; then
        echo "build.sh: ERROR — the trainer build did not produce $need." >&2
        exit 1
    fi
done
ditto training/dist "$APP/Contents/Resources/training"

if [[ "${ISOBAR_BUNDLE_COLLECTOR:-1}" == "1" ]]; then
    if [[ -n "${ISOBAR_COLLECTOR_DIR:-}" ]]; then
        ditto "$ISOBAR_COLLECTOR_DIR" "$APP/Contents/Resources/collector"
    else
        ./tools/build-collector.sh --output "$APP/Contents/Resources/collector"
    fi
    python3 tools/check-bundle.py "$APP" --unsigned
fi

DEVELOPER_ID=$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -m1 "Developer ID Application" | sed -E 's/^[^"]*"([^"]+)".*/\1/' || true)
if [[ -n "${ISOBAR_CODESIGN_IDENTITY:-}" ]]; then
    IDENTITY="$ISOBAR_CODESIGN_IDENTITY"
    if ! security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
        echo "build.sh: ERROR — ISOBAR_CODESIGN_IDENTITY '$IDENTITY' is not available." >&2
        exit 1
    fi
elif [[ "${ISOBAR_ADHOC:-0}" == "1" ]]; then
    IDENTITY="-"
    echo "Signing: ad-hoc (ISOBAR_ADHOC=1)"
elif [[ -n "$DEVELOPER_ID" ]]; then
    IDENTITY="$DEVELOPER_ID"
else
    IDENTITY="-"
    echo "build.sh: WARNING — no Developer ID found. Falling back to ad-hoc signing." >&2
    echo "  Every rebuild changes the code identity, so Launch at Login is re-registered." >&2
fi

CODESIGN_ARGS=(--force --sign "$IDENTITY")
if [[ "${ISOBAR_HARDENED_RUNTIME:-1}" == "1" ]]; then
    CODESIGN_ARGS+=(--options runtime)
elif [[ "${ISOBAR_HARDENED_RUNTIME:-1}" != "0" ]]; then
    echo "build.sh: ERROR — ISOBAR_HARDENED_RUNTIME must be 0 or 1." >&2
    exit 1
fi
if [[ "${ISOBAR_TIMESTAMP:-0}" == "1" ]]; then
    if [[ "$IDENTITY" == "-" ]]; then
        echo "build.sh: ERROR — timestamping requires an explicit signing identity." >&2
        exit 1
    fi
    CODESIGN_ARGS+=(--timestamp)
elif [[ "${ISOBAR_TIMESTAMP:-0}" != "0" ]]; then
    echo "build.sh: ERROR — ISOBAR_TIMESTAMP must be 0 or 1." >&2
    exit 1
fi

echo "Architectures: $ARCH_DESCRIPTION"
echo "Signing identity: $IDENTITY"
if [[ -d "$APP/Contents/Resources/collector" ]]; then
    # Sign the innermost binaries before their containing framework/app.
    while IFS= read -r -d '' BINARY; do
        if file -b "$BINARY" | grep -q 'Mach-O'; then
            codesign "${CODESIGN_ARGS[@]}" "$BINARY"
        fi
    done < <(find "$APP/Contents/Resources/collector" -type f -print0)
    while IFS= read -r -d '' FRAMEWORK; do
        codesign "${CODESIGN_ARGS[@]}" "$FRAMEWORK"
    done < <(find "$APP/Contents/Resources/collector" -depth -type d -name '*.framework' -print0)
fi
codesign "${CODESIGN_ARGS[@]}" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
if [[ -d "$APP/Contents/Resources/collector" ]]; then
    python3 tools/check-bundle.py "$APP"
fi
rm -rf "$OUTPUT_APP"
mv "$APP" "$OUTPUT_APP"
echo "Built $OUTPUT_APP"
