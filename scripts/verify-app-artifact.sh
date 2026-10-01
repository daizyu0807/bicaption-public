#!/usr/bin/env bash
# verify-app-artifact.sh — Post-build validation for BiCaption.app
# Run after `npm run dist`, BEFORE installing to /Applications.
# Exit code 0 = all checks passed, non-zero = issues found.

set -euo pipefail

APP="${1:-release/mac-arm64/BiCaption.app}"
EXPECTED_BUNDLE_ID="com.davedai.bicaption"
EXPECTED_APPLE_STT_HELPER_ID="com.davedai.bicaption.apple-stt-helper"
EXPECTED_GLOBAL_HOTKEY_HELPER_ID="com.davedai.bicaption.global-hotkey-helper"
ERRORS=0

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; ERRORS=$((ERRORS + 1)); }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }

echo "=== BiCaption App Artifact Verification ==="
echo "Target: $APP"
echo ""

# ── 1. App bundle exists ──
if [ -d "$APP" ]; then
  pass "App bundle exists"
else
  fail "App bundle NOT found at $APP"
  exit 1
fi

# ── 2. Bundle ID ──
BUNDLE_ID=$(plutil -extract CFBundleIdentifier raw "$APP/Contents/Info.plist" 2>/dev/null || echo "")
if [ "$BUNDLE_ID" = "$EXPECTED_BUNDLE_ID" ]; then
  pass "Bundle ID: $BUNDLE_ID"
else
  fail "Bundle ID mismatch: got '$BUNDLE_ID', expected '$EXPECTED_BUNDLE_ID'"
fi

# ── 3. Version ──
VERSION=$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || echo "unknown")
info "Version: $VERSION"

# ── 4. Code signature ──
if codesign -v "$APP" 2>/dev/null; then
  pass "Code signature valid"
  SIGN_ID=$(codesign -d --verbose=2 "$APP" 2>&1 | grep "Identifier=" | head -1 || echo "")
  info "Signature: $SIGN_ID"
else
  fail "Code signature INVALID"
fi

# ── 5. Main binary ──
MAIN_BIN="$APP/Contents/MacOS/BiCaption"
if [ -x "$MAIN_BIN" ]; then
  pass "Main binary executable"
  ARCH=$(file "$MAIN_BIN" | grep -o 'arm64\|x86_64' | head -1 || echo "unknown")
  info "Architecture: $ARCH"
else
  fail "Main binary missing or not executable"
fi

# ── 6. Sidecar binary ──
SIDECAR="$APP/Contents/Resources/sidecar/bicaption-sidecar"
if [ -x "$SIDECAR" ]; then
  pass "Sidecar binary executable"
else
  fail "Sidecar binary missing or not executable: $SIDECAR"
fi

# ── 7. Sidecar code signature ──
if [ -x "$SIDECAR" ]; then
  if codesign -v "$SIDECAR" 2>/dev/null; then
    pass "Sidecar code signature valid"
    # Check entitlements
    ENTITLEMENTS=$(codesign -d --entitlements - "$SIDECAR" 2>&1 || echo "")
    if echo "$ENTITLEMENTS" | grep -q "audio-input\|com.apple.security.device.audio-input"; then
      pass "Sidecar has audio-input entitlement"
    else
      fail "Sidecar MISSING audio-input entitlement"
    fi
  else
    fail "Sidecar code signature INVALID"
  fi
fi

# ── 8. Sidecar list-devices (basic health check) ──
if [ -x "$SIDECAR" ]; then
  PROBE_OUTPUT=$("$SIDECAR" --list-devices 2>&1) && PROBE_EXIT=0 || PROBE_EXIT=$?
  if [ $PROBE_EXIT -eq 0 ]; then
    DEVICE_COUNT=$(echo "$PROBE_OUTPUT" | grep -c "index=" 2>/dev/null || echo "0")
    pass "Sidecar --list-devices succeeded ($DEVICE_COUNT devices)"
  else
    fail "Sidecar --list-devices failed (exit=$PROBE_EXIT)"
    info "Output: $(echo "$PROBE_OUTPUT" | head -3)"
  fi
