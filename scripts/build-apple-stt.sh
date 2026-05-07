#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SWIFT_SRC="$PROJECT_ROOT/swift/apple-stt.swift"
OUTPUT="$PROJECT_ROOT/python/apple-stt"
MODULE_CACHE_DIR="${TMPDIR:-/tmp}/bicaption-swift-module-cache"

APP_BUNDLE="$PROJECT_ROOT/AppleSTTHelper.app"
APP_BIN_DIR="$APP_BUNDLE/Contents/MacOS"
APP_INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
HELPER_BUNDLE_ID="com.davedai.bicaption.apple-stt-helper"

SDK_PATH="$(xcrun --show-sdk-path)"
if [[ "${SDK_PATH}" == *"/CommandLineTools/SDKs/MacOSX.sdk" ]]; then
  if [[ -d "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk" ]]; then
    SDK_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk"
  fi
fi

mkdir -p "$MODULE_CACHE_DIR"

echo "Compiling apple-stt..."
swiftc -O \
  -target arm64-apple-macos13 \
  -sdk "$SDK_PATH" \
  -module-cache-path "$MODULE_CACHE_DIR" \
  -o "$OUTPUT" \
  "$SWIFT_SRC" \
  -framework Speech \
  -framework AVFoundation \
  -framework ScreenCaptureKit \
  -framework CoreMedia \
  -framework AppKit

echo "Built: $OUTPUT"

# Copy into .app bundle (required for stable ScreenCaptureKit XPC on macOS 15+)
mkdir -p "$APP_BIN_DIR"
cp "$OUTPUT" "$APP_BIN_DIR/apple-stt"

if [[ ! -f "$APP_INFO_PLIST" ]]; then
  cat > "$APP_INFO_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>apple-stt</string>
  <key>CFBundleIdentifier</key>
  <string>$HELPER_BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>BiCaption Apple STT Helper</string>
  <key>CFBundleDisplayName</key>
  <string>BiCaption Apple STT Helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>BiCaption needs speech recognition access to provide Apple native speech-to-text features.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>BiCaption needs microphone access to capture audio for speech recognition.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>BiCaption needs screen capture access to capture system audio for realtime subtitles.</string>
</dict>
</plist>
EOF
fi

codesign --force --sign - --identifier "$HELPER_BUNDLE_ID" "$APP_BIN_DIR/apple-stt"
codesign --force --sign - --identifier "$HELPER_BUNDLE_ID" "$APP_BUNDLE"

echo "Bundled: $APP_BIN_DIR/apple-stt"
