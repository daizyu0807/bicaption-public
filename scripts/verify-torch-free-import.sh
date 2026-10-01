#!/usr/bin/env bash
# Read-only import probe for clean sidecar packaging decisions.
# This script does not install, build, delete, or modify files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
VENV_PYTHON="${BICAPTION_SIDECAR_PYTHON:-$PROJECT_ROOT/.venv/bin/python}"
source "$SCRIPT_DIR/sidecar-packaging-config.sh"

if [ ! -f "$VENV_PYTHON" ]; then
  echo "[torch-free] ERROR: .venv not found"
  exit 1
fi

"$VENV_PYTHON" - "${BICAPTION_INCLUDE_LOCAL_LLM:-0}" <<'PY'
import importlib
import sys

modules = [
    "numpy",
    "sounddevice",
    "sherpa_onnx",
    "opencc",
]
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
    torch_modules = sorted(
        name for name in after - before
        if name == "torch" or name.startswith("torch.")
    )
    sample = ", ".join(torch_modules[:10])
    suffix = "..." if len(torch_modules) > 10 else ""
    status = "TORCH_FREE" if not torch_modules else "TORCH_LEAK"
    print(f"{module}\t{status}\ttorch_modules={len(torch_modules)}\t{sample}{suffix}")
PY
