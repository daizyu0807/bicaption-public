# BiCaption Commercial License Audit Checklist

## Purpose

This checklist tracks commercial-readiness risks that are separate from file size.

Library license metadata is not enough for release readiness because model weights, model cards, download terms, hosted providers, and codec/native libraries may carry separate restrictions.

## Priority

Commercial replacement work starts only after current functionality is protected and sidecar slimming has a verified path.

## Must Audit Before Commercial Release

| Area | Current Item | Risk To Check | Status |
|---|---|---|---|
| Translation provider | `deep-translator` GoogleTranslator path | Unofficial Google Translate access and provider terms | Open |
| Local LLM model weights | MLX local rewrite model, including `mlx-community/*` variants | Model-card license may differ from `mlx_lm` library license | Open |
| MLX Whisper model weights | Legacy `mlx_whisper` configured model repository | Not packaged after dev isolation; audit only if product reopens this provider | Deferred |
| SenseVoice model weights | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` / FunAudioLLM SenseVoiceSmall | Model-card license, redistribution, and commercial permission | Open |
| Moonshine model weights | Legacy `moonshine_voice` downloaded/cached models | Not packaged after dev isolation; audit only if product reopens this provider | Deferred |
| Native codecs | OpenCV/FFmpeg codec dylibs if `cv2` is packaged | Codec patent/commercial risk; first slim build removes `cv2` | Partially mitigated in slim variant |
| Hugging Face downloads | `huggingface_hub` runtime model downloads | Online dependency, user-consent, ToS, offline packaging strategy | Open |
| PyInstaller | PyInstaller and bootloader | GPL exception / bundled notices | Needs notice review |
| OSS notices | Python and Node dependencies | Notice file generation and attribution completeness | Open |

## Current Non-Conclusion

The current work does not conclude that BiCaption is commercially releasable.

It only establishes a safer path to:

1. Preserve current features.
2. Reduce sidecar size without replacing the default build.
3. Identify which dependencies and model assets need legal review before a commercial app decision.
