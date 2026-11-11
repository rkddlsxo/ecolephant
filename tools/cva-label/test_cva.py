import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cva import (
    DEFAULT_C7_HSV,
    DEFAULT_TRAGUS_HSV,
    HsvRange,
    Pt,
    approx_cva,
    cva_deg,
    find_sticker,
    near_side,
    summarize_segments,
)


def P(x, y, conf=0.9):
    return SimpleNamespace(x=x, y=y, conf=conf)


def test_cva_geometry():
    # Tragus 100 px right of and 100 px above C7 → 45°.
    assert cva_deg(Pt(200, 100), Pt(100, 200)) == pytest.approx(45.0)
    # Facing the other way gives the same angle.
    assert cva_deg(Pt(0, 100), Pt(100, 200)) == pytest.approx(45.0)
    # Head straight above C7 → 90°, more forward → smaller.
    assert cva_deg(Pt(100, 0), Pt(100, 200)) == pytest.approx(90.0)
    upright = cva_deg(Pt(150, 80), Pt(100, 200))
    forward = cva_deg(Pt(220, 120), Pt(100, 200))
    assert upright > 50 > forward
    with pytest.raises(ValueError):
        cva_deg(Pt(1, 1), Pt(1, 1))


def test_hsv_parse():
    assert HsvRange.parse("1,2,3,4,5,6") == HsvRange((1, 2, 3), (4, 5, 6))
    with pytest.raises(ValueError):
        HsvRange.parse("1,2,3")


def _image_with_stickers(tragus=(400, 150), c7=(300, 300), radius=8):
    import cv2

    img = np.full((480, 640, 3), 200, np.uint8)
    cv2.circle(img, tragus, radius, (0, 200, 0), -1)  # green (BGR)
    cv2.circle(img, c7, radius, (200, 0, 0), -1)  # blue (BGR)
    cv2.circle(img, (50, 50), 2, (0, 200, 0), -1)  # small green noise, smaller than min_area
    return img


def test_find_stickers_and_angle():
    img = _image_with_stickers()
    tragus = find_sticker(img, DEFAULT_TRAGUS_HSV)
    c7 = find_sticker(img, DEFAULT_C7_HSV)
    assert tragus == Pt(pytest.approx(400, abs=1), pytest.approx(150, abs=1))
    assert c7 == Pt(pytest.approx(300, abs=1), pytest.approx(300, abs=1))
    assert cva_deg(tragus, c7) == pytest.approx(math.degrees(math.atan2(150, 100)), abs=0.5)


def test_missing_sticker_is_none():
    img = np.full((100, 100, 3), 200, np.uint8)
    assert find_sticker(img, DEFAULT_TRAGUS_HSV) is None


def test_near_side_picks_confident_pair():
    points = {
        "left_ear": P(300, 100, 0.95),
        "left_shoulder": P(250, 250, 0.9),
        "right_ear": P(310, 100, 0.2),  # hidden far side
        "right_shoulder": P(260, 250, 0.3),
    }
    pair = near_side(points)
    assert pair.side == "left"
    angle, side = approx_cva(points)
    assert side == "left"
    assert angle == pytest.approx(math.degrees(math.atan2(150, 50)))
    assert approx_cva({"left_ear": P(1, 1, 0.2), "left_shoulder": P(2, 2, 0.2)}) is None


def test_segment_summary_counts_missing_and_does_not_fill():
    rows = [
        {"timestamp_ms": 0, "sticker_cva": "55", "approx_cva": "60"},
        {"timestamp_ms": 100, "sticker_cva": "57", "approx_cva": "61"},
        {"timestamp_ms": 200, "sticker_cva": "", "approx_cva": "62"},
        {"timestamp_ms": 1000, "sticker_cva": "45", "approx_cva": ""},
        {"timestamp_ms": 1100, "sticker_cva": "47", "approx_cva": "50"},
    ]
    segments = [
        {"start_ms": 0, "end_ms": 1000, "label": "upright"},
        {"start_ms": 1000, "end_ms": 2000, "label": "chin_forward"},
        {"start_ms": 2000, "end_ms": 3000, "label": "empty"},
    ]
    upright, forward, empty = summarize_segments(rows, segments, threshold_deg=50)
    assert upright.frames == 3 and upright.sticker_valid == 2
    assert upright.sticker_median == pytest.approx(56)
    assert upright.approx_minus_sticker == pytest.approx(4.5)
    assert upright.below_threshold is False
    assert forward.sticker_median == pytest.approx(46)
    assert forward.below_threshold is True
    assert forward.approx_minus_sticker == pytest.approx(3)
    assert empty.frames == 0 and empty.sticker_median is None and empty.below_threshold is None


def test_cli_on_synthetic_video(tmp_path, monkeypatch):
    import cv2
    import label_video

    video = tmp_path / "p00_side.avi"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 10, (640, 480))
    for i in range(20):
        # First second upright (tragus well above C7), second second head forward.
        tragus = (360, 140) if i < 10 else (430, 220)
        writer.write(_image_with_stickers(tragus=tragus, c7=(300, 300), radius=10))
    writer.release()
    segments = tmp_path / "segments.json"
    segments.write_text(
        json.dumps(
            [
                {"start_ms": 0, "end_ms": 1000, "label": "upright"},
                {"start_ms": 1000, "end_ms": 2000, "label": "forward"},
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    assert label_video.main([str(video), "--stride", "1", "--segments", str(segments)]) == 0
    out = tmp_path / ".data/cva/p00_side_cva.csv"
    lines = out.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 21
    summary = (tmp_path / ".data/cva/p00_side_cva_segments.csv").read_text(encoding="utf-8")
    assert "upright" in summary and "forward" in summary
    upright_cva = math.degrees(math.atan2(160, 60))
    forward_cva = math.degrees(math.atan2(80, 130))
    assert f"{upright_cva:.1f}"[:2] in summary
    assert upright_cva > 50 > forward_cva
    assert label_video.main([str(video), "--check", "15"]) == 0
    assert (tmp_path / ".data/cva/p00_side_check_000015.jpg").exists()
