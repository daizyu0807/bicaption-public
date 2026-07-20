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
