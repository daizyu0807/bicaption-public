#!/usr/bin/env bash
set -euo pipefail

MODEL="auto"
INPUT_FILE=""
LIST_ONLY=0
MAX_CHARS=20000

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/reviewer-common.sh"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/cross-review.sh [--model auto|codex|claude|gemini] [--file PATH] [--list]

Options:
  --model   Target reviewer model. Default: auto
  --file    Review a file instead of git diff
  --list    Show reviewer availability and exit
  -h,--help Show this help

Tip:
  bash scripts/reviewer-auth.sh
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --file)
      INPUT_FILE="${2:-}"
      shift 2
      ;;
    --list)
      LIST_ONLY=1
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

if [[ ! "$MODEL" =~ ^(auto|codex|claude|gemini)$ ]]; then
  echo "Unsupported model: $MODEL" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

CURRENT_CLI="unknown"
if [[ -n "${CLAUDE_CODE:-}" ]]; then
  CURRENT_CLI="claude"
elif [[ -n "${GEMINI_CLI:-}" || -n "${GEMINI_API_KEY:-}" ]]; then
  CURRENT_CLI="gemini"
elif [[ -n "${CODEX_CLI:-}" || -n "${CODEX_THREAD_ID:-}" ]]; then
  CURRENT_CLI="codex"
fi

print_status_table() {
  local reviewer raw state detail
  echo "Current CLI: $CURRENT_CLI"
  for reviewer in codex claude gemini; do
    raw="$(get_status "$reviewer")"
    state="${raw%%|*}"
    detail="${raw#*|}"
    printf '%-7s %-8s %s\n' "$reviewer" "$state" "$detail"
  done
}

choose_model() {
  local reviewer raw state
  for reviewer in codex claude gemini; do
    if [[ "$reviewer" == "$CURRENT_CLI" ]]; then
      continue
    fi
    raw="$(get_status "$reviewer")"
    state="${raw%%|*}"
    if [[ "$state" == "ready" ]]; then
      printf '%s' "$reviewer"
      return 0
    fi
  done

  for reviewer in codex claude gemini; do
    raw="$(get_status "$reviewer")"
    state="${raw%%|*}"
    if [[ "$state" == "ready" ]]; then
      printf '%s' "$reviewer"
      return 0
    fi
  done

  return 1
}

collect_review_content() {
  if [[ -n "$INPUT_FILE" ]]; then
    if [[ ! -f "$INPUT_FILE" ]]; then
      echo "File not found: $INPUT_FILE" >&2
      exit 1
    fi
    cat "$INPUT_FILE"
    return
  fi

  local diff=""
  diff="$(git diff HEAD 2>/dev/null || true)"
  if [[ -z "$diff" ]]; then
    diff="$(git diff HEAD~1 2>/dev/null || true)"
  fi
  if [[ -z "$diff" ]]; then
    echo "沒有偵測到改動，無法進行 cross-review。" >&2
    exit 1
  fi
  printf '%s' "$diff"
}

truncate_if_needed() {
  local content="$1"
  if (( ${#content} > MAX_CHARS )); then
    printf '%s\n\n（內容過長，僅顯示前 %d 字元）' "${content:0:MAX_CHARS}" "$MAX_CHARS"
    return
  fi
  printf '%s' "$content"
}

run_review() {
  local reviewer="$1"
  local prompt="$2"

  case "$reviewer" in
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

if [[ "$LIST_ONLY" -eq 1 ]]; then
  print_status_table
  exit 0
fi

TARGET_MODEL="$MODEL"
if [[ "$TARGET_MODEL" == "auto" ]]; then
  if ! TARGET_MODEL="$(choose_model)"; then
    echo "沒有可用的 reviewer。請先登入至少一個 CLI。" >&2
    print_status_table >&2
    exit 1
  fi
fi

TARGET_STATUS="$(get_status "$TARGET_MODEL")"
TARGET_STATE="${TARGET_STATUS%%|*}"
TARGET_DETAIL="${TARGET_STATUS#*|}"

if [[ "$TARGET_STATE" != "ready" ]]; then
  echo "Reviewer '$TARGET_MODEL' is not ready: $TARGET_DETAIL" >&2
  echo "Run: bash scripts/reviewer-auth.sh $TARGET_MODEL" >&2
  print_status_table >&2
  exit 1
fi

REVIEW_CONTENT="$(collect_review_content)"
REVIEW_CONTENT="$(truncate_if_needed "$REVIEW_CONTENT")"

PROMPT=$(
  cat <<EOF
你是一個 code reviewer，負責審查另一個 AI agent 的產出。
請用繁體中文回覆。

## 審查重點
1. 邏輯錯誤或遺漏的 edge case
2. 安全風險（注入、敏感資料洩露）
3. 原本 AI 的盲點（過度工程、漏改相關檔案、破壞既有行為）
4. 命名與一致性問題

## 回饋格式
用三個等級分類：
- 🔴 必須修正 — 會造成 bug 或安全問題
- 🟡 建議修正 — 改了會更好
- 🟢 觀察 — 不需改但值得注意

每項回饋包含：檔案路徑、問題描述、建議修正方式。
最後給一句整體評價。

## 以下是本次改動的內容：

$REVIEW_CONTENT
EOF
)

echo "───────────────────────────────────────"
echo "📋 Cross-Review by ${TARGET_MODEL}"
echo "───────────────────────────────────────"
echo
run_review "$TARGET_MODEL" "$PROMPT"
echo
echo "───────────────────────────────────────"
