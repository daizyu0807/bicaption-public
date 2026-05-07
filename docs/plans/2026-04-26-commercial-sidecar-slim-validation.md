# BiCaption Commercial Sidecar Slim Validation Plan

## Priority Order

1. Preserve all existing functionality.
2. Reduce packaged sidecar size.
3. Replace or remove non-commercial-risk components.

Any slimming or commercial-readiness change that breaks an existing feature is rejected until a safer replacement path is proven.

## Current Baseline

- Default packaged sidecar build is now `scripts/build-sidecar.sh` in core-only mode.
- Optional local LLM packaging is explicit via `BICAPTION_INCLUDE_LOCAL_LLM=1` or `npm run build:sidecar:full`.
- Local install, TCC reset, `/Applications/BiCaption.app` replacement, and package publishing are out of scope for this phase.
- Previous sidecar artifact observed locally: `python/dist/bicaption-sidecar`, about `1.1G`.
- Current core-only sidecar observed locally: `python/dist/bicaption-sidecar`, about `138M`.
- Current unsigned app artifacts observed locally: `release/mac-arm64/BiCaption.app` about `431M`, DMG about `176M`, zip about `164M`.
- Previous slim sidecar with bundled local LLM runtime was about `829M`; the main size reduction came from making local LLM optional.

## Known Size Drivers

| Component | Observed Size | First-Pass Judgment |
|---|---:|---|
| `sherpa_onnx` | 76M | Keep; SenseVoice / Silero path |
| `numpy` | 6.6M | Keep; core audio/model helper dependency |
| Python runtime | about 12M | Keep |
| `torch` | absent from core-only slim | Optional local LLM / dev-export only |
| `mlx` / `mlx_lm` | absent from core-only slim | Optional local LLM only |
| `scipy` / `numba` / `llvmlite` | absent from core-only slim | Not core |
| `cv2` / `pandas` / `pyarrow` / `datasets` / `PIL` | absent from core-only slim | Not core |

## Variant Strategy

Core-only packaging is now the default build path for unsigned app artifacts.

- `npm run build:sidecar` builds the core-only sidecar used by app packaging.
- `npm run build:sidecar:full` builds the explicit local-LLM sidecar variant.
- `scripts/build-sidecar-slim.sh` remains as an experimental sidecar-only comparison build.
- Local install and TCC reset still require explicit user approval.

## Clean Packaging Venv Strategy

The long-term commercial build should not package from the development `.venv`.

Next packaging design must split dependencies into tiers and prove that each tier preserves its feature set before the default build changes.

### Dependency Tiers

| Tier | Purpose | Candidate Dependencies | Rule |
|---|---|---|---|
| Core runtime | Current baseline sidecar functions | `sherpa-onnx`, `numpy`, `sounddevice`, `deep-translator`, `opencc-python-reimplemented`, native helpers | Must preserve Apple STT, SenseVoice, subtitles, dictation state, and meeting state |
| Apple Silicon MLX runtime | MLX-backed optional features on arm64 | `mlx`, `mlx-metal` | arm64-only; Intel builds must exclude or disable MLX features cleanly |
| Optional local LLM | Local dictation rewrite | `mlx-lm`, `transformers`, `sentencepiece`, `protobuf`, `pyyaml`, `jinja2`, shared `huggingface_hub` | Optional tier; must not force `torch` into core runtime |
| Shared optional model tools | Model download/cache helpers used by optional tiers | `huggingface_hub` | Shared by optional MLX Whisper and local LLM; keep version ownership explicit |
| Legacy not packaged | Former local STT experiments | `mlx-whisper`, `moonshine-voice`, `scipy`, `numba`, `llvmlite` if only pulled by MLX Whisper | Do not install unless the product decision reopens those providers |
| Export/dev only | Model conversion, icon generation, experiments, tests | `torch`, `PIL`, `cv2`, `pandas`, `pyarrow`, `datasets`, test-only tools | Must not be installed in clean packaging venv unless a feature gate proves it is required |

`torch` is treated as export/dev-only for clean packaging design. Current `mlx_lm` import behavior still touches `torch` through the installed environment, so local LLM packaging needs separate investigation before `torch` can be removed from actual artifacts.

`moonshine-voice` and `mlx-whisper` are treated as legacy-not-packaged after the first dev acceptance pass because UI/settings no longer expose them as active providers.

`opencc-python-reimplemented` remains core for now because current sidecar code uses it for Simplified-to-Traditional conversion in translation and dictation cleanup paths.

