"""Local-only Qwen ASR pilot and raw transcript comparison.

No downloads, microphone, cloud APIs, or changes to the app's environment.
Manifest: [{"id": "clip1", "audio": "relative.wav", "reference": "...",
            "language": "Chinese", "category": "code-switching"}].
Score mode: [{"id": "clip1", "reference": "...", "hypothesis": "..."}].
Mixed-language CER/WER are diagnostics, not language-balanced rankings.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time
import wave

from asr_metrics import aggregate_scores, score_transcript


def read_rows(path: Path, audio: bool = False) -> list[dict]:
    rows = json.loads(path.read_text())
    if not isinstance(rows, list) or not rows:
        raise ValueError("input must be a non-empty JSON array")
    seen = set()
    result = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip() or row["id"] in seen:
            raise ValueError("rows require unique non-empty string ids")
        seen.add(row["id"])
        if not isinstance(row.get("reference"), str):
            raise ValueError("each row requires a reference string (empty for silence)")
        item = dict(row)
        if audio:
            if not isinstance(row.get("audio"), str) or not row["audio"].strip():
                raise ValueError("each row requires a local WAV path")
            item["audio"] = str((path.parent / row["audio"]).resolve())
            with wave.open(item["audio"], "rb") as wav:
                if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth(), wav.getcomptype()) != (1, 16000, 2, "NONE"):
                    raise ValueError("pilot input must be PCM16 16kHz mono WAV")
                seconds = wav.getnframes() / wav.getframerate()
                if not 0 < seconds <= 120:
                    raise ValueError("pilot clips must be 0 < duration <= 120 seconds")
                item["audio_seconds"] = seconds
            if row.get("language") is not None and (not isinstance(row["language"], str) or not row["language"].strip()):
                raise ValueError("language must be a non-empty name or omitted for detection")
        elif not isinstance(row.get("hypothesis"), str):
            raise ValueError("each score row requires a hypothesis string")
        result.append(item)
    return result


def score_rows(rows: list[dict]) -> dict:
    scored = [{**row, **score_transcript(row["reference"], row["hypothesis"])} for row in rows]
    categories = sorted({str(row.get("category", "unspecified")) for row in scored})
    return {
        "status": "scored", "normalization": "NFC; CER removes whitespace; case and punctuation retained",
        "rows": scored, "aggregate": aggregate_scores(scored),
        "by_category": {category: aggregate_scores([row for row in scored if str(row.get("category", "unspecified")) == category]) for category in categories},
    }


def run_qwen(rows: list[dict], model_dir: Path) -> dict:
    model_dir = model_dir.resolve()
    if not model_dir.is_dir() or not (model_dir / "config.json").is_file():
        raise ValueError("provide an already downloaded local Qwen3-ASR MLX model directory")
    # Enforced before any optional runtime import; model IDs are never accepted.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from mlx_audio.stt import load

    started = time.monotonic()
    model = load(str(model_dir))
    load_seconds = time.monotonic() - started
    predictions = []
    for row in rows:
        started = time.monotonic()
        kwargs = {"language": row["language"]} if row.get("language") else {}
        result = model.generate(row["audio"], **kwargs)
        elapsed = time.monotonic() - started
        if not isinstance(result.text, str):
            raise ValueError("runtime did not return a transcript string")
        predictions.append({**row, "hypothesis": result.text, "processing_seconds": elapsed,
                            "real_time_factor": elapsed / row["audio_seconds"]})
    scored = score_rows(predictions)
    scored.update(engine="qwen3-asr-mlx", model_path=str(model_dir),
                  runtime_version=importlib.metadata.version("mlx-audio"), load_seconds=load_seconds,
                  measurement="offline complete-clip transcription; not live first-token latency")
    return scored


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--score", type=Path, help="score baseline/candidate transcript JSON")
    group.add_argument("--manifest", type=Path, help="run Qwen on local WAV corpus")
    parser.add_argument("--model-dir", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.score:
            result = score_rows(read_rows(args.score))
        else:
            if args.model_dir is None:
                raise ValueError("--manifest requires --model-dir")
            rows = read_rows(args.manifest, audio=True)
            result = run_qwen(rows, args.model_dir)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except (ValueError, OSError, ImportError, wave.Error, RuntimeError, AttributeError) as error:
        print(json.dumps({"status": "blocked", "reason": str(error)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
