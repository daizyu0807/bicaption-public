#!/usr/bin/env bash
# Prepare a separate sidecar packaging virtualenv from tiered requirements.
# This script does not build, package, install, delete, or modify the default .venv.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
VENV_DIR="$PROJECT_ROOT/.venv-sidecar"
PYTHON_BIN="${PYTHON_BIN:-python3}"
WITH_MLX_WHISPER=0
WITH_LOCAL_LLM=0
WITH_BREEZE_ASR=0
WITH_BUILD_TOOL=0
DRY_RUN=0
RUN_PROBES=1

usage() {
  cat <<'EOF'
Usage:
  bash scripts/prepare-sidecar-packaging-venv.sh [options]

Options:
  --venv <path>         Target venv path. Default: .venv-sidecar
  --python <path>       Python executable for venv creation. Default: python3
  --with-legacy-mlx-whisper
                        Deprecated no-op; MLX Whisper is no longer packaged
  --with-local-llm      Install the optional local LLM tier
  --with-breeze-asr     Install the opt-in Breeze ASR 25 runtime tier
  --with-build-tool     Install PyInstaller into the packaging venv
  --no-probes           Skip read-only import probes after install
  --dry-run             Print planned commands without running them
  -h, --help            Show this help

Default install tiers:
  - python/requirements-sidecar-core.txt

This script intentionally excludes python/requirements-sidecar-dev-export.txt.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --venv)
      VENV_DIR="${2:-}"
      shift 2
      ;;
    --python)
      PYTHON_BIN="${2:-}"
      shift 2
      ;;
    --with-mlx-whisper)
      WITH_MLX_WHISPER=1
      shift
      ;;
    --with-legacy-mlx-whisper)
      WITH_MLX_WHISPER=1
      shift
      ;;
    --with-local-llm)
      WITH_LOCAL_LLM=1
      shift
      ;;
    --with-breeze-asr)
      WITH_BREEZE_ASR=1
      shift
      ;;
    --with-build-tool)
      WITH_BUILD_TOOL=1
      shift
      ;;
    --no-probes)
      RUN_PROBES=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[sidecar-venv] Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$VENV_DIR" || -z "$PYTHON_BIN" ]]; then
  echo "[sidecar-venv] ERROR: --venv and --python cannot be empty" >&2
  exit 1
fi

REQS=(
  "$PROJECT_ROOT/python/requirements-sidecar-core.txt"
)

if (( WITH_MLX_WHISPER )); then
  echo "[sidecar-venv] NOTE: MLX Whisper is legacy-not-packaged; ignoring --with-mlx-whisper"
fi

if (( WITH_LOCAL_LLM )); then
  REQS+=("$PROJECT_ROOT/python/requirements-sidecar-local-llm.txt")
fi

if (( WITH_BREEZE_ASR )); then
  REQS+=("$PROJECT_ROOT/python/requirements-sidecar-breeze-asr.txt")
fi

for req in "${REQS[@]}"; do
  if [[ ! -f "$req" ]]; then
    echo "[sidecar-venv] ERROR: missing requirements file: $req" >&2
    exit 1
  fi
done

run() {
  if (( DRY_RUN )); then
    printf '[sidecar-venv] DRY RUN:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

VENV_PYTHON="$VENV_DIR/bin/python"

echo "[sidecar-venv] Target venv: $VENV_DIR"
echo "[sidecar-venv] Install tiers:"
for req in "${REQS[@]}"; do
  echo "  - ${req#$PROJECT_ROOT/}"
done
if (( WITH_BUILD_TOOL )); then
  echo "  - PyInstaller build tool"
fi
echo "[sidecar-venv] Excluded: python/requirements-sidecar-dev-export.txt"

if [[ ! -d "$VENV_DIR" ]]; then
  run "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if [[ ! -f "$VENV_PYTHON" ]]; then
  if (( DRY_RUN )); then
    VENV_PYTHON="$VENV_DIR/bin/python"
  else
    echo "[sidecar-venv] ERROR: venv python not found: $VENV_PYTHON" >&2
    exit 1
  fi
fi

for req in "${REQS[@]}"; do
  run "$VENV_PYTHON" -m pip install -r "$req"
done

if (( WITH_BUILD_TOOL )); then
  run "$VENV_PYTHON" -m pip install pyinstaller
fi

if (( RUN_PROBES )); then
  if (( WITH_LOCAL_LLM || WITH_BREEZE_ASR )); then
    run env BICAPTION_INCLUDE_LOCAL_LLM="$WITH_LOCAL_LLM" BICAPTION_INCLUDE_BREEZE_ASR="$WITH_BREEZE_ASR" BICAPTION_SIDECAR_PYTHON="$VENV_PYTHON" bash "$PROJECT_ROOT/scripts/verify-torch-free-import.sh"
    run env BICAPTION_INCLUDE_LOCAL_LLM="$WITH_LOCAL_LLM" BICAPTION_INCLUDE_BREEZE_ASR="$WITH_BREEZE_ASR" BICAPTION_SIDECAR_PYTHON="$VENV_PYTHON" bash "$PROJECT_ROOT/scripts/analyze-sidecar-deps.sh"
  else
    run env BICAPTION_SIDECAR_PYTHON="$VENV_PYTHON" bash "$PROJECT_ROOT/scripts/verify-torch-free-import.sh"
    run env BICAPTION_SIDECAR_PYTHON="$VENV_PYTHON" bash "$PROJECT_ROOT/scripts/analyze-sidecar-deps.sh"
  fi
fi
