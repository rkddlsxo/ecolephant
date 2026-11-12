"""Metric tests on synthetic data (no models or videos needed).

  python -m pytest tools/pose-compare -q
"""

import json

import import_sapiens
import numpy as np
import pandas as pd
import pytest
from common import POINTS
from metrics import agreement, jitter, load, markdown, missing_rate, report, wide

BASE = {
    "nose": (320, 200),
    "left_ear": (360, 190),
    "right_ear": (280, 190),
    "left_shoulder": (420, 320),
    "right_shoulder": (220, 320),
}  # shoulder width = 200 px


def rows(model, frames, offset=(0.0, 0.0), conf=0.9, noise=0.0, drop=None, seed=0):
    rng = np.random.default_rng(seed)
    out = []
    for f in frames:
        for p in POINTS:
            x, y = BASE[p]
            x += offset[0] + rng.normal(0, noise)
            y += offset[1] + rng.normal(0, noise)
            missing = drop is not None and drop(f, p)
            out.append(
                {
                    "frame": f,
                    "timestamp_ms": f * 100.0,
                    "width": 640,
                    "height": 480,
                    "model": model,
                    "point": p,
                    "x": np.nan if missing else x,
                    "y": np.nan if missing else y,
                    "conf": np.nan if missing else conf,
                }
            )
    return out


def test_missing_rate_counts_required_points_only():
    frames = range(10)
    # left ear missing on 2 frames, nose missing on 5 frames
    drop = lambda f, p: (p == "left_ear" and f < 2) or (p == "nose" and f < 5)
    w = wide(pd.DataFrame(rows("m", frames, drop=drop)), {"m": 0.5})
    r = missing_rate(w).iloc[0]
    assert r["Q1_missing"] == pytest.approx(0.2)
    assert r["nose_missing"] == pytest.approx(0.5)


def test_low_confidence_counts_as_missing():
    w = wide(pd.DataFrame(rows("m", range(4), conf=0.4)), {"m": 0.5})
    assert missing_rate(w).iloc[0]["Q1_missing"] == 1.0


def test_jitter_is_normalised_by_shoulder_width():
    df = pd.DataFrame(rows("still", range(50)) + rows("shaky", range(50), noise=4.0, seed=1))
    w = wide(df, {"still": 0.5, "shaky": 0.5})
    out = jitter(w, [{"start_ms": 0, "end_ms": 5000, "label": "static"}]).set_index("model")
    assert out.loc["still", "Q2_jitter"] == pytest.approx(0.0, abs=1e-9)
    # noise 4 px / shoulder width 200 px ~= 0.02 (each point is independent, width also jitters)
    assert 0.012 < out.loc["shaky", "Q2_jitter"] < 0.03
    assert out.loc["shaky", "Q2_h"] > out.loc["still", "Q2_h"]


def test_jitter_ignores_non_static_segments():
    w = wide(pd.DataFrame(rows("m", range(50), noise=4.0)), {"m": 0.5})
    out = jitter(w, [{"start_ms": 0, "end_ms": 5000, "label": "moving"}])
    assert np.isnan(out.iloc[0]["Q2_jitter"])


def test_agreement_nme_and_pck():
    frames = range(10)
    df = pd.DataFrame(
        rows("sapiens", frames)
        + rows("close", frames, offset=(10.0, 0.0))  # 10/200 = 0.05 -> inside PCK@0.1
        + rows("far", frames, offset=(0.0, 30.0))  # 30/200 = 0.15 -> outside
    )
    w = wide(df, {"sapiens": 0.3, "close": 0.3, "far": 0.3})
    out = agreement(w, "sapiens").set_index("model")
    assert out.loc["close", "A1_nme"] == pytest.approx(0.05)
    assert out.loc["close", "A2_pck"] == 1.0
    assert out.loc["far", "A1_nme"] == pytest.approx(0.15)
    assert out.loc["far", "A2_pck"] == 0.0
    assert out.loc["close", "ref_frames"] == 10


def test_agreement_uses_only_frames_the_reference_has():
    df = pd.DataFrame(rows("sapiens", range(0, 10, 5)) + rows("m", range(10)))
    out = agreement(wide(df, {"sapiens": 0.3, "m": 0.3}), "sapiens")
    assert out.iloc[0]["ref_frames"] == 2


def test_load_keeps_latest_rerun(tmp_path):
    path = tmp_path / "points.csv"
    first = pd.DataFrame(rows("m", range(3), conf=0.1))
    second = pd.DataFrame(rows("m", range(3), conf=0.9))
    pd.concat([first, second]).to_csv(path, index=False)
    df = load(path)
    assert len(df) == 3 * len(POINTS)
    assert (df["conf"] == 0.9).all()


def test_report_and_markdown_have_one_row_per_model():
    df = pd.DataFrame(rows("sapiens", range(20)) + rows("m", range(20), offset=(4, 0)))
    out = report(df, [{"start_ms": 0, "end_ms": 2000}], "sapiens", {"sapiens": 0.3, "m": 0.3})
    text = markdown(out, "sapiens")
    assert text.count("\n") == 3  # header, separator, 2 models
    assert "| sapiens |" in text and "기준" in text


def test_sapiens_json_picks_best_person_and_drops_offframe():
    kps = [[0, 0]] * 17
    good = [list(p) for p in kps]
    for name, i in import_sapiens.COCO_INDEX.items():
        good[i] = list(BASE[name])
    good[6] = [900, 320]  # right shoulder outside a 640 px wide frame
    data = {
        "instance_info": [
            {"keypoints": kps, "keypoint_scores": [0.1] * 17},
            {"keypoints": good, "keypoint_scores": [0.9] * 17},
        ]
    }
    pts = import_sapiens.points_from_json(json.loads(json.dumps(data)), import_sapiens.parse_index(None), 640, 480)
    assert pts["nose"].x == 320 and pts["nose"].conf == pytest.approx(0.9)
    assert "right_shoulder" not in pts


def test_sapiens_index_override_needs_five_values():
    assert import_sapiens.parse_index("0,3,4,5,6")["right_shoulder"] == 6
    with pytest.raises(SystemExit):
        import_sapiens.parse_index("0,3,4")
