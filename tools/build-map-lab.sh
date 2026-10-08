#!/bin/zsh
# Build the Map Lab developer app into build/MapLab.app.
# Ad-hoc signature only. Does not touch /Applications or the installed Isobar.
# Open:  open build/MapLab.app
#        build/MapLab.app/Contents/MacOS/MapLab --store ~/Data/isobar
set -euo pipefail
cd "${0:A:h}/.."
MINIMUM_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
APP="build/MapLab.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Resources/ownchart-coast.bin "$APP/Contents/Resources/ownchart-coast.bin"
cat > "$APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>MapLab</string>
	<key>CFBundleIdentifier</key>
	<string>com.iantodd.maplab</string>
	<key>CFBundleName</key>
	<string>Map Lab</string>
	<key>CFBundleDisplayName</key>
	<string>Map Lab</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>15.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
PLIST
"$(xcrun --find clang)" -fobjc-arc -O2 -Wall -Wextra -Werror \
    -isysroot "$SDKROOT" "-mmacosx-version-min=$MINIMUM_MACOS" \
    -ISources -DISOBAR_APP \
    Sources/mapcamera.m Sources/fieldrender.m Sources/ownchart.m Sources/pure.m tools/own-chart.m tools/map-lab.m \
    -framework Foundation -framework Cocoa -framework Metal -framework QuartzCore \
    -framework CoreGraphics -framework CoreText -framework Accelerate -lz \
    -o "$APP/Contents/MacOS/MapLab"
codesign --force --sign - "$APP"
echo "built $APP"
