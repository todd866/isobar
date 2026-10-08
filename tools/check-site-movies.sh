#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
MANIFEST=${1:-site/data/current.json}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/isobar-check-movies.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
"$(xcrun --find clang)" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$(xcrun --sdk macosx --show-sdk-path)" "-mmacosx-version-min=$MINIMUM_MACOS" \
  tools/check-site-movies.m -framework Foundation -framework AVFoundation -framework CoreMedia \
  -o "$WORK/check-site-movies"
"$WORK/check-site-movies" "$MANIFEST"
