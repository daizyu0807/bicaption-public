"""Raw ASR transcript metrics.

CER uses Unicode NFC text with all whitespace removed; WER uses Unicode NFC
text split on whitespace. Both retain original case and punctuation.
"""

from __future__ import annotations

import unicodedata


def edit_distance(reference: list[str], hypothesis: list[str]) -> int:
    """Return Levenshtein distance using two dynamic-programming rows."""
    if len(reference) < len(hypothesis):
        reference, hypothesis = hypothesis, reference

    previous = list(range(len(hypothesis) + 1))
    for i, ref_unit in enumerate(reference, 1):
        current = [i]
        for j, hyp_unit in enumerate(hypothesis, 1):
            current.append(min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (ref_unit != hyp_unit),
            ))
        previous = current
    return previous[-1]


def _metric(reference: list[str], hypothesis: list[str]) -> dict:
    errors = edit_distance(reference, hypothesis)
    units = len(reference)
    return {
        "errors": errors,
        "reference_units": units,
        "rate": errors / units if units else (0.0 if not hypothesis else None),
    }


def score_transcript(reference: str, hypothesis: str) -> dict:
    """Score raw transcripts without silently stripping case or punctuation."""
    if not isinstance(reference, str) or not isinstance(hypothesis, str):
        raise TypeError("reference and hypothesis must be strings")

    cer_reference = [
        char for char in unicodedata.normalize("NFC", reference)
        if not char.isspace()
    ]
    cer_hypothesis = [
        char for char in unicodedata.normalize("NFC", hypothesis)
        if not char.isspace()
    ]
    wer_reference = unicodedata.normalize("NFC", reference).split()
    wer_hypothesis = unicodedata.normalize("NFC", hypothesis).split()

    return {
        "cer": _metric(cer_reference, cer_hypothesis),
        "wer": _metric(wer_reference, wer_hypothesis),
    }


def aggregate_scores(rows: list[dict]) -> dict:
    """Micro-aggregate raw metric counts across scored transcript rows."""
    if not isinstance(rows, list):
        raise ValueError("rows must be a list")

    totals = {
        "cer": {"errors": 0, "reference_units": 0},
        "wer": {"errors": 0, "reference_units": 0},
    }
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("each row must be a dictionary")
        for name in ("cer", "wer"):
            if name not in row or not isinstance(row[name], dict):
                raise ValueError(f"missing metric: {name}")
            metric = row[name]
            for key in ("errors", "reference_units"):
                if key not in metric:
                    raise ValueError(f"missing {name}.{key}")
                value = metric[key]
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    raise ValueError(f"invalid {name}.{key}")
                totals[name][key] += value

    for metric in totals.values():
        errors = metric["errors"]
        units = metric["reference_units"]
        metric["rate"] = errors / units if units else (0.0 if errors == 0 else None)
    return totals
