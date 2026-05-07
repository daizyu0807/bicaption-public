# BiCaption Clean Packaging Venv Manifest

## Purpose

This manifest defines the proposed dependency tiers for a future clean packaging virtualenv.

It does not change the current runtime, default development environment, default sidecar build, local install flow, or packaged app.

## Priority Order

1. Preserve all existing functionality.
2. Reduce packaged sidecar size.
3. Replace or remove non-commercial-risk components.

Any tier split that breaks an existing feature is rejected until the affected feature has an equivalent fallback or a product decision explicitly removes that feature.

## Current Constraint

The current `python/requirements.txt` remains the development baseline for now. Clean packaging decisions are owned by the dedicated tier files and build flags.

The future packaging venv must start from dedicated tier files and pass lightweight gates before any expensive PyInstaller build is attempted.

## Dependency Tiers

| Tier | File | Scope | Packaging Rule |
|---|---|---|---|
| Core runtime | `python/requirements-sidecar-core.txt` | Baseline sidecar imports and current live STT foundation | Required for all packaged sidecars |
| Local LLM runtime | `python/requirements-sidecar-local-llm.txt` | Optional local dictation rewrite via `mlx_lm` | Optional, arm64-first, separate package path |
| Dev/export only | `python/requirements-sidecar-dev-export.txt` | Model export, icon generation, experiments, data tooling | Must not enter clean sidecar packaging venv unless a feature gate proves it is required |
| Legacy not packaged | none | `moonshine-voice`, `mlx-whisper` runtime paths | UI/settings migrate these away; do not package unless product reopens them |

## Feature Preservation Map

| Feature | Required Tier | Notes |
|---|---|---|
| Apple STT helper path | Core runtime plus bundled `python/apple-stt` binary | Binary inclusion remains owned by build scripts |
| SenseVoice / sherpa-onnx recognition | Core runtime | Preserve current model and VAD path |
| Translation and Traditional Chinese conversion | Core runtime | `deep-translator` and `opencc-python-reimplemented` remain core until commercial replacements are chosen |
| Moonshine STT | Legacy not packaged | Settings migrate old `moonshine` values away; runtime code remains lazy only until cleanup |
| MLX Whisper probe/transcribe | Legacy not packaged | Settings migrate old `whisper-mlx` values away; runtime code remains lazy only until cleanup |
| Local LLM dictation rewrite | Local LLM runtime | Keep optional; graceful fallback must remain `local_llm_dependency_missing` or equivalent |
| Meeting/session state and export | Core runtime plus app code | No packaging-tier change may alter meeting state behavior |

## Torch-Free Hypothesis

`torch` is absent from the core-only slim artifact and remains a dev/export or optional-local-LLM concern.

Known evidence:

- Core probes for `numpy`, `sounddevice`, `sherpa_onnx`, `deep_translator`, and `opencc` import without torch modules.
- The core-only slim artifact excludes `torch`, `scipy`, `numba`, `llvmlite`, `mlx`, `mlx_lm`, and `transformers`.
- `mlx_lm` imported torch modules in the current development venv, so local LLM must stay optional until its own package is validated.

Therefore, local LLM must not be reintroduced into the core artifact. Use `BICAPTION_INCLUDE_LOCAL_LLM=1` only for an explicitly optional local LLM build.

## Legacy STT Status

`moonshine-voice` and `mlx-whisper` are no longer packaged as dev/core dependencies.

Current evidence:

- UI options expose `apple-stt`, `sensevoice`, and `groq-whisper`.
- Subtitle and meeting options expose only `apple-stt` and `sensevoice`.
- `electron/settings.ts` migrates old `moonshine` and `whisper-mlx` settings to supported providers.
- `python/sidecar.py` keeps lazy legacy runtime code for `moonshine` and `whisper-mlx` only as transitional cleanup debt.
- `python/requirements.txt` no longer includes `moonshine-voice` or `mlx-whisper`.

Do not package either dependency unless the product decision reopens those providers.

## No-Build Acceptance Gates

Dev acceptance now has one command:

```bash
npm run check:dev-acceptance
```

This command stays on the dev side. It does not build or package the app.

Dev-side gates can be run through npm without touching the app packaging flow:

```bash
npm run sidecar:torch-gate
npm run sidecar:venv:dry-run
npm run sidecar:legacy-packaging-gate
npm run sidecar:deps
npm run check:sidecar-dev
npm run test:sidecar
```

Before any new PyInstaller run:

```bash
bash -n scripts/prepare-sidecar-packaging-venv.sh
bash scripts/prepare-sidecar-packaging-venv.sh --dry-run --with-build-tool
bash scripts/prepare-sidecar-packaging-venv.sh --dry-run --with-local-llm --with-build-tool
bash -n scripts/verify-torch-free-import.sh
bash scripts/verify-torch-free-import.sh
bash -n scripts/analyze-sidecar-deps.sh
bash scripts/analyze-sidecar-deps.sh
npm run type-check
npm test
```

The torch-free script is an import probe only. It does not install, build, delete, or modify files.

When a clean venv is intentionally created later, point the probes at it instead of the development `.venv`:

```bash
BICAPTION_SIDECAR_PYTHON=.venv-sidecar/bin/python bash scripts/verify-torch-free-import.sh
BICAPTION_SIDECAR_PYTHON=.venv-sidecar/bin/python bash scripts/analyze-sidecar-deps.sh
BICAPTION_INCLUDE_LOCAL_LLM=1 BICAPTION_SIDECAR_PYTHON=.venv-sidecar/bin/python bash scripts/verify-torch-free-import.sh
BICAPTION_INCLUDE_LOCAL_LLM=1 BICAPTION_SIDECAR_PYTHON=.venv-sidecar/bin/python bash scripts/analyze-sidecar-deps.sh
```

## Promotion Rule

The core-only packaging path has been promoted to `scripts/build-sidecar.sh` after dev acceptance and unsigned app artifact verification.

Do not promote install, publishing, or the optional local LLM package path until:

1. All no-build gates pass.
2. A clean venv probe shows the expected dependency absence/presence.
3. A packaged slim artifact passes the full functionality gate in `docs/plans/2026-04-26-commercial-sidecar-slim-validation.md`.
4. The user explicitly approves another heavy build/install step.