### Clean Venv Gate

A clean packaging venv proposal is not accepted until the following checks are satisfied:

| Feature | Lightweight Check | Required Tier |
|---|---|---|
| Audio device access | `python -c "import sounddevice; print(sounddevice.query_devices())"` | Core runtime |
| sherpa runtime | `python -c "import sherpa_onnx"` | Core runtime |
| Translation provider import | `python -c "from deep_translator import GoogleTranslator"` | Core runtime |
| Traditional Chinese conversion | `python -c "from opencc import OpenCC; print(OpenCC('s2t').convert('测试'))"` | Core runtime |
| MLX runtime | `python -c "import mlx.core"` | Apple Silicon MLX runtime |
| Local LLM | `python -c "import mlx_lm"` | Optional local LLM |
| Torch absence | `python -c "import torch"` must fail in core packaging venv | Export/dev only |

These are not substitutes for packaged feature tests. They are pre-build gates to prevent known dependency pollution before running an expensive build.

## First-Batch Exclusions

Current core-only slim excludes modules that are not required by the accepted core runtime:

- `cv2`
- `pandas`
- `pyarrow`
- `datasets`
- `PIL`
- `torch`
- `transformers`
- `mlx`
- `mlx_lm`
- `scipy`
- `numba`
- `llvmlite`

Local LLM remains a product feature path, but not a bundled core runtime. A future local LLM package must be gated by `BICAPTION_INCLUDE_LOCAL_LLM=1` and validated separately.

## Packaged Functionality Gate

Core-only packaged build is not considered fully accepted until it passes the same feature expectations as the previous packaged sidecar.

### Sidecar Core

- [ ] Slim sidecar starts without crashing.
- [ ] Sidecar accepts a minimal `ping` command and returns a valid response.
- [ ] Sidecar exits cleanly after a stop/EOF path.
- [ ] Logs contain no `ImportError`, missing dylib, or PyInstaller extraction failure.

### Speech Recognition

- [ ] Apple STT path still starts when selected.
- [ ] SenseVoice path still loads the recognizer and VAD.
- [ ] Legacy MLX Whisper remains unavailable in supported UI modes.

### Dictation And Rewrite

- [ ] Dictation state machine still starts/stops normally.
- [ ] Rules-only dictation rewrite still works.
- [ ] Local LLM rewrite is either installed through the optional tier or fails with a clear graceful fallback reason.
- [ ] Cloud rewrite path is not affected by sidecar slimming.

### Translation And Meeting

- [ ] Translation-disabled path still emits captions.
- [ ] Google translation path behavior matches the default build.
- [ ] Meeting dual-source state still accepts microphone/system caption events.
- [ ] Meeting transcript save/export behavior is unaffected.

### Desktop Integration

- [ ] Native global hotkey helper is still included.
- [ ] `apple-stt` helper binary is still included.
- [ ] No install flow, TCC reset, or `/Applications` replacement is performed in this phase.

## Failure Rule

If any existing feature fails in the core-only default package:

1. Treat the failure as blocking.
2. Identify the exclusion that caused the failure.
3. Remove or narrow that exclusion.
4. Re-run the relevant gate before continuing.

## Verification Commands

Initial no-install verification:

```bash
bash -n scripts/build-sidecar-slim.sh
bash -n scripts/analyze-sidecar-deps.sh
bash scripts/analyze-sidecar-deps.sh
npm run type-check
npm test
```

Optional sidecar-only smoke checks after building the slim variant:

```bash
bash scripts/build-sidecar-slim.sh
du -sh python/dist-slim/bicaption-sidecar
find python/dist-slim/bicaption-sidecar/_internal -maxdepth 1 -mindepth 1 | sort
```

Do not run `npm run install:local-app` during this phase.

## Claude Consensus

Claude cross-think gave a conditional go:

- Write this gate document before adding the slim script.
- Keep the slim build parallel.
- Move `fastapi` and `uvicorn` out of the first-batch exclude list.
- Do not touch the default build until packaged-function gates pass.

Follow-up Claude consensus for clean packaging venv:

- Do not run another heavy PyInstaller build until explicitly approved.
- Move `torch` to export/dev-only in the clean packaging design.
- Treat `huggingface_hub` as shared optional instead of owned by one optional tier.
- Mark MLX as arm64-only.
- Add a lightweight dependency analysis script before attempting another build.
