#!/usr/bin/env bash
# Guard against reintroducing legacy STT providers into core/dev packaging.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/sidecar-packaging-config.sh"

check_absent() {
  local label="$1"
  local pattern="$2"
  shift 2
  if rg -n "$pattern" "$@" >/tmp/bicaption-legacy-packaging-hit.txt 2>/dev/null; then
    echo "[legacy-packaging] ERROR: $label is still referenced in packaging inputs:" >&2
    cat /tmp/bicaption-legacy-packaging-hit.txt >&2
    exit 1
  fi
}

cd "$PROJECT_ROOT"

check_absent \
  "moonshine-voice" \
  "moonshine-voice|moonshine_voice" \
  python/requirements.txt \
  python/requirements-sidecar-*.txt \
  scripts/build-sidecar.sh \
  scripts/build-sidecar-slim.sh

check_absent \
  "mlx-whisper" \
  "mlx-whisper|mlx_whisper|MLX_WHISPER|--hidden-import mlx_whisper" \
  python/requirements.txt \
  python/requirements-sidecar-*.txt \
  scripts/build-sidecar.sh \
  scripts/build-sidecar-slim.sh

check_absent \
  "local LLM in core sidecar requirements" \
  "mlx-lm|mlx-metal|^mlx==" \
  python/requirements-sidecar-core.txt

echo "[legacy-packaging] OK: legacy STT is absent and core sidecar packaging keeps local LLM optional"
