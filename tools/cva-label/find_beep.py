"""녹화 도구의 맞춤 신호(1000Hz, 0.3초)를 측면 영상 소리에서 찾기.

python tools/cva-label/find_beep.py P03_s1 P05_s1   (.data/cva/<ID>_side.* 를 읽음, ffmpeg 필요)

보정 완료(880Hz)·유지 시작(900Hz)·준비(600Hz) 소리와 구분하려고 40ms 창으로 주파수를 좁게 보고,
1000Hz가 다른 소리보다 3배 이상 세고 0.2초 이상 이어지며, 1초 뒤 600Hz(첫 준비 소리)가 오는 것만 고른다."""

import glob
import subprocess
import sys

import numpy as np

SR, WIN, HOP = 16000, 640, 160  # 40ms 창, 10ms 간격 → 주파수 구분 약 25Hz


def tone_power(x, freqs):
    n = (len(x) - WIN) // HOP
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    frames = x[idx] * np.hanning(WIN)
    t = np.arange(WIN) / SR
    return {f: np.abs(frames @ np.exp(-2j * np.pi * f * t)) for f in freqs}


VIDEO_EXT = (".mp4", ".mov", ".webm", ".m4v")


def side_video(sid: str) -> str | None:
    """`<ID>_side.<영상 확장자>`만 고름. Windows 꼬리표(…:Zone.Identifier)나 손 라벨 영상(_side_label)은 제외."""
    for path in sorted(glob.glob(f".data/cva/{sid}_side.*")):
        if ":" not in path and path.lower().endswith(VIDEO_EXT):
            return path
    return None


def find(x):
    p = tone_power(x, [600, 880, 900, 1000, 1100])
    base = np.median(p[1000]) + 1e-9
    other = np.maximum.reduce([p[880], p[900], p[1100]])
    hit = (p[1000] > base * 20) & (p[1000] > other * 3)
    events, start = [], None
    for i, h in enumerate(np.append(hit, False)):
        if h and start is None:
            start = i
        elif not h and start is not None:
            events.append((start, i - start))
            start = None
    out = []
    for s, length in events:
        ms, dur = s * 10, length * 10
        j = s + 100  # 1초 뒤
        prep = (
            p[600][j : j + 10].max() > np.median(p[600]) * 20
            if j + 10 < len(p[600])
            else False
        )
        out.append((ms, dur, prep))
    return out


if __name__ == "__main__":
    for ID in sys.argv[1:]:
        src = side_video(ID)
        if src is None:
            print(f"{ID}: .data/cva/{ID}_side.(mp4|mov|webm) 영상이 없습니다")
            continue
        raw = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                src,
                "-t",
                "90",
                "-ac",
                "1",
                "-ar",
                str(SR),
                "-f",
                "s16le",
                "-",
            ],
            capture_output=True,
            check=True,
        ).stdout
        x = np.frombuffer(raw, np.int16).astype(float)
        ev = find(x)
        good = [e for e in ev if e[1] >= 200 and e[2]]
        print(f"{ID} ({src})")
        for ms, dur, prep in ev[:8]:
            print(
                f"   후보 {ms:6d} ms  길이 {dur:3d} ms  1초 뒤 600Hz {'있음' if prep else '없음'}"
            )
        print(
            "   → 맞춤 신호:",
            f"{good[0][0]} ms" if good else "못 찾음 (후보 목록을 보여 줘)",
        )
