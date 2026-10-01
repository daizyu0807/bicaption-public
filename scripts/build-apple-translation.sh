#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/AppleTranslationHelper.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -parse-as-library -target arm64-apple-macos13 \
  -module-cache-path "${TMPDIR:-/tmp}/bicaption-translation-module-cache" \
  "$ROOT/swift/apple-translation.swift" -framework AppKit -framework SwiftUI \
  -framework Translation -o "$APP/Contents/MacOS/apple-translation"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.davedai.bicaption.apple-translation-helper</string>
<key>CFBundleName</key><string>BiCaption</string>
<key>CFBundleDisplayName</key><string>BiCaption 使用準備</string>
<key>CFBundleExecutable</key><string>apple-translation</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
