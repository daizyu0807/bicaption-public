#!/usr/bin/env bash
# Lightweight dependency inspection for BiCaption sidecar packaging.
# This script is read-only: it does not install, build, delete, or modify files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
VENV_PYTHON="${BICAPTION_SIDECAR_PYTHON:-$PROJECT_ROOT/.venv/bin/python}"
source "$SCRIPT_DIR/sidecar-packaging-config.sh"

if [ ! -f "$VENV_PYTHON" ]; then
  echo "[deps] ERROR: .venv not found"
  exit 1
fi

VENV_ROOT="$(cd "$(dirname "$VENV_PYTHON")/.." && pwd)"
SITE_PACKAGES_GLOB="$VENV_ROOT/lib/python"*/site-packages

section() {
  printf '\n== %s ==\n' "$1"
}

section "Python"
"$VENV_PYTHON" - <<'PY'
import platform
import sys
print(sys.executable)
print(f"python={sys.version.split()[0]} platform={platform.platform()} machine={platform.machine()}")
PY

section "Runtime Import Probes"
"$VENV_PYTHON" - "${BICAPTION_INCLUDE_LOCAL_LLM:-0}" <<'PY'
import importlib
import sys

checks = [
    ("core:numpy", "numpy"),
    ("core:sounddevice", "sounddevice"),
    ("core:sherpa_onnx", "sherpa_onnx"),
    ("core:opencc", "opencc"),
]
if sys.argv[1].lower() in {"1", "true", "yes", "on"}:
    checks.extend([
        ("optional:mlx.core", "mlx.core"),
        ("optional:mlx_lm", "mlx_lm"),
        ("optional:huggingface_hub", "huggingface_hub"),
    ])

for label, module in checks:
    try:
        importlib.import_module(module)
    except Exception as exc:
        print(f"{label}\tMISSING_OR_FAIL\t{type(exc).__name__}: {exc}")
    else:
        print(f"{label}\tPRESENT")
PY

section "Import-Time Torch Leakage"
"$VENV_PYTHON" - "${BICAPTION_INCLUDE_LOCAL_LLM:-0}" <<'PY'
import importlib
import sys

modules = ["numpy", "sounddevice", "sherpa_onnx", "opencc"]
if sys.argv[1].lower() in {"1", "true", "yes", "on"}:
    modules.extend(["mlx_lm", "transformers"])

for module in modules:
    for loaded in list(sys.modules):
        if loaded == "torch" or loaded.startswith("torch."):
            sys.modules.pop(loaded, None)
    before = set(sys.modules)
    try:
        importlib.import_module(module)
    except Exception as exc:
        print(f"{module}\tIMPORT_FAIL\t{type(exc).__name__}: {exc}")
        continue
    after = set(sys.modules)
    torch_modules = sorted(m for m in after - before if m == "torch" or m.startswith("torch."))
    sample = ", ".join(torch_modules[:8])
    suffix = "..." if len(torch_modules) > 8 else ""
    print(f"{module}\ttorch_modules={len(torch_modules)}\t{sample}{suffix}")
PY

section "Export/Dev Package Availability"
"$VENV_PYTHON" - <<'PY'
import importlib

checks = [
    ("export_only:torch", "torch"),
    ("export_only:cv2", "cv2"),
    ("export_only:pandas", "pandas"),
    ("export_only:pyarrow", "pyarrow"),
    ("export_only:datasets", "datasets"),
    ("export_only:PIL", "PIL"),
]

for label, module in checks:
    try:
        importlib.import_module(module)
    except Exception as exc:
        print(f"{label}\tMISSING_OR_FAIL\t{type(exc).__name__}: {exc}")
    else:
        print(f"{label}\tPRESENT")
PY

section "Direct Package Metadata"
"$VENV_PYTHON" - <<'PY'
from importlib import metadata

names = [
    "sherpa-onnx",
    "numpy",
    "sounddevice",
    "opencc-python-reimplemented",
    "mlx",
    "mlx-metal",
    "mlx-lm",
    "transformers",
    "huggingface-hub",
    "torch",
    "scipy",
    "numba",
    "llvmlite",
    "opencv-python",
    "pandas",
    "pyarrow",
    "datasets",
    "pillow",
    "mlx-whisper",
    "moonshine-voice",
]

for name in names:
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError:
        print(f"{name}\tMISSING")
        continue
    license_value = dist.metadata.get("License") or dist.metadata.get("License-Expression") or ""
    print(f"{dist.metadata.get('Name')}\t{dist.version}\t{license_value.splitlines()[0] if license_value else ''}")
PY

section "Largest Site-Packages Entries"
for site_packages in $SITE_PACKAGES_GLOB; do
  if [ -d "$site_packages" ]; then
    du -sh "$site_packages"/* 2>/dev/null | sort -hr | sed -n '1,40p'
  fi
done

section "Largest Native Libraries"
for site_packages in $SITE_PACKAGES_GLOB; do
  if [ -d "$site_packages" ]; then
    find "$site_packages" -type f \( -name '*.so' -o -name '*.dylib' \) -print0 \
      | xargs -0 du -sh 2>/dev/null \
      | sort -hr \
      | sed -n '1,40p'
  fi
done

section "Existing Artifact Sizes"
du -sh "$PROJECT_ROOT/python/dist/bicaption-sidecar" 2>/dev/null || true
du -sh "$PROJECT_ROOT/python/dist-slim/bicaption-sidecar" 2>/dev/null || true

section "Existing Slim Artifact Risk Markers"
if [ -d "$PROJECT_ROOT/python/dist-slim/bicaption-sidecar/_internal" ]; then
  for marker in cv2 pandas pyarrow datasets PIL torch scipy numba llvmlite mlx_lm transformers mlx_whisper moonshine_voice; do
    if [ -e "$PROJECT_ROOT/python/dist-slim/bicaption-sidecar/_internal/$marker" ]; then
      echo "present $marker"
    else
      echo "absent  $marker"
    fi
  done
fi
