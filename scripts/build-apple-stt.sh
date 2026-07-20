#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SWIFT_SRC="$PROJECT_ROOT/swift/apple-stt.swift"
OUTPUT="$PROJECT_ROOT/python/apple-stt"
MODULE_CACHE_DIR="${TMPDIR:-/tmp}/bicaption-swift-module-cache"

APP_BUNDLE="$PROJECT_ROOT/AppleSTTHelper.app"
APP_BIN_DIR="$APP_BUNDLE/Contents/MacOS"
HELPER_BUNDLE_ID="com.davedai.bicaption.apple-stt-helper"

SDK_PATH="$(xcrun --show-sdk-path)"
if [[ "${SDK_PATH}" == *"/CommandLineTools/SDKs/MacOSX.sdk" ]]; then
  if [[ -d "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk" ]]; then
    SDK_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"
  elif [[ -d "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk" ]]; then
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

# Regenerate Info.plist. The usage-description keys are mandatory: when TCC
# needs to prompt (fresh grant, moved bundle, new signature) and the key is
# missing, macOS kills the helper with SIGABRT instead of showing the prompt.
cat > "$APP_BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>apple-stt</string>
	<key>CFBundleIconFile</key>
	<string>icon.icns</string>
	<key>CFBundleIdentifier</key>
	<string>com.davedai.bicaption.apple-stt-helper</string>
	<key>CFBundleDisplayName</key>
	<string>BiCaption</string>
	<key>CFBundleName</key>
	<string>BiCaption</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleVersion</key>
	<string>1.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSSpeechRecognitionUsageDescription</key>
	<string>BiCaption needs speech recognition access to provide Apple native speech-to-text features.</string>
	<key>NSMicrophoneUsageDescription</key>
	<string>BiCaption needs microphone access to capture audio for real-time speech recognition.</string>
	<key>NSAudioCaptureUsageDescription</key>
	<string>BiCaption needs audio capture access to capture system audio for real-time subtitles.</string>
	<key>NSScreenCaptureUsageDescription</key>
	<string>BiCaption needs screen capture access to capture system audio for real-time subtitles.</string>
</dict>
</plist>
PLIST

codesign --force --sign - --identifier "$HELPER_BUNDLE_ID" "$APP_BIN_DIR/apple-stt"
codesign --force --sign - --identifier "$HELPER_BUNDLE_ID" "$APP_BUNDLE"

echo "Bundled: $APP_BIN_DIR/apple-stt"
