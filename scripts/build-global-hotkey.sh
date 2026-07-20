#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SWIFT_SRC="$PROJECT_ROOT/swift/global-hotkey.swift"
OUTPUT="$PROJECT_ROOT/python/global-hotkey"
HELPER_OUTPUT="$PROJECT_ROOT/GlobalHotkeyHelper.app/Contents/MacOS/global-hotkey"
HELPER_BUNDLE="$PROJECT_ROOT/GlobalHotkeyHelper.app"
HELPER_BUNDLE_ID="com.davedai.bicaption.global-hotkey-helper"
HELPER_INFO_PLIST="$HELPER_BUNDLE/Contents/Info.plist"

echo "Compiling global-hotkey..."
mkdir -p /tmp/clang-module-cache
mkdir -p "$(dirname "$HELPER_OUTPUT")"
SDKROOT="$(xcrun --show-sdk-path)"
if [[ "$SDKROOT" == *"/CommandLineTools/SDKs/MacOSX.sdk" ]]; then
  if [[ -d "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk" ]]; then
    SDKROOT="/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"
  elif [[ -d "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk" ]]; then
    SDKROOT="/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk"
  fi
fi
xcrun swiftc \
  -module-cache-path /tmp/clang-module-cache \
  -sdk "$SDKROOT" \
  -O \
  -target arm64-apple-macos13 \
  -o "$OUTPUT" \
  "$SWIFT_SRC" \
  -framework ApplicationServices \
  -framework Foundation

cp "$OUTPUT" "$HELPER_OUTPUT"

cat > "$HELPER_INFO_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>global-hotkey</string>
	<key>CFBundleIdentifier</key>
	<string>com.davedai.bicaption.global-hotkey-helper</string>
	<key>CFBundleDisplayName</key>
	<string>BiCaption</string>
	<key>CFBundleName</key>
	<string>BiCaption</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleVersion</key>
	<string>1.0</string>
	<key>LSBackgroundOnly</key>
	<true/>
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
PLIST

codesign --force --sign - --identifier "$HELPER_BUNDLE_ID" "$HELPER_OUTPUT"
codesign --force --sign - --identifier "$HELPER_BUNDLE_ID" "$HELPER_BUNDLE"

echo "Built: $OUTPUT"
echo "Synced helper app binary: $HELPER_OUTPUT"
