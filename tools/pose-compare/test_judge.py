"""Tests for the Python port of the webcam judgement (no models or videos needed).

python -m pytest tools/pose-compare -q
"""

from pathlib import Path

import evaluate_segments
import judge
import pytest

W, H = 1280, 720
# Pixel positions: shoulder width 400, face (ear-to-ear) width 100 → r = 0.25, h = 0.55, n = -0.05
BASE = {
    "nose": (640, 400),
    "left_ear": (690, 380),
    "right_ear": (590, 380),
    "left_shoulder": (840, 600),
    "right_shoulder": (440, 600),
}
REPO = Path(__file__).resolve().parents[2]
Q = judge.QualityOptions()
FO = judge.FeatureOptions()
CO = judge.CalibrationOptions()
WO = judge.WindowOptions()
TH = judge.Thresholds(forward=(0.07, 0.12), drop=(-0.10, -0.20), nose_drop=(-0.10, -0.20))


def frame(t_ms, face_scale=1.0, drop=0.0, shift=(0.0, 0.0), conf=0.95, missing=()):
    pts = {}
    cx = 640
    for name, (x, y) in BASE.items():
        if name in ("left_ear", "right_ear"):
            x = cx + (x - cx) * face_scale
        if name in ("nose", "left_ear", "right_ear"):
            y += drop
        x += shift[0]
        y += shift[1]
        pts[name] = None if name in missing else judge.Landmark(x / W, y / H, conf)
    return judge.Frame(t_ms, W, H, pts)


def run(frames):
    qualities = judge.frame_qualities(frames, Q)
    return qualities, [judge.camera_features(f, q, FO) for f, q in zip(frames, qualities)]


def test_to_landmark_rules():
    assert judge.to_landmark(1.2, 0.5, 0.9, 0.9) is None  # off frame
    assert judge.to_landmark(0.5, 0.5, 0.9, None).confidence == 0.9  # presence missing → 1
    assert judge.to_landmark(0.5, 0.5, None, 0.9).confidence == 0.0  # visibility missing → 0


def test_features_match_typescript_definition():
    f = judge.camera_features(frame(0), "valid", FO)
    assert f.r == pytest.approx(0.25)
    assert f.h == pytest.approx(0.55)
    assert f.n == pytest.approx(-0.05)
    assert judge.camera_features(frame(0, missing=("left_ear",)), "valid", FO) == "missing_points"
    assert judge.camera_features(frame(0, missing=("nose",)), "valid", FO).n is None


def test_quality_no_pose_low_confidence_motion_valid():
    frames = [
        judge.Frame(0, W, H, None),
        frame(100, missing=("left_shoulder",)),
        frame(200),
        frame(300),
        frame(500, shift=(120, 0)),  # 300 ms after a reference, shift 120/400 = 0.3 > 0.15
    ]
    q, _ = run(frames)
    assert q == ["no_pose", "low_confidence", "valid", "valid", "motion"]


def test_small_jitter_is_not_motion():
    q, _ = run([frame(t, shift=(t % 3, 0)) for t in range(0, 2000, 70)])
    assert set(q) == {"valid"}


def test_calibration_finds_three_stable_seconds_and_restarts_on_jump():
    frames = [frame(t) for t in range(0, 1500, 67)] + [frame(1550, face_scale=1.3)]
    frames += [frame(t, face_scale=1.3) for t in range(1600, 5000, 67)]
    _, results = run(frames)
    base = judge.calibrate(results, CO)
    assert base is not None
    assert base.r0 == pytest.approx(0.25 * 1.3)  # the first segment was cut by the jump
    assert base.end_ms - base.start_ms >= 3000


