#!/bin/zsh
# Runs the C-heavy unit tests under AddressSanitizer and UndefinedBehaviorSanitizer,
# and the concurrent-render test under ThreadSanitizer.
# The grid, contour and motion code allocates by hand; the normal suite builds
# without sanitizers, so out-of-bounds reads would otherwise go unnoticed.
set -euo pipefail
cd "${0:A:h}/.."
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
CC="$(xcrun --find clang)"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/isobar-sanitize.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export ASAN_OPTIONS=abort_on_error=1:detect_stack_use_after_return=1
export UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
FLAGS=(-fobjc-arc -g -O1 -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined
    -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources)
build() { local name=$1; shift; "$CC" "${FLAGS[@]}" "$@" -o "$WORK_DIR/$name"; }

build pure Sources/pure.m Tests/test_pure.m -framework Foundation -lz
ISOBAR_FIXTURES="$PWD/Tests/fixtures" "$WORK_DIR/pure" > "$WORK_DIR/pure.log" 2>&1 || { cat "$WORK_DIR/pure.log"; exit 1; }
build archive Sources/pure.m Sources/archive.m Tests/test_archive.m -framework Foundation -lz -lsqlite3
"$WORK_DIR/archive"
build ownchart Sources/ownchart.m Tests/test_ownchart.m -framework Foundation -framework Accelerate
ISOBAR_COAST="$PWD/Resources/ownchart-coast.bin" "$WORK_DIR/ownchart" > "$WORK_DIR/ownchart.log" 2>&1 || { cat "$WORK_DIR/ownchart.log"; exit 1; }
build published_grid -DISOBAR_APP Sources/pure.m Sources/ownchart.m tools/own-chart.m Tests/test_published_grid.m \
    -framework Cocoa -framework Accelerate -lz
"$WORK_DIR/published_grid" > "$WORK_DIR/published_grid.log" 2>&1 || { cat "$WORK_DIR/published_grid.log"; exit 1; }
# Match the real-world acceptance in tests.sh when its prepared archive exists.
# This exercises the global coastline allocations and cache scale transitions.
if [[ -d "$PWD/build/global-archive" ]]; then
    build global_classic -DISOBAR_APP Sources/pure.m Sources/ownchart.m tools/own-chart.m Tests/test_global_classic.m \
        -framework Cocoa -framework Accelerate -framework ImageIO -lz
    ISOBAR_DATA_ROOT="$PWD/build/global-archive" ISOBAR_WORLD_COAST="$PWD/Resources/world-coast.bin" \
        "$WORK_DIR/global_classic" > "$WORK_DIR/global_classic.log" 2>&1 || { cat "$WORK_DIR/global_classic.log"; exit 1; }
    echo "sanitize: global archive and classic coastline are clean"
fi
build rawmotion -DISOBAR_APP Sources/pure.m Sources/ownchart.m tools/own-chart.m Sources/rawmovie.m Sources/scrub.m Tests/test_rawmotion.m \
    -framework Cocoa -framework AVFoundation -framework CoreVideo -framework CoreMedia -framework Accelerate -lz
"$WORK_DIR/rawmotion" > "$WORK_DIR/rawmotion.log" 2>&1 || { cat "$WORK_DIR/rawmotion.log"; exit 1; }
build motion Sources/motion.m Tests/test_motion.m -framework Cocoa -framework Vision -framework CoreVideo \
    -framework CoreMedia -framework AVFoundation -framework Accelerate
"$WORK_DIR/motion" > "$WORK_DIR/motion.log" 2>&1 || { cat "$WORK_DIR/motion.log"; exit 1; }
# ThreadSanitizer needs its own build. The grid test renders labelled charts on
# several threads at once, as the live player, chart preparation and scrub do.
"$CC" -fobjc-arc -g -O1 -fno-omit-frame-pointer -fsanitize=thread -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/ownchart.m tools/own-chart.m Tests/test_published_grid.m \
    -framework Cocoa -framework Accelerate -lz -o "$WORK_DIR/published_grid_tsan"
TSAN_OPTIONS=halt_on_error=1 "$WORK_DIR/published_grid_tsan" > "$WORK_DIR/published_grid_tsan.log" 2>&1 || { cat "$WORK_DIR/published_grid_tsan.log"; exit 1; }
echo "sanitize: pure, archive, ownchart, published grid, raw motion and motion are clean; concurrent renders are race-free"
