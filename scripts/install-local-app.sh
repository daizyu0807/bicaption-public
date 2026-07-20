#!/usr/bin/env bash
# install-local-app.sh — install local BiCaption.app to /Applications and
# remove the release app bundle afterward to avoid duplicate apps in Finder.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
SOURCE_APP="${1:-$PROJECT_ROOT/release/mac-arm64/BiCaption.app}"
TARGET_APP="/Applications/BiCaption.app"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

if [ ! -d "$SOURCE_APP" ]; then
  fail "App bundle not found: $SOURCE_APP"
fi

info "Installing from: $SOURCE_APP"
info "Target: $TARGET_APP"

pkill -x BiCaption >/dev/null 2>&1 || true

if [ "${BICAPTION_RESET_TCC:-0}" = "1" ]; then
  info "Resetting app-level TCC entries because BICAPTION_RESET_TCC=1"
  tccutil reset Accessibility com.davedai.bicaption >/dev/null 2>&1 || true
  tccutil reset ListenEvent com.davedai.bicaption >/dev/null 2>&1 || true
  tccutil reset ListenEvent com.davedai.bicaption.global-hotkey-helper >/dev/null 2>&1 || true
  tccutil reset ScreenCapture com.davedai.bicaption >/dev/null 2>&1 || true
  tccutil reset ScreenCapture com.davedai.bicaption.apple-stt-helper >/dev/null 2>&1 || true
fi

rm -rf "$TARGET_APP"
# Preserve bundle metadata and signatures when installing into /Applications.
ditto "$SOURCE_APP" "$TARGET_APP"
codesign -v "$TARGET_APP"
pass "Installed to /Applications"

# Refresh LaunchServices and icon cache so System Settings / Finder picks up
# the app icon after local reinstall.
"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" -f "$TARGET_APP" >/dev/null 2>&1 || true
touch "$TARGET_APP" "$TARGET_APP/Contents/Info.plist" >/dev/null 2>&1 || true
[ -f "$TARGET_APP/Contents/Resources/icon.icns" ] && touch "$TARGET_APP/Contents/Resources/icon.icns" >/dev/null 2>&1 || true
[ -f "$TARGET_APP/Contents/Resources/AppleSTTHelper.app/Contents/Resources/icon.icns" ] && touch "$TARGET_APP/Contents/Resources/AppleSTTHelper.app/Contents/Resources/icon.icns" >/dev/null 2>&1 || true
killall Finder >/dev/null 2>&1 || true
killall Dock >/dev/null 2>&1 || true
pass "Refreshed app registration and icon cache"

rm -rf "$SOURCE_APP"
pass "Removed release app bundle to avoid duplicate apps"

info "Remaining installed app:"
printf '%s\n' "$TARGET_APP"
