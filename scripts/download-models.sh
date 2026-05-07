#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_DIR="$SCRIPT_DIR/../python"

SENSEVOICE_DIR="$PYTHON_DIR/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
VAD_MODEL="$PYTHON_DIR/silero_vad.onnx"

echo "==> Downloading SenseVoice model..."
if [ -d "$SENSEVOICE_DIR" ] && [ -f "$SENSEVOICE_DIR/model.int8.onnx" ]; then
  echo "    SenseVoice model already exists, skipping."
else
  cd "$PYTHON_DIR"
  curl -SL -o sensevoice.tar.bz2 \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2"
  tar xjf sensevoice.tar.bz2
  rm sensevoice.tar.bz2
  echo "    SenseVoice model downloaded."
fi

echo "==> Downloading Silero VAD model..."
if [ -f "$VAD_MODEL" ]; then
  echo "    Silero VAD model already exists, skipping."
else
  curl -SL -o "$VAD_MODEL" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
  echo "    Silero VAD model downloaded."
fi

echo "==> All models ready."
