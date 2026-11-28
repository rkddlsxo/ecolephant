"""Tests for tune_thresholds.py on synthetic windows (no videos)."""

import judge
import tune_thresholds as tt


def win(start_s, r=0.0, h=0.0, n=0.0, ok=True):
    return judge.WindowResult(
        start_s * 1000.0,
        15,
        1.0,
        ok,
        "" if ok else "low_confidence",
        r,
        h,
        n,
        "normal",
        "",
    )


def session(sid, chin_r, drop_h, upright_r=0.005, upright_h=0.0):
    """Baseline 0-10 s, chin 10-20, upright 20-30, head down 30-40, upright 40-50."""
    segs = [
        judge.Segment("upright", 0, 10),
        judge.Segment("chin_forward", 10, 20),
        judge.Segment("upright", 20, 30),
        judge.Segment("head_down", 30, 40),
        judge.Segment("upright", 40, 50),
    ]
    ws = []
    for k in range(50):
        if 10 <= k < 20:
            ws.append(win(k, r=chin_r))
        elif 30 <= k < 40:
            ws.append(win(k, h=drop_h, n=drop_h * 0.5))
        else:
            ws.append(win(k, r=upright_r, h=upright_h))
    return tt.Session(sid, tt.person_of(sid), segs, ws)


def test_person_groups_sessions():
    assert tt.person_of("P05_s2") == "P05"
    assert tt.person_of("P03") == "P03"


def test_relevel_uses_candidate_thresholds_and_nose():
    t = tt.thresholds_for(0.03, -0.05)
    assert tt.relevel(win(0, r=0.031), t).level == "caution"
    assert tt.relevel(win(0, h=-0.06), t).level == "caution"
    assert tt.relevel(win(0, n=-0.11), t).level == "high"  # nose high = 2 x drop
    assert tt.relevel(win(0, r=0.02, h=-0.04), t).level == "normal"
    assert tt.relevel(win(0, ok=False), t).ok is False


def test_score_counts_segments_and_upright_windows():
    s = session("P01_s1", chin_r=0.04, drop_h=-0.08)
    t = tt.thresholds_for(0.03, -0.05)
    sc = tt.score_people([s], lambda w: tt.relevel(w, t))
    assert (sc.detected, sc.risk, sc.upright_fp, sc.upright) == (2, 2, 0, 2)
    assert sc.upright_windows == 20 and sc.window_fp == 0.0


def test_choose_prefers_recall_then_conservative():
    people = [
        session("P01_s1", 0.04, -0.08),
        session("P02_s1", 0.025, -0.06),
        session("P03_s1", 0.10, -0.15),
    ]
    c = tt.choose(tt.grid(people), max_window_fp=0.10, tie=0.0)
    f, d, sc = c
    assert sc.recall == 1.0
    assert (
        f == 0.025
    )  # the largest forward threshold that still catches P02's chin (0.025)
    assert (
        d == -0.06
    )  # the drop threshold closest to the current policy that catches -0.06


def test_choose_rejects_candidates_with_upright_false_positives():
    noisy = session("P01_s1", 0.04, -0.08, upright_r=0.03)  # upright sits at +0.03
    c = tt.choose(tt.grid([noisy]), max_window_fp=0.10, tie=0.0)
    assert c[0] > 0.03  # forward threshold must stay above the upright level


def test_logistic_separates_risk_from_upright():
    people = [session("P01_s1", 0.04, -0.08), session("P03_s1", 0.10, -0.15)]
    model, cutoff = tt.fit_logistic(people, max_window_fp=0.10)
    assert model.prob([0.10, 0.0, 0.0]) > model.prob([0.005, 0.0, 0.0])
    sc = tt.score_people(people, lambda w: tt.logistic_level(w, model, cutoff))
    assert sc.upright_fp == 0 and sc.recall == 1.0
