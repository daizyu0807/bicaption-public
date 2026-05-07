#!/usr/bin/env bash
set -euo pipefail

MODEL=""
RUN_ALL=0
INPUT_FILE=""
PROMPT_TEXT=""
MAX_CHARS=24000

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/reviewer-common.sh"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/cross-think.sh --file PATH --model codex
  bash scripts/cross-think.sh --prompt "..." --model claude
  bash scripts/cross-think.sh --file PATH --all
  bash scripts/cross-think.sh --list

Options:
  --model   Target thinker: codex|claude|gemini
  --all     Run all ready thinkers
  --file    Read context from a file
  --prompt  Use inline prompt text
  --list    Show thinker availability and exit
  -h,--help Show this help

Tip:
  bash scripts/reviewer-auth.sh --check
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --all)
      RUN_ALL=1
      shift
      ;;
    --file)
      INPUT_FILE="${2:-}"
      shift 2
      ;;
    --prompt)
      PROMPT_TEXT="${2:-}"
      shift 2
      ;;
    --list)
      MODEL="__LIST__"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

print_status_table() {
  local thinker raw state detail
  for thinker in codex claude gemini; do
    raw="$(get_status "$thinker")"
    state="${raw%%|*}"
    detail="${raw#*|}"
    printf '%-7s %-8s %s\n' "$thinker" "$state" "$detail"
  done
}

build_context() {
  if [[ -n "$INPUT_FILE" && -n "$PROMPT_TEXT" ]]; then
    echo "Use either --file or --prompt, not both." >&2
    exit 1
  fi

  if [[ -n "$INPUT_FILE" ]]; then
    if [[ ! -f "$INPUT_FILE" ]]; then
      echo "File not found: $INPUT_FILE" >&2
      exit 1
    fi
    cat "$INPUT_FILE"
    return
  fi

  if [[ -n "$PROMPT_TEXT" ]]; then
    printf '%s' "$PROMPT_TEXT"
    return
  fi

  echo "One of --file or --prompt is required." >&2
  exit 1
}

truncate_if_needed() {
  local content="$1"
  if (( ${#content} > MAX_CHARS )); then
    printf '%s\n\n（內容過長，僅顯示前 %d 字元）' "${content:0:MAX_CHARS}" "$MAX_CHARS"
    return
  fi
  printf '%s' "$content"
}

run_thinker() {
  local thinker="$1"
  local prompt="$2"

  case "$thinker" in
    codex)
      printf '%s' "$prompt" | codex exec -
      ;;
    claude)
      run_claude_headless "$prompt"
      ;;
    gemini)
      run_gemini_headless "$prompt"
      ;;
  esac
}

build_cross_think_prompt() {
  local context="$1"
  cat <<EOF
你是跨模型協作中的一位思考夥伴。請用繁體中文回覆。

任務：
請針對下方提供的問題、計畫、草案或想法，提出高價值的補充思考。

回覆重點：
1. 找出盲點、缺漏假設與隱含風險
2. 提出更好的替代方案或決策框架
3. 指出需要先釐清的關鍵問題
4. 優先給出可執行、可落地的建議

回覆格式：
- 關鍵判斷
- 主要風險
- 建議方案
- 需要補充的資訊
- 一句總結

以下是本次 cross-think 的共享內容：

$context
EOF
}

if [[ "$MODEL" == "__LIST__" ]]; then
  print_status_table
  exit 0
fi

if [[ "$RUN_ALL" -eq 1 && -n "$MODEL" ]]; then
  echo "Use either --model or --all, not both." >&2
  exit 1
fi

if [[ "$RUN_ALL" -eq 0 && -z "$MODEL" ]]; then
  echo "One of --model or --all is required." >&2
  exit 1
fi

if [[ -n "$MODEL" && ! "$MODEL" =~ ^(codex|claude|gemini)$ ]]; then
  echo "Unsupported model: $MODEL" >&2
  exit 1
fi

CONTEXT="$(build_context)"
CONTEXT="$(truncate_if_needed "$CONTEXT")"
PROMPT="$(build_cross_think_prompt "$CONTEXT")"

if [[ "$RUN_ALL" -eq 1 ]]; then
  THINKERS=()
  for thinker in codex claude gemini; do
    raw="$(get_status "$thinker")"
    state="${raw%%|*}"
    if [[ "$state" == "ready" ]]; then
      THINKERS+=("$thinker")
    fi
  done

  if [[ "${#THINKERS[@]}" -eq 0 ]]; then
    echo "No ready thinkers found. Run: bash scripts/reviewer-auth.sh" >&2
    print_status_table >&2
    exit 1
  fi
else
  raw="$(get_status "$MODEL")"
  state="${raw%%|*}"
  detail="${raw#*|}"
  if [[ "$state" != "ready" ]]; then
    echo "Thinker '$MODEL' is not ready: $detail" >&2
    echo "Run: bash scripts/reviewer-auth.sh $MODEL" >&2
    print_status_table >&2
    exit 1
  fi
  THINKERS=("$MODEL")
fi

for thinker in "${THINKERS[@]}"; do
  echo "───────────────────────────────────────"
  echo "🧠 Cross-Think by ${thinker}"
  echo "───────────────────────────────────────"
  echo
  run_thinker "$thinker" "$PROMPT"
  echo
  echo
done