fi

# ── 9. Global hotkey helper ──
HOTKEY="$APP/Contents/Resources/sidecar/global-hotkey"
if [ -x "$HOTKEY" ]; then
  pass "Global hotkey helper executable"
else
  fail "Global hotkey helper missing: $HOTKEY"
fi

GLOBAL_HOTKEY_HELPER_APP="$APP/Contents/Resources/GlobalHotkeyHelper.app"
GLOBAL_HOTKEY_HELPER_BIN="$GLOBAL_HOTKEY_HELPER_APP/Contents/MacOS/global-hotkey"
if [ -x "$GLOBAL_HOTKEY_HELPER_BIN" ]; then
  pass "Global hotkey helper app executable"
  if codesign -v "$GLOBAL_HOTKEY_HELPER_APP" 2>/dev/null; then
    pass "Global hotkey helper app code signature valid"
    GLOBAL_HOTKEY_SIGN_ID=$(codesign -d --verbose=2 "$GLOBAL_HOTKEY_HELPER_APP" 2>&1 | grep "Identifier=" | head -1 | cut -d= -f2- || echo "")
    if [ "$GLOBAL_HOTKEY_SIGN_ID" = "$EXPECTED_GLOBAL_HOTKEY_HELPER_ID" ]; then
      pass "Global hotkey helper identifier: $GLOBAL_HOTKEY_SIGN_ID"
    else
      fail "Global hotkey helper identifier mismatch: got '$GLOBAL_HOTKEY_SIGN_ID', expected '$EXPECTED_GLOBAL_HOTKEY_HELPER_ID'"
    fi
  else
    fail "Global hotkey helper app code signature INVALID"
  fi
else
  fail "Global hotkey helper app missing or not executable: $GLOBAL_HOTKEY_HELPER_BIN"
fi

GLOBAL_HOTKEY_BUNDLE_NAME=$(plutil -extract CFBundleName raw "$GLOBAL_HOTKEY_HELPER_APP/Contents/Info.plist" 2>/dev/null || echo "")
GLOBAL_HOTKEY_DISPLAY_NAME=$(plutil -extract CFBundleDisplayName raw "$GLOBAL_HOTKEY_HELPER_APP/Contents/Info.plist" 2>/dev/null || echo "")
if [ "$GLOBAL_HOTKEY_BUNDLE_NAME" = "BiCaption" ] && [ "$GLOBAL_HOTKEY_DISPLAY_NAME" = "BiCaption" ]; then
  pass "Global hotkey helper displays as BiCaption in system permission UI"
else
  fail "Global hotkey helper display name mismatch: CFBundleName='$GLOBAL_HOTKEY_BUNDLE_NAME', CFBundleDisplayName='$GLOBAL_HOTKEY_DISPLAY_NAME'"
fi

# ── 10. App resources (asar or unpacked) ──
ASAR="$APP/Contents/Resources/app.asar"
APP_DIR="$APP/Contents/Resources/app"
if [ -f "$ASAR" ]; then
  ASAR_SIZE=$(stat -f%z "$ASAR" 2>/dev/null || stat --printf=%s "$ASAR" 2>/dev/null || echo "0")
  if [ "$ASAR_SIZE" -gt 1000 ]; then
    pass "app.asar present ($(( ASAR_SIZE / 1024 ))KB)"
  else
    fail "app.asar too small ($ASAR_SIZE bytes)"
  fi
elif [ -d "$APP_DIR" ] && [ -f "$APP_DIR/dist/renderer/index.html" ]; then
  pass "Unpacked app directory with renderer"
else
  fail "Neither app.asar nor unpacked app/dist found"
fi

