"""Shared definitions for the pose model comparison tool.

Only the five points the service uses are compared. Coordinates are pixels in the
original (unmirrored) video frame. Nothing here touches the network or the backend.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

POINTS = ("nose", "left_ear", "right_ear", "left_shoulder", "right_shoulder")

# COCO-17 indices used by MoveNet, RTMPose and YOLO pose.
COCO_INDEX = {"nose": 0, "left_ear": 3, "right_ear": 4, "left_shoulder": 5, "right_shoulder": 6}
# MediaPipe Pose (BlazePose 33) indices.
MEDIAPIPE_INDEX = {"nose": 0, "left_ear": 7, "right_ear": 8, "left_shoulder": 11, "right_shoulder": 12}

# Default per-model confidence thresholds for "point present". Scores are not comparable
# across models, so every report prints the threshold it used.
DEFAULT_THRESHOLDS = {
    "mediapipe": 0.7,  # same as the service (policy.calibration.landmark_confidence_min)
    "movenet": 0.3,
    "rtmpose": 0.3,
    "yolo11n": 0.5,
    "sapiens": 0.3,
}

CSV_FIELDS = ("frame", "timestamp_ms", "width", "height", "model", "point", "x", "y", "conf")


@dataclass
class Point:
    x: float | None
    y: float | None
    conf: float | None


def write_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if new:
            writer.writeheader()
        writer.writerows(rows)


def frame_rows(model: str, frame: int, ts_ms: float, w: int, h: int, pts: dict[str, Point]) -> list[dict]:
    rows = []
    for name in POINTS:
        p = pts.get(name) or Point(None, None, None)
        rows.append(
            {
                "frame": frame,
                "timestamp_ms": round(ts_ms, 1),
                "width": w,
                "height": h,
                "model": model,
                "point": name,
                "x": "" if p.x is None else round(p.x, 2),
                "y": "" if p.y is None else round(p.y, 2),
                "conf": "" if p.conf is None else round(p.conf, 4),
            }
        )
    return rows
