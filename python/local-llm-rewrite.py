#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from typing import Any


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def normalize_text(text: str) -> str:
    return " ".join(text.strip().split())


def run_custom_runner(payload: dict[str, Any], command: str) -> dict[str, Any]:
    result = subprocess.run(
        shlex.split(command),
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        timeout=float(os.environ.get("BICAPTION_LOCAL_LLM_TIMEOUT_SECONDS", "8")),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "custom runner failed")
    return json.loads(result.stdout.strip() or "{}")


def run_mlx(payload: dict[str, Any], model_path: str) -> dict[str, Any]:
    try:
        from mlx_lm import generate, load  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"dependency missing: {exc}") from exc

    model, tokenizer = load(model_path)
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt:
        raise RuntimeError("empty prompt")
    if hasattr(tokenizer, "apply_chat_template"):
        messages = [
            {
                "role": "system",
                "content": "You are a deterministic dictation cleanup engine. Return only the rewritten text.",
            },
            {
                "role": "user",
                "content": prompt,
            },
        ]
        try:
            prompt = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        except TypeError:
            prompt = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
            )
    max_tokens = int(os.environ.get("BICAPTION_LOCAL_LLM_MAX_TOKENS", "192"))
    generated = generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=max_tokens,
        verbose=False,
    )
    if isinstance(generated, str):
        text = generated
    else:
        text = str(generated)
    return {"text": normalize_text(text)}


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw:
        return fail("missing input payload")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return fail(f"invalid json: {exc}")

    custom_runner = str(payload.get("runner", "")).strip() or os.environ.get("BICAPTION_LOCAL_LLM_RUNNER", "").strip()
    if custom_runner:
        try:
            response = run_custom_runner(payload, custom_runner)
        except subprocess.TimeoutExpired:
            return fail("timeout")
        except Exception as exc:
            return fail(str(exc))
        sys.stdout.write(json.dumps(response, ensure_ascii=False))
        return 0

    model_path = str(payload.get("model", "")).strip() or os.environ.get("BICAPTION_LOCAL_LLM_MODEL", "").strip()
    if not model_path:
        return fail("model missing: set BICAPTION_LOCAL_LLM_MODEL or BICAPTION_LOCAL_LLM_RUNNER")

    try:
        response = run_mlx(payload, model_path)
    except subprocess.TimeoutExpired:
        return fail("timeout")
    except Exception as exc:
        return fail(str(exc))

    sys.stdout.write(json.dumps(response, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
