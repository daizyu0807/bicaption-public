#!/usr/bin/env bash
# Shared sidecar packaging feature switches.

bicaption_include_local_llm() {
  case "${BICAPTION_INCLUDE_LOCAL_LLM:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

bicaption_include_breeze_asr() {
  case "${BICAPTION_INCLUDE_BREEZE_ASR:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# transcribe.cpp (Breeze ASR GGUF, Qwen3-ASR). Small (~9 MB), so it is bundled unless explicitly disabled.
bicaption_include_transcribe_cpp() {
  case "${BICAPTION_INCLUDE_TRANSCRIBE_CPP:-1}" in
    0|false|FALSE|no|NO|off|OFF)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}
