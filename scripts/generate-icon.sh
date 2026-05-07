#!/usr/bin/env bash
# Generate .icns from icon.svg.
# Preferred path: render SVG -> PNG, then use electron-builder's app-builder to make icns.
# Fallback path: iconutil.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/../build"
SVG_FILE="$BUILD_DIR/icon.svg"
ICONSET_DIR="$BUILD_DIR/icon.iconset"
ICNS_FILE="$BUILD_DIR/icon.icns"
APP_BUILDER="$SCRIPT_DIR/../node_modules/app-builder-bin/mac/app-builder_arm64"
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
QLMANAGE_BIN="/usr/bin/qlmanage"

if [ ! -f "$SVG_FILE" ]; then
  echo "[generate-icon] ERROR: $SVG_FILE not found"
  exit 1
fi

PNG_1024="$BUILD_DIR/icon_1024.png"
PNG_1024_NORM="$BUILD_DIR/icon_1024_norm.png"

# Avoid silently reusing a stale render when SVG conversion fails.
rm -f "$PNG_1024"
rm -f "$PNG_1024_NORM"

# Use macOS built-in python3 + objc to render SVG to PNG
python3 - "$BUILD_DIR" << 'PYEOF' || true
import subprocess, sys, os

build_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build") if False else sys.argv[1] if len(sys.argv) > 1 else "build"

# Use WebKit via a small HTML wrapper and screencapture alternative
# Simplest: use the 'rsvg-convert' if available, else use cairosvg, else manual
try:
    import cairosvg
    cairosvg.svg2png(url=os.path.join(build_dir, "icon.svg"),
                     write_to=os.path.join(build_dir, "icon_1024.png"),
                     output_width=1024, output_height=1024)
    sys.exit(0)
except ImportError:
    pass

# Fallback: use Pillow + cairosvg not available, try reportlab
# Last resort: create PNG via AppKit
try:
    from AppKit import NSImage, NSBitmapImageRep, NSPNGFileType
    from Foundation import NSData, NSURL

    svg_path = os.path.join(build_dir, "icon.svg")
    png_path = os.path.join(build_dir, "icon_1024.png")

    url = NSURL.fileURLWithPath_(svg_path)
    image = NSImage.alloc().initWithContentsOfURL_(url)
    if image is None:
        print("Failed to load SVG via NSImage")
        sys.exit(1)

    image.setSize_((1024, 1024))
    rep = NSBitmapImageRep.alloc().initWithData_(image.TIFFRepresentation())
    png_data = rep.representationUsingType_properties_(NSPNGFileType, None)
    png_data.writeToFile_atomically_(png_path, True)
    print(f"Generated {png_path}")
    sys.exit(0)
except ImportError:
    print("AppKit not available")
    sys.exit(1)
PYEOF

if [ ! -f "$PNG_1024" ] && [ -x "$QLMANAGE_BIN" ]; then
  "$QLMANAGE_BIN" -t -s 1024 -o "$BUILD_DIR" "$SVG_FILE" >/dev/null 2>&1 || true
  if [ -f "$BUILD_DIR/$(basename "$SVG_FILE").png" ]; then
    mv "$BUILD_DIR/$(basename "$SVG_FILE").png" "$PNG_1024"
  fi
fi

if [ ! -f "$PNG_1024" ] && [ -x "$CHROME_BIN" ]; then
  "$CHROME_BIN" \
    --headless \
    --disable-gpu \
    --hide-scrollbars \
    --screenshot="$PNG_1024" \
    --window-size=1024,1024 \
    "file://$SVG_FILE" >/dev/null 2>&1 || true
fi

if [ ! -f "$PNG_1024" ]; then
  echo "[generate-icon] ERROR: Cannot convert SVG to PNG. Install cairosvg or make Chrome available."
  exit 1
fi

python3 - "$PNG_1024" "$PNG_1024_NORM" << 'PYEOF'
from PIL import Image, ImageDraw
import sys

png_path = sys.argv[1]
norm_path = sys.argv[2]

image = Image.open(png_path).convert("RGBA")
mask = Image.new("L", image.size, 0)
draw = ImageDraw.Draw(mask)

# Match the rounded-square geometry in build/icon.svg.
draw.rounded_rectangle((56, 56, 968, 968), radius=216, fill=255)

image.putalpha(mask)
image.save(png_path)
image.save(norm_path)
print(f"[generate-icon] Normalized transparent corners: {png_path}")
print(f"[generate-icon] Synced normalized PNG: {norm_path}")
PYEOF

echo "[generate-icon] Created 1024x1024 PNG"

if [ -x "$APP_BUILDER" ]; then
  rm -rf "$BUILD_DIR/.tmp-icon-out"
  mkdir -p "$BUILD_DIR/.tmp-icon-out"
  "$APP_BUILDER" icon --format=icns --root "$SCRIPT_DIR/.." --input "$PNG_1024" --out "$BUILD_DIR/.tmp-icon-out" >/dev/null
  cp "$BUILD_DIR/.tmp-icon-out/icon.icns" "$ICNS_FILE"
  rm -rf "$BUILD_DIR/.tmp-icon-out"
  echo "[generate-icon] Success via app-builder: $ICNS_FILE"
  ls -lh "$ICNS_FILE"
  exit 0
fi

# Fallback to iconutil if app-builder is unavailable.
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

for size in 16 32 128 256 512; do
  sips -z $size $size "$PNG_1024" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$PNG_1024" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

cp "$PNG_1024" "$ICONSET_DIR/icon_512x512@2x.png"
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_FILE"
rm -rf "$ICONSET_DIR"
echo "[generate-icon] Success via iconutil: $ICNS_FILE"
ls -lh "$ICNS_FILE"
