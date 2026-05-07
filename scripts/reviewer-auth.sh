#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/reviewer-common.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/reviewer-auth.sh                # check all reviewers
  bash scripts/reviewer-auth.sh codex          # login Codex if needed
  bash scripts/reviewer-auth.sh claude gemini  # login selected reviewers if needed
  bash scripts/reviewer-auth.sh --check        # status only, no login flow

Supported reviewers:
  codex
  claude
  gemini
EOF
  exit 0
fi

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
  shift
fi

run_login() {
  case "$1" in
    codex)
      codex login
      ;;
    claude)
      claude auth login
      ;;
    gemini)
      echo "Gemini CLI 互動登入：會使用 Google OAuth；headless 腳本會自動加上 GOOGLE_GENAI_USE_GCA=true。"
      gemini
      ;;
  esac
}

print_status() {
  local reviewer raw state detail
  for reviewer in "$@"; do
    raw="$(get_status "$reviewer")"
    state="${raw%%|*}"
    detail="${raw#*|}"
    printf '%-7s %-8s %s\n' "$reviewer" "$state" "$detail"
  done
}

ensure_supported() {
  local reviewer
  for reviewer in "$@"; do
    case "$reviewer" in
      codex|claude|gemini) ;;
      *)
        echo "Unsupported reviewer: $reviewer" >&2
        exit 1
        ;;
    esac
  done
}

if [[ "$#" -eq 0 ]]; then
  REVIEWERS=(codex claude gemini)
else
  REVIEWERS=("$@")
fi

ensure_supported "${REVIEWERS[@]}"

echo "Reviewer status:"
print_status "${REVIEWERS[@]}"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  exit 0
fi

for reviewer in "${REVIEWERS[@]}"; do
  raw="$(get_status "$reviewer")"
  state="${raw%%|*}"
  detail="${raw#*|}"

  case "$state" in
    ready)
      echo
      echo "[$reviewer] already ready"
      ;;
    auth)
      echo
      echo "[$reviewer] auth required"
      run_login "$reviewer"
      ;;
    unknown)
      echo
      echo "[$reviewer] status unknown: $detail"
      if [[ "$reviewer" == "claude" && -n "${CODEX_SANDBOX:-}" ]]; then
        echo "[$reviewer] skip interactive login inside Codex sandbox; use escalated execution or run this script in a normal terminal"
      else
        echo "[$reviewer] opening login flow anyway"
        run_login "$reviewer"
      fi
      ;;
    missing)
      echo
      echo "[$reviewer] missing: $detail" >&2
      ;;
  esac
done

echo
echo "Reviewer status after auth:"
print_status "${REVIEWERS[@]}"
