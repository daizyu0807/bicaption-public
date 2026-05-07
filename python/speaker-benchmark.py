#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np

from sidecar import (
    SAMPLE_RATE,
    assess_speaker_audio,
    build_speaker_fingerprint,
    compare_speaker_fingerprints,
)


@dataclass
class BenchmarkCaseResult:
    case_id: str
    audio_path: str
    expected_match: bool
    predicted_match: bool
    confidence: float
    speech_ratio: float
    quality_valid: bool
    outcome: str
    notes: str = ""


def load_mono_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frame_count = wav_file.getnframes()
        raw = wav_file.readframes(frame_count)
    if channels != 1:
        raise ValueError(f"{path} must be mono WAV, got {channels} channels")
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f"{path} must use {SAMPLE_RATE}Hz, got {sample_rate}Hz")
    if sample_width != 2:
        raise ValueError(f"{path} must use 16-bit PCM, got sample width {sample_width}")
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return audio


def evaluate_case(
    reference_fingerprint: list[float],
    audio: np.ndarray,
    case_id: str,
    audio_path: str,
    expected_match: bool,
    threshold: float,
    notes: str = "",
) -> BenchmarkCaseResult:
    quality = assess_speaker_audio(audio)
    candidate = build_speaker_fingerprint(audio)
    confidence = compare_speaker_fingerprints(reference_fingerprint, candidate)
    predicted_match = candidate is not None and confidence >= threshold
    if expected_match and predicted_match:
        outcome = "true_positive"
    elif expected_match and not predicted_match:
        outcome = "false_negative"
    elif not expected_match and predicted_match:
        outcome = "false_positive"
    else:
        outcome = "true_negative"
    return BenchmarkCaseResult(
        case_id=case_id,
        audio_path=audio_path,
        expected_match=expected_match,
        predicted_match=predicted_match,
        confidence=round(confidence, 6),
        speech_ratio=round(quality.speech_ratio, 6),
        quality_valid=quality.valid,
        outcome=outcome,
        notes=notes,
    )


def summarize_results(results: list[BenchmarkCaseResult], threshold: float) -> dict[str, Any]:
    positives = [result for result in results if result.expected_match]
    negatives = [result for result in results if not result.expected_match]
    true_positive = sum(result.outcome == "true_positive" for result in results)
    true_negative = sum(result.outcome == "true_negative" for result in results)
    false_positive = sum(result.outcome == "false_positive" for result in results)
    false_negative = sum(result.outcome == "false_negative" for result in results)
    avg_positive_confidence = (
        sum(result.confidence for result in positives) / len(positives)
        if positives else 0.0
    )
    avg_negative_confidence = (
        sum(result.confidence for result in negatives) / len(negatives)
        if negatives else 0.0
    )
    return {
        "threshold": threshold,
        "totalCases": len(results),
        "positiveCases": len(positives),
        "negativeCases": len(negatives),
        "truePositive": true_positive,
        "trueNegative": true_negative,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "falseAcceptRate": round(false_positive / len(negatives), 6) if negatives else 0.0,
        "falseRejectRate": round(false_negative / len(positives), 6) if positives else 0.0,
        "avgPositiveConfidence": round(avg_positive_confidence, 6),
        "avgNegativeConfidence": round(avg_negative_confidence, 6),
    }


def format_markdown_report(manifest_name: str, summary: dict[str, Any], results: list[BenchmarkCaseResult]) -> str:
    lines = [
        f"# Speaker Benchmark Report",
        "",
        f"- Manifest: `{manifest_name}`",
        f"- Threshold: `{summary['threshold']:.2f}`",
        f"- Total cases: `{summary['totalCases']}`",
        f"- False accept rate: `{summary['falseAcceptRate']:.3f}`",
        f"- False reject rate: `{summary['falseRejectRate']:.3f}`",
        f"- Avg positive confidence: `{summary['avgPositiveConfidence']:.3f}`",
        f"- Avg negative confidence: `{summary['avgNegativeConfidence']:.3f}`",
        "",
        "## Cases",
        "",
        "| Case | Expected | Predicted | Outcome | Confidence | Speech Ratio | Quality |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for result in results:
        lines.append(
            f"| `{result.case_id}` | "
            f"{'match' if result.expected_match else 'non-match'} | "
            f"{'match' if result.predicted_match else 'non-match'} | "
            f"`{result.outcome}` | `{result.confidence:.3f}` | `{result.speech_ratio:.3f}` | "
            f"{'valid' if result.quality_valid else 'invalid'} |"
        )
    return "\n".join(lines) + "\n"


def run_benchmark(manifest_path: Path, output_dir: Path, threshold_override: float | None = None) -> dict[str, Any]:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    threshold = float(threshold_override if threshold_override is not None else manifest.get("threshold", 0.82))
    base_dir = manifest_path.parent
    reference_path = base_dir / str(manifest["reference"]["audioPath"])
    reference_audio = load_mono_wav(reference_path)
    reference_fingerprint = build_speaker_fingerprint(reference_audio, min_speech_ratio=0.5)
    if reference_fingerprint is None:
        raise RuntimeError(f"Reference audio is not usable for fingerprint extraction: {reference_path}")
    results: list[BenchmarkCaseResult] = []
    for index, case in enumerate(manifest.get("cases", []), start=1):
        case_path = base_dir / str(case["audioPath"])
        case_audio = load_mono_wav(case_path)
        results.append(
            evaluate_case(
                reference_fingerprint=reference_fingerprint,
                audio=case_audio,
                case_id=str(case.get("id", f"case-{index}")),
                audio_path=str(case_path),
                expected_match=bool(case["expectedMatch"]),
                threshold=threshold,
                notes=str(case.get("notes", "")),
            )
        )
    summary = summarize_results(results, threshold)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"{timestamp}-speaker-benchmark.json"
    md_path = output_dir / f"{timestamp}-speaker-benchmark.md"
    payload = {
        "manifest": str(manifest_path),
        "referenceAudioPath": str(reference_path),
        "summary": summary,
        "results": [result.__dict__ for result in results],
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(format_markdown_report(manifest_path.name, summary, results), encoding="utf-8")
    return {
        "jsonPath": str(json_path),
        "markdownPath": str(md_path),
        "summary": summary,
    }


def cli() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=str)
    parser.add_argument("--output-dir", type=str, default=None)
    parser.add_argument("--threshold", type=float, default=None)
    args = parser.parse_args()
    manifest_path = Path(args.manifest).expanduser().resolve()
    default_output_dir = manifest_path.parent / "benchmark-results"
    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else default_output_dir
    result = run_benchmark(manifest_path, output_dir, threshold_override=args.threshold)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(cli())