# ── 11. Apple STT helper ──
APPLE_STT_HELPER_APP="$APP/Contents/Resources/AppleSTTHelper.app"
APPLE_STT_HELPER_BIN="$APPLE_STT_HELPER_APP/Contents/MacOS/apple-stt"
APPLE_STT_HELPER_ICON="$APPLE_STT_HELPER_APP/Contents/Resources/icon.icns"
if [ -x "$APPLE_STT_HELPER_BIN" ]; then
  pass "Apple STT helper executable"
  if codesign -v "$APPLE_STT_HELPER_APP" 2>/dev/null; then
    pass "Apple STT helper code signature valid"
    HELPER_SIGN_ID=$(codesign -d --verbose=2 "$APPLE_STT_HELPER_APP" 2>&1 | grep "Identifier=" | head -1 | cut -d= -f2- || echo "")
    if [ "$HELPER_SIGN_ID" = "$EXPECTED_APPLE_STT_HELPER_ID" ]; then
      pass "Apple STT helper identifier: $HELPER_SIGN_ID"
    else
      fail "Apple STT helper identifier mismatch: got '$HELPER_SIGN_ID', expected '$EXPECTED_APPLE_STT_HELPER_ID'"
    fi
  else
    fail "Apple STT helper code signature INVALID"
  fi
else
  fail "Apple STT helper missing or not executable: $APPLE_STT_HELPER_BIN"
fi

HELPER_ICON_FILE=$(plutil -extract CFBundleIconFile raw "$APPLE_STT_HELPER_APP/Contents/Info.plist" 2>/dev/null || echo "")
if [ "$HELPER_ICON_FILE" = "icon.icns" ]; then
  pass "Apple STT helper icon declaration"
else
  fail "Apple STT helper icon declaration missing"
fi

HELPER_BUNDLE_NAME=$(plutil -extract CFBundleName raw "$APPLE_STT_HELPER_APP/Contents/Info.plist" 2>/dev/null || echo "")
HELPER_DISPLAY_NAME=$(plutil -extract CFBundleDisplayName raw "$APPLE_STT_HELPER_APP/Contents/Info.plist" 2>/dev/null || echo "")
if [ "$HELPER_BUNDLE_NAME" = "BiCaption" ] && [ "$HELPER_DISPLAY_NAME" = "BiCaption" ]; then
  pass "Apple STT helper displays as BiCaption in system permission UI"
else
  fail "Apple STT helper display name mismatch: CFBundleName='$HELPER_BUNDLE_NAME', CFBundleDisplayName='$HELPER_DISPLAY_NAME'"
fi

if [ -f "$APPLE_STT_HELPER_ICON" ]; then
  pass "Apple STT helper icon resource"
else
  fail "Apple STT helper icon missing: $APPLE_STT_HELPER_ICON"
fi

# ── 12. Info.plist usage descriptions ──
echo ""
echo "Permission usage descriptions in Info.plist:"
for KEY in NSMicrophoneUsageDescription NSScreenCaptureUsageDescription; do
  DESC=$(plutil -extract "$KEY" raw "$APP/Contents/Info.plist" 2>/dev/null || echo "MISSING")
  if [ "$DESC" != "MISSING" ] && [ -n "$DESC" ]; then
    info "$KEY: $DESC"
  else
    fail "$KEY not set in Info.plist"
  fi
done

TRANSLATION_APP="$APP/Contents/Resources/AppleTranslationHelper.app"
if [ -x "$TRANSLATION_APP/Contents/MacOS/apple-translation" ]; then
  pass "Apple Translation helper packaged"
else
  fail "Apple Translation helper missing or not executable"
fi
TRANSLATION_ID=$(plutil -extract CFBundleIdentifier raw "$TRANSLATION_APP/Contents/Info.plist" 2>/dev/null || echo "")
if [ "$TRANSLATION_ID" = "com.davedai.bicaption.apple-translation-helper" ]; then
  pass "Apple Translation helper bundle identifier"
else
  fail "Apple Translation helper bundle identifier mismatch"
fi

# ── Summary ──
echo ""
if [ $ERRORS -eq 0 ]; then
  printf '\033[32m=== All checks passed ===\033[0m\n'
else
  printf '\033[31m=== %d check(s) FAILED ===\033[0m\n' "$ERRORS"
fi
exit $ERRORS
