#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
mkdir -p build
"$(xcrun --find clang)" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$(xcrun --sdk macosx --show-sdk-path)" "-mmacosx-version-min=$MINIMUM_MACOS" -ISources -DISOBAR_APP \
    Sources/pure.m Sources/ownchart.m tools/own-chart.m Sources/rawmovie.m tools/raw-movie.m \
    -framework Cocoa -framework AVFoundation -framework CoreVideo -framework CoreMedia -framework Accelerate -lz -o build/raw-movie
exec build/raw-movie "$@"
