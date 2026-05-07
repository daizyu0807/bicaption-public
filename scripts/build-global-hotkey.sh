#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SWIFT_SRC="$PROJECT_ROOT/swift/global-hotkey.swift"
OUTPUT="$PROJECT_ROOT/python/global-hotkey"
HELPER_OUTPUT="$PROJECT_ROOT/GlobalHotkeyHelper.app/Contents/MacOS/global-hotkey"
HELPER_BUNDLE="$PROJECT_ROOT/GlobalHotkeyHelper.app"
HELPER_BUNDLE_ID="com.davedai.bicaption.global-hotkey-helper"

echo "Compiling global-hotkey..."
mkdir -p /tmp/clang-module-cache
mkdir -p "$(dirname "$HELPER_OUTPUT")"
SDKROOT="$(xcrun --show-sdk-path)"
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

codesign --force --sign - --identifier "$HELPER_BUNDLE_ID" "$HELPER_OUTPUT"
codesign --force --sign - --identifier "$HELPER_BUNDLE_ID" "$HELPER_BUNDLE"

echo "Built: $OUTPUT"
echo "Synced helper app binary: $HELPER_OUTPUT"
