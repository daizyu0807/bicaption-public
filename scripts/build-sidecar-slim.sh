#!/usr/bin/env bash
# Experimental sidecar-only slim build.
# This script must not replace scripts/build-sidecar.sh until the packaged
# functionality gate in docs/plans/2026-04-26-commercial-sidecar-slim-validation.md passes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
PYTHON_DIR="$PROJECT_ROOT/python"
VENV_PYTHON="$PROJECT_ROOT/.venv/bin/python"
source "$SCRIPT_DIR/sidecar-packaging-config.sh"

if [ ! -f "$VENV_PYTHON" ]; then
  echo "[build-sidecar-slim] ERROR: .venv not found. Run: python3 -m venv .venv && source .venv/bin/activate && pip install -r python/requirements.txt"
  exit 1
fi

"$VENV_PYTHON" -c "import PyInstaller" 2>/dev/null || {
  echo "[build-sidecar-slim] Installing PyInstaller..."
  "$VENV_PYTHON" -m pip install pyinstaller
}

echo "[build-sidecar-slim] Building experimental slim sidecar binary..."

SHERPA_COLLECT=$("$VENV_PYTHON" -c "
import os, sherpa_onnx
pkg_dir = os.path.dirname(sherpa_onnx.__file__)
libs = [f for f in os.listdir(pkg_dir) if f.endswith(('.dylib', '.so'))]
for lib in libs:
    print(f'--add-binary={os.path.join(pkg_dir, lib)}:sherpa_onnx')
" 2>/dev/null || true)

SHERPA_NATIVE=$("$VENV_PYTHON" -c "
import os, sherpa_onnx
pkg_dir = os.path.dirname(sherpa_onnx.__file__)
for root, dirs, files in os.walk(pkg_dir):
    for f in files:
        if f.endswith(('.so', '.dylib', '.pyd')):
            rel = os.path.relpath(root, os.path.dirname(pkg_dir))
            print(f'--add-binary={os.path.join(root, f)}:{rel}')
" 2>/dev/null || true)

cd "$PYTHON_DIR"

LOCAL_LLM_HIDDEN_IMPORTS=()
LOCAL_LLM_EXCLUDES=()
LOCAL_LLM_REWRITE_FLAG=""
MLX_FLAGS=()
MLX_LM_FLAGS=()

if bicaption_include_local_llm; then
  LOCAL_LLM_HIDDEN_IMPORTS=(
    --hidden-import mlx
    --hidden-import mlx.core
    --hidden-import mlx_lm
  )

  MLX_LM_DIR="$PROJECT_ROOT/.venv/lib/python3.12/site-packages/mlx_lm"
  if [ -d "$MLX_LM_DIR" ]; then
    MLX_LM_FLAGS+=("--add-data=$MLX_LM_DIR:mlx_lm")
    echo "[build-sidecar-slim] Including optional mlx_lm package"
  else
    echo "[build-sidecar-slim] WARNING: mlx_lm package directory not found, local LLM rewrite won't work in packaged build"
  fi

  MLX_SITE_DIR="$PROJECT_ROOT/.venv/lib/python3.12/site-packages/mlx"
  if [ -d "$MLX_SITE_DIR" ]; then
    MLX_FLAGS+=("--add-data=$MLX_SITE_DIR:mlx")

    for candidate in \
      "$PROJECT_ROOT/.venv/lib/python3.12/site-packages/libmlx.dylib" \
      "$MLX_SITE_DIR/core.cpython-312-darwin.so" \
      "$MLX_SITE_DIR/lib/libmlx.dylib" \
      "$MLX_SITE_DIR/lib/mlx.metallib"
    do
      if [ -f "$candidate" ]; then
        rel_dir=$(python3 - <<PY
import os
site_dir = os.path.abspath("$PROJECT_ROOT/.venv/lib/python3.12/site-packages")
candidate = os.path.abspath("$candidate")
print(os.path.dirname(os.path.relpath(candidate, site_dir)))
PY
)
        if [ -z "$rel_dir" ]; then
          rel_dir="."
        fi
        MLX_FLAGS+=("--add-binary=$candidate:$rel_dir")
      fi
    done
  else
    echo "[build-sidecar-slim] WARNING: mlx package directory not found, MLX runtime won't work in packaged build"
  fi

  LOCAL_LLM_REWRITE="$PYTHON_DIR/local-llm-rewrite.py"
  if [ -f "$LOCAL_LLM_REWRITE" ]; then
    LOCAL_LLM_REWRITE_FLAG="--add-data=$LOCAL_LLM_REWRITE:."
    echo "[build-sidecar-slim] Including optional local-llm-rewrite.py"
  else
    echo "[build-sidecar-slim] WARNING: local-llm-rewrite.py not found, local LLM rewrite won't work"
  fi
else
  LOCAL_LLM_EXCLUDES=(
    --exclude-module torch
    --exclude-module scipy
    --exclude-module numba
    --exclude-module llvmlite
    --exclude-module transformers
    --exclude-module mlx
    --exclude-module mlx_lm
  )
  echo "[build-sidecar-slim] Optional local LLM runtime is not bundled. Set BICAPTION_INCLUDE_LOCAL_LLM=1 to include it."
fi

APPLE_STT="$PYTHON_DIR/apple-stt"
APPLE_STT_FLAG=""
if [ -f "$APPLE_STT" ]; then
  APPLE_STT_FLAG="--add-binary=$APPLE_STT:."
  echo "[build-sidecar-slim] Including apple-stt binary"
else
  echo "[build-sidecar-slim] WARNING: apple-stt not found, SFSpeechRecognizer won't work in packaged build"
fi

GLOBAL_HOTKEY="$PYTHON_DIR/global-hotkey"
GLOBAL_HOTKEY_FLAG=""
if [ -f "$GLOBAL_HOTKEY" ]; then
  GLOBAL_HOTKEY_FLAG="--add-binary=$GLOBAL_HOTKEY:."
  echo "[build-sidecar-slim] Including global-hotkey binary"
else
  echo "[build-sidecar-slim] WARNING: global-hotkey not found, native dictation hotkey won't work"
fi

SLIM_EXCLUDES=(
  --exclude-module cv2
  --exclude-module pandas
  --exclude-module pyarrow
  --exclude-module datasets
  --exclude-module PIL
)

set +u
"$VENV_PYTHON" -m PyInstaller \
  --onedir \
  --name bicaption-sidecar \
  --distpath dist-slim \
  --workpath build-slim \
  --specpath build-slim \
  --noconfirm \
  --strip \
  --noupx \
  --clean \
  --target-arch arm64 \
  --hidden-import sherpa_onnx \
  --hidden-import numpy \
  --hidden-import sounddevice \
  --hidden-import opencc \
  --hidden-import _sounddevice_data \
  --collect-all sherpa_onnx \
  --collect-all _sounddevice_data \
  "${LOCAL_LLM_HIDDEN_IMPORTS[@]}" \
  "${SLIM_EXCLUDES[@]}" \
  "${LOCAL_LLM_EXCLUDES[@]}" \
  "${MLX_FLAGS[@]}" \
  "${MLX_LM_FLAGS[@]}" \
  $SHERPA_COLLECT \
  $SHERPA_NATIVE \
  $APPLE_STT_FLAG \
  $GLOBAL_HOTKEY_FLAG \
  $LOCAL_LLM_REWRITE_FLAG \
  sidecar.py
set -u

BINARY="$PYTHON_DIR/dist-slim/bicaption-sidecar/bicaption-sidecar"
if [ -f "$BINARY" ]; then
  echo "[build-sidecar-slim] Success: $BINARY"
  du -sh "$PYTHON_DIR/dist-slim/bicaption-sidecar/"
else
  echo "[build-sidecar-slim] ERROR: Binary not found at $BINARY"
  exit 1
fi
