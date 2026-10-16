#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build/native"
swiftc -O -parse-as-library -target arm64-apple-macos26 \
  -module-cache-path "${TMPDIR:-/tmp}/bicaption-intelligence-module-cache" \
  "$ROOT/swift/apple-intelligence.swift" -framework FoundationModels \
  -o "$ROOT/build/native/apple-intelligence"
