#!/bin/zsh
# Build, notarize, staple and verify Isobar, then install it into /Applications.
# Every step must succeed; nothing is installed unless the exact build is
# notarized, stapled and accepted by Gatekeeper as a quarantined download.
#   tools/release-local.sh            build + notarize + install
#   tools/release-local.sh --no-install
set -euo pipefail
cd "${0:A:h}/.."
INSTALL=1; [[ "${1:-}" == --no-install ]] && INSTALL=0
PROFILE="${ISOBAR_NOTARY_PROFILE:-isobar-notary}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/isobar-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

want=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Info.plist)
echo "== build $(git rev-parse --short HEAD) v$want"
ISOBAR_TIMESTAMP=1 ./build.sh > "$WORK/build.log" 2>&1 || { mkdir -p build; cp "$WORK/build.log" build/release-build.log; grep -E "^FAIL|failures: [1-9]" "$WORK/build.log" | head -20; tail -40 "$WORK/build.log"; echo "release: build failed (full log: build/release-build.log)" >&2; exit 1; }
got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' build/Isobar.app/Contents/Info.plist)
[[ "$got" == "$want" ]] || { echo "release: built app is $got, expected $want" >&2; exit 1; }

APP="$WORK/Isobar.app"
ditto build/Isobar.app "$APP"
ditto -c -k --keepParent "$APP" "$WORK/upload.zip"
echo "== notarize"
xcrun notarytool submit "$WORK/upload.zip" --keychain-profile "$PROFILE" --wait --output-format json > "$WORK/notary.json"
notary_status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$WORK/notary.json")
[[ "$notary_status" == Accepted ]] || { cat "$WORK/notary.json"; echo "release: notarization $notary_status" >&2; exit 1; }
xcrun stapler staple "$APP" > /dev/null
xcrun stapler validate "$APP" > /dev/null

echo "== quarantined Gatekeeper check"
ditto -c -k --keepParent "$APP" "$WORK/download.zip"
mkdir "$WORK/download"; ditto -x -k "$WORK/download.zip" "$WORK/download"
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" "$WORK/download/Isobar.app"
spctl -a -t exec "$WORK/download/Isobar.app" || { spctl -a -vv -t exec "$WORK/download/Isobar.app"; exit 1; }
python3 tools/check-bundle.py "$APP" > /dev/null

mkdir -p build/release-app
[[ -e build/release-app/Isobar.app ]] && trash build/release-app/Isobar.app
ditto "$APP" build/release-app/Isobar.app
echo "verified: build/release-app/Isobar.app v$got"
(( INSTALL )) || exit 0

echo "== install"
osascript -e 'tell application id "com.iantodd.isobar" to quit' 2>/dev/null || true
for i in {1..10}; do pgrep -xq Isobar || break; sleep 1; done
pkill -x Isobar 2>/dev/null || true
for i in {1..5}; do pgrep -xq Isobar || break; sleep 1; done
[[ -e /Applications/Isobar.app ]] && trash /Applications/Isobar.app
ditto "$APP" /Applications/Isobar.app
spctl -a -t exec /Applications/Isobar.app
open -g -a /Applications/Isobar.app
sleep 2; pgrep -xq Isobar || { echo "release: Isobar did not start" >&2; exit 1; }
echo "installed and running: v$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Isobar.app/Contents/Info.plist)"
