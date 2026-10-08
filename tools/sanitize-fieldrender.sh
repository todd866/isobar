#!/bin/zsh
# AddressSanitizer and ThreadSanitizer for the GPU field renderer.
# The async entry plays 600 frames with the contour worker live.
# Does not edit tools/sanitize.sh. No windows.
set -euo pipefail
cd "${0:A:h}/.."
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
CC="$(xcrun --find clang)"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/isobar-fieldrender-sanitize.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export ASAN_OPTIONS=abort_on_error=1:detect_stack_use_after_return=1
export UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
SRC=(Sources/fieldrender.m Sources/ownchart.m Sources/hazard.m Tests/test_fieldrender.m)
FRAME=(-framework Foundation -framework Metal -framework CoreGraphics -framework CoreText -framework Accelerate)
COAST="ISOBAR_COAST=$PWD/Resources/ownchart-coast.bin"

"$CC" -fobjc-arc -g -O1 -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined \
    -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    "${SRC[@]}" "${FRAME[@]}" -o "$WORK_DIR/fieldrender_asan"
env $COAST "$WORK_DIR/fieldrender_asan" > "$WORK_DIR/asan.log" 2>&1 || { cat "$WORK_DIR/asan.log"; exit 1; }
env $COAST "$WORK_DIR/fieldrender_asan" --async > "$WORK_DIR/asan-async.log" 2>&1 || { cat "$WORK_DIR/asan-async.log"; exit 1; }

"$CC" -fobjc-arc -g -O1 -fno-omit-frame-pointer -fsanitize=thread \
    -Wall -Wextra -Werror -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources \
    "${SRC[@]}" "${FRAME[@]}" -o "$WORK_DIR/fieldrender_tsan"
TSAN_OPTIONS=halt_on_error=1 env $COAST "$WORK_DIR/fieldrender_tsan" --async > "$WORK_DIR/tsan.log" 2>&1 || { cat "$WORK_DIR/tsan.log"; exit 1; }
if grep -E 'ThreadSanitizer:|WARNING: ThreadSanitizer' "$WORK_DIR/tsan.log"; then
    cat "$WORK_DIR/tsan.log"
    exit 1
fi
echo "sanitize-fieldrender: ASan suite, ASan async and TSan async are clean"
