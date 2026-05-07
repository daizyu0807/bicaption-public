#!/usr/bin/env bash

is_codex_sandbox() {
  [[ -n "${CODEX_SANDBOX:-}" ]]
}

claude_needs_host_execution() {
  is_codex_sandbox && has_claude_local_state
}

trim() {
  printf '%s' "$1" | awk '{$1=$1; print}'
}

claude_config_path() {
  printf '%s/.claude.json' "${HOME}"
}

claude_settings_dir() {
  printf '%s/.claude' "${HOME}"
}

has_claude_local_state() {
  [[ -f "$(claude_config_path)" && -d "$(claude_settings_dir)" ]]
}

strip_ansi() {
  perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\].*?\a//g; s/\r//g;'
}

gemini_settings_path() {
  printf '%s/.gemini/settings.json' "${HOME}"
}

gemini_oauth_creds_path() {
  printf '%s/.gemini/oauth_creds.json' "${HOME}"
}

has_gemini_oauth_login() {
  local settings_path
  settings_path="$(gemini_settings_path)"
  [[ -f "$settings_path" ]] || return 1
  rg -q '"selectedType"[[:space:]]*:[[:space:]]*"oauth-personal"' "$settings_path"
}

has_gemini_oauth_creds() {
  [[ -f "$(gemini_oauth_creds_path)" ]]
}

status_codex() {
  if ! command -v codex >/dev/null 2>&1; then
    echo "missing|Codex CLI not installed"
    return
  fi

  local output
  output="$(codex login status 2>&1 || true)"
  output="$(printf '%s\n' "$output" | rg -v '^WARNING: proceeding, even though we could not update PATH:' || true)"
  if printf '%s' "$output" | rg -q "Logged in"; then
    echo "ready|$(trim "$output")"
    return
  fi
  echo "auth|$(trim "$output")"
}

status_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    echo "missing|Claude CLI not installed"
    return
  fi

  local output
  output="$(claude auth status 2>&1 || true)"
  if printf '%s' "$output" | rg -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
    echo "ready|$(trim "$output")"
    return
  fi
  if claude_needs_host_execution; then
    echo "unknown|Claude local state exists, but Codex sandbox cannot verify or use Claude auth directly; run outside sandbox or via escalated execution"
    return
  fi
  if printf '%s' "$output" | rg -q '"loggedIn"[[:space:]]*:[[:space:]]*false'; then
    echo "auth|$(trim "$output")"
    return
  fi
  echo "unknown|$(trim "$output")"
}

status_gemini() {
  if ! command -v gemini >/dev/null 2>&1; then
    echo "missing|Gemini CLI not installed"
    return
  fi

  if [[ -n "${GEMINI_API_KEY:-}" ]]; then
    echo "ready|GEMINI_API_KEY is set"
    return
  fi

  if has_gemini_oauth_login && has_gemini_oauth_creds; then
    echo "ready|OAuth cached at ~/.gemini; use GOOGLE_GENAI_USE_GCA=true for headless runs"
    return
  fi

  if has_gemini_oauth_login; then
    echo "auth|Gemini settings exist but oauth_creds.json is missing"
    return
  fi

  echo "auth|Gemini CLI needs interactive Google sign-in"
}

get_status() {
  case "$1" in
    codex) status_codex ;;
    claude) status_claude ;;
    gemini) status_gemini ;;
    *)
      echo "unknown|Unsupported reviewer: $1"
      ;;
  esac
}

gemini_primary_model() {
  printf '%s' "${GEMINI_HEADLESS_MODEL:-gemini-3-pro-preview}"
}

gemini_fallback_model() {
  printf '%s' "${GEMINI_HEADLESS_FALLBACK_MODEL:-gemini-2.5-flash}"
}

gemini_should_retry_with_fallback() {
  local stderr_path="$1"
  rg -q 'MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|429|rateLimitExceeded|No capacity available' "$stderr_path"
}

run_gemini_headless() {
  local prompt="$1"
  local primary_model fallback_model stdout_path stderr_path exit_code

  primary_model="$(gemini_primary_model)"
  fallback_model="$(gemini_fallback_model)"
  stdout_path="$(mktemp)"
  stderr_path="$(mktemp)"

  if GOOGLE_GENAI_USE_GCA=true gemini -m "$primary_model" -p "$prompt" >"$stdout_path" 2>"$stderr_path"; then
    cat "$stderr_path" >&2
    cat "$stdout_path"
    rm -f "$stdout_path" "$stderr_path"
    return 0
  fi

  exit_code=$?
  cat "$stderr_path" >&2

  if [[ -n "$fallback_model" && "$fallback_model" != "$primary_model" ]] && gemini_should_retry_with_fallback "$stderr_path"; then
    echo "[gemini] primary model '$primary_model' unavailable, retrying with '$fallback_model'" >&2
    if GOOGLE_GENAI_USE_GCA=true gemini -m "$fallback_model" -p "$prompt" >"$stdout_path" 2>"$stderr_path"; then
      cat "$stderr_path" >&2
      cat "$stdout_path"
      rm -f "$stdout_path" "$stderr_path"
      return 0
    fi
    exit_code=$?
    cat "$stderr_path" >&2
  fi

  rm -f "$stdout_path" "$stderr_path"
  return "$exit_code"
}

run_claude_headless() {
  local prompt="$1"
  if claude_needs_host_execution; then
    echo "Claude headless execution is unavailable inside Codex sandbox; rerun outside sandbox or with escalated execution." >&2
    return 1
  fi
  if command -v script >/dev/null 2>&1; then
    script -q /dev/null claude -p "$prompt" --tools "" --no-session-persistence | strip_ansi
    return
  fi
  printf '%s' "$prompt" | claude -p --tools "" --no-session-persistence | strip_ansi
}
