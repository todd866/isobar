#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
mkdir -p build
clang -fobjc-arc -O2 -Wall -Wextra -Werror -mmacosx-version-min=13.0 -ISources -DISOBAR_APP \
    Sources/pure.m Sources/ownchart.m tools/own-chart.m Sources/rawmovie.m tools/raw-movie.m \
    -framework Cocoa -framework AVFoundation -framework CoreVideo -framework CoreMedia -framework Accelerate -lz -o build/raw-movie
exec build/raw-movie "$@"