def test_calibration_fails_without_stable_segment():
    _, results = run([frame(t, face_scale=1.0 + (t // 500) * 0.2) for t in range(0, 4000, 67)])
    assert judge.calibrate(results, CO) is None


def baseline():
    return judge.Baseline(r0=0.25, h0=0.55, n0=-0.05, samples=45, start_ms=0, end_ms=3000)


def test_window_levels_and_types():
    def window(**kw):
        _, res = run([frame(t, **kw) for t in range(0, 1000, 67)])
        return judge.summarize_window(0, res, baseline(), WO, TH)

    assert window().level == "normal"
    fwd = window(face_scale=1.08)
    assert (fwd.level, fwd.posture_type) == ("caution", "chin_forward")
    assert window(face_scale=1.13).level == "high"
    down = window(drop=60)  # h: (600-440)/400 = 0.40 → -0.15
    assert (down.level, down.posture_type) == ("caution", "head_down")
    both = window(face_scale=1.08, drop=60)
    assert both.posture_type == "combined"


def test_window_failures_are_never_normal():
    _, two = run([frame(0), frame(100)])
    assert judge.summarize_window(0, two, baseline(), WO, TH).reason == "no_sensor"
    res = ["motion", "motion", "motion", judge.camera_features(frame(0), "valid", FO)]
    w = judge.summarize_window(0, res, baseline(), WO, TH)
    assert (w.ok, w.reason) == (False, "motion")
    w = judge.summarize_window(0, ["missing_points"] * 4, baseline(), WO, TH)
    assert (w.ok, w.reason) == (False, "low_confidence")


def test_nose_used_only_when_baseline_has_it():
    _, res = run(
        [frame(t, drop=30) for t in range(0, 1000, 67)]
    )  # h -0.075 (normal), n changes too
    no_nose = judge.Baseline(0.25, 0.55, None, 45, 0, 3000)
    assert judge.summarize_window(0, res, no_nose, WO, TH).n_change is None


def test_windows_follow_one_second_clock():
    frames = [frame(t) for t in range(0, 3000, 67)]
    _, res = run(frames)
    ws = judge.judge_windows(res, [f.t_ms for f in frames], baseline(), WO, TH, 3000)
    assert [w.start_ms for w in ws] == [0, 1000, 2000]
    assert all(w.ok for w in ws)


def test_read_segments(tmp_path):
    p = tmp_path / "P01.csv"
    p.write_text("﻿label,start,end\nupright,2,15\nturn_talk,18,27\n", encoding="utf-8")
    segs = judge.read_segments(p)
    assert [s.label for s in segs] == ["upright", "turn"]
    p.write_text("label,start,end\nchin_forward,2,15\n", encoding="utf-8")
    with pytest.raises(ValueError):
        judge.read_segments(p)
    p.write_text("label,start,end\nupright,2,15\nslouch,18,27\n", encoding="utf-8")
    with pytest.raises(ValueError):
        judge.read_segments(p)


def win(start_s, level, ok=True):
    return judge.WindowResult(
        start_s * 1000, 12, 1.0, ok, "" if ok else "motion", 0.1, 0.0, None, level if ok else ""
    )


def test_segment_majority_tie_unknown_and_short():
    seg = judge.Segment("chin_forward", 10, 16)
    tie = [
        win(10, "normal"),
        win(11, "normal"),
        win(12, "caution"),
        win(13, "caution"),
        win(14, "high"),
    ]
    assert judge.aggregate_segment(seg, tie).level == "caution"  # caution 2 vs normal 2 → worse
    unk = [
        win(10, "", False),
        win(11, "", False),
        win(12, "", False),
        win(13, "high"),
        win(14, "high"),
    ]
    assert judge.aggregate_segment(seg, unk).level == "unknown"
    short = judge.Segment("chin_forward", 10, 12.5)
    assert judge.aggregate_segment(short, tie).level == "too_short"
    # windows crossing the segment edges are left out
    assert (
        len(judge.segment_windows(tie, judge.Segment("x", 10.5, 15))) == 4
    )  # 11, 12, 13, 14 (10 crosses the start)


def test_metrics_exclude_baseline_and_unknown():
    def seg(label, level, base=False, ptype=""):
        return judge.SegmentResult(
            label, 0, 10, 8, 1 if level == "unknown" else 0, level, ptype, None, None, None, base
        )

    segs = [
        seg("upright", "normal", base=True),
        seg("chin_forward", "caution", ptype="chin_forward"),
        seg("head_down", "high", ptype="combined"),
        seg("combined", "unknown"),
        seg("upright", "caution"),
        seg("upright", "normal"),
    ]
    m = judge.metrics(segs)
    assert (m["risk_detected"], m["risk_unknown"], m["recall"]) == (2, 1, 1.0)
    assert (m["upright_segments"], m["upright_false_positive"], m["false_positive_rate"]) == (
        2,
        1,
        0.5,
    )
    assert m["type_match"] == 1
    assert m["windows"] == 40 and m["unknown_windows"] == 1


def test_policy_file_loads_current_thresholds():
    th, q, fo, co, wo = judge.load_policy(REPO / "ai/src/policy.json")
    assert th.forward[0] > 0 and th.drop[0] < 0
    assert q.min_confidence == fo.min_confidence == 0.7
    assert co.stable_duration_ms == 3000 and wo.min_coverage == 0.8


def test_end_to_end_on_synthetic_recording(tmp_path):
    frames = [frame(t) for t in range(0, 6000, 67)]  # upright 0-6 s
    frames += [frame(t, face_scale=1.10) for t in range(6000, 13000, 67)]  # chin forward
    frames += [frame(t, drop=60) for t in range(13000, 20000, 67)]  # head down
    frames += [frame(t) for t in range(20000, 27000, 67)]  # upright again
    segs = [
        judge.Segment("upright", 0, 6),
        judge.Segment("chin_forward", 7, 12),
        judge.Segment("head_down", 14, 19),
        judge.Segment("upright", 21, 26),
    ]
    policy = REPO / "ai/src/policy.json"
    res = evaluate_segments.evaluate(frames, segs, policy)
    levels = [(s.label, s.level, s.posture_type) for s in res["segments"]]
    assert levels[1][1:] in {("caution", "chin_forward"), ("high", "chin_forward")}
    assert levels[2][1:] == ("caution", "head_down")
    assert levels[3][1] == "normal"
    m = res["metrics"]
    assert m["recall"] == 1.0 and m["false_positive_rate"] == 0.0
    # cache round trip keeps the same result
    cache = tmp_path / "c.csv"
    evaluate_segments.save_cache(cache, frames)
    again = evaluate_segments.evaluate(evaluate_segments.load_cache(cache), segs, policy)
    assert [s.level for s in again["segments"]] == [s.level for s in res["segments"]]
