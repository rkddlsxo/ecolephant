"""find_beep: 맞춤 신호(1000Hz)를 보정 완료(880Hz)·유지(900Hz) 소리와 구분하는지."""

import find_beep as fb
import numpy as np


def tone(x, t0, f, ms, amp):
    n = int(fb.SR * ms / 1000)
    i = int(fb.SR * t0)
    x[i : i + n] += amp * np.sin(2 * np.pi * f * np.arange(n) / fb.SR)


def test_picks_the_1000hz_sync_beep_not_the_calibration_or_hold_beeps():
    rng = np.random.default_rng(0)
    x = rng.normal(0, 50, fb.SR * 30)
    tone(x, 4.0, 880, 150, 3000)  # 기준 자세 저장 완료 (폰을 일찍 켜면 녹음됨)
    tone(x, 17.0, 1000, 300, 8000)  # 맞춤 신호
    tone(x, 18.0, 600, 80, 4000)  # 첫 준비 소리
    tone(x, 21.0, 900, 60, 3000)  # 유지 시작
    good = [e for e in fb.find(x) if e[1] >= 200 and e[2]]
    assert len(good) == 1
    assert abs(good[0][0] - 17000) <= 30


def test_side_video_skips_zone_identifier_and_label_videos(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    cva = tmp_path / ".data" / "cva"
    cva.mkdir(parents=True)
    for name in (
        "P01_s1_side.MOV:Zone.Identifier",
        "P01_s1_side.MOV",
        "P01_s1_side_label.mp4",
    ):
        (cva / name).write_bytes(b"")
    assert fb.side_video("P01_s1") == ".data/cva/P01_s1_side.MOV"
    assert fb.side_video("P09_s1") is None
