"""Craniovertebral angle (CVA) helpers for the validation experiment's side-view video.

The reference label is the angle between the horizontal through C7 and the line from C7 to the
tragus, measured on stickers placed on both points (docs/quality/measurement-validation.md).
MediaPipe has no C7 point, so `approx_cva` uses the near-side ear and shoulder instead and is
only reported next to the sticker value to measure that gap.

Everything here runs on local files. Nothing touches the network or the backend, and the
service never uses side-view input (2026-11-11).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from statistics import median

import numpy as np


@dataclass(frozen=True)
class Pt:
    x: float
    y: float


def cva_deg(tragus: Pt, c7: Pt) -> float:
    """Angle in degrees between the horizontal through C7 and the C7→tragus line.

    Image coordinates (y grows downward). Facing left or right gives the same value.
    Larger = head more upright; smaller = head further forward.
    """
    dx = abs(tragus.x - c7.x)
    dy = c7.y - tragus.y
    if dx == 0 and dy == 0:
        raise ValueError("tragus and C7 are the same point")
    return math.degrees(math.atan2(dy, dx))


@dataclass(frozen=True)
class HsvRange:
    lower: tuple[int, int, int]
    upper: tuple[int, int, int]

    @staticmethod
    def parse(text: str) -> HsvRange:
        """`"h1,s1,v1,h2,s2,v2"` in OpenCV HSV units (H 0-179, S/V 0-255)."""
        values = [int(v) for v in text.split(",")]
        if len(values) != 6:
            raise ValueError("HSV range needs 6 numbers: h1,s1,v1,h2,s2,v2")
        return HsvRange(tuple(values[:3]), tuple(values[3:]))  # type: ignore[arg-type]


# Defaults for two clearly different sticker colours. Avoid red (its hue wraps around 0).
DEFAULT_TRAGUS_HSV = HsvRange((40, 80, 60), (85, 255, 255))  # green
DEFAULT_C7_HSV = HsvRange((95, 80, 60), (130, 255, 255))  # blue


def find_sticker(bgr: np.ndarray, hsv_range: HsvRange, min_area: int = 30) -> Pt | None:
    """Centre of the largest blob in the colour range, or None when none is big enough."""
    import cv2

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array(hsv_range.lower), np.array(hsv_range.upper))
    count, _, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    best = None
    best_area = 0
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area >= min_area and area > best_area:
            best_area = area
            best = Pt(float(centroids[label][0]), float(centroids[label][1]))
    return best


@dataclass(frozen=True)
class SidePoints:
    side: str
    ear: Pt
    shoulder: Pt
    conf: float


def near_side(points: dict, min_conf: float = 0.5) -> SidePoints | None:
    """Pick the camera-facing ear+shoulder pair from pose points.

    `points` maps "left_ear", "right_ear", "left_shoulder", "right_shoulder" to objects with
    x, y, conf (pixels). The side whose weaker point is more confident wins.
    """
    best: SidePoints | None = None
    for side in ("left", "right"):
        ear = points.get(f"{side}_ear")
        shoulder = points.get(f"{side}_shoulder")
        if ear is None or shoulder is None or ear.x is None or shoulder.x is None:
            continue
        conf = min(ear.conf or 0.0, shoulder.conf or 0.0)
        if conf < min_conf:
            continue
        if best is None or conf > best.conf:
            best = SidePoints(side, Pt(ear.x, ear.y), Pt(shoulder.x, shoulder.y), conf)
    return best


def approx_cva(points: dict, min_conf: float = 0.5) -> tuple[float, str] | None:
    """Ear–shoulder angle on the near side ("approximate CVA"), with the side used."""
    pair = near_side(points, min_conf)
    if pair is None:
        return None
    return cva_deg(pair.ear, pair.shoulder), pair.side


@dataclass
class SegmentSummary:
    label: str
    start_ms: float
    end_ms: float
    frames: int
    sticker_valid: int
    sticker_median: float | None
    sticker_iqr: float | None
    approx_valid: int
    approx_median: float | None
    approx_minus_sticker: float | None
    below_threshold: bool | None


def _iqr(values: Sequence[float]) -> float | None:
    if len(values) < 2:
        return None
    q1, q3 = np.percentile(values, [25, 75])
    return float(q3 - q1)


def summarize_segments(
    rows: Iterable[dict], segments: Sequence[dict], threshold_deg: float = 50.0
) -> list[SegmentSummary]:
    """Median sticker CVA and approximate CVA per protocol segment.

    `rows` have timestamp_ms and optional sticker_cva / approx_cva (None or "" when missing).
    Missing values are counted, never filled in. `below_threshold` compares the sticker median
    with the forward-head threshold used in the literature (e.g. 50°, Lee et al. 2025); it is a
    reference label for the experiment, not a diagnosis.
    """
    rows = list(rows)
    out: list[SegmentSummary] = []

    def value(row: dict, key: str) -> float | None:
        raw = row.get(key)
        if raw is None or raw == "":
            return None
        number = float(raw)
        return number if math.isfinite(number) else None

    for seg in segments:
        inside = [r for r in rows if seg["start_ms"] <= float(r["timestamp_ms"]) < seg["end_ms"]]
        sticker = [v for v in (value(r, "sticker_cva") for r in inside) if v is not None]
        approx = [v for v in (value(r, "approx_cva") for r in inside) if v is not None]
        paired = [
            a - s
            for a, s in ((value(r, "approx_cva"), value(r, "sticker_cva")) for r in inside)
            if a is not None and s is not None
        ]
        sticker_median = median(sticker) if sticker else None
        out.append(
            SegmentSummary(
                label=seg.get("label", ""),
                start_ms=seg["start_ms"],
                end_ms=seg["end_ms"],
                frames=len(inside),
                sticker_valid=len(sticker),
                sticker_median=sticker_median,
                sticker_iqr=_iqr(sticker),
                approx_valid=len(approx),
                approx_median=median(approx) if approx else None,
                approx_minus_sticker=median(paired) if paired else None,
                below_threshold=None if sticker_median is None else sticker_median < threshold_deg,
            )
        )
    return out
