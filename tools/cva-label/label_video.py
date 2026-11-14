"""Side-view video → per-frame CVA labels (CSV) and per-segment summary.

Usage (WSL, repository root, `.venv-pose` from tools/pose-compare):
  python tools/cva-label/label_video.py .data/cva/p01_side.mp4
  python tools/cva-label/label_video.py .data/cva/p01_side.mp4 --mediapipe-task frontend/public/mediapipe/pose_landmarker_lite.task
  python tools/cva-label/label_video.py .data/cva/p01_side.mp4 --segments .data/cva/p01_segments.json
  python tools/cva-label/label_video.py .data/cva/p01_side.mp4 --check 0

Outputs stay in the local, git-ignored `.data/cva/` folder. Nothing is uploaded.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import asdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "pose-compare"))

from cva import (
    DEFAULT_C7_HSV,
    DEFAULT_TRAGUS_HSV,
    HsvRange,
    approx_cva,
    cva_deg,
    find_sticker,
    summarize_segments,
)

FIELDS = (
    "frame",
    "timestamp_ms",
    "sticker_cva",
    "tragus_x",
    "tragus_y",
    "c7_x",
    "c7_y",
    "approx_cva",
    "approx_side",
)


def fmt(value: float | None) -> str:
    return "" if value is None else f"{value:.3f}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="측면 영상에서 CVA 라벨 만들기 (스티커 + MediaPipe 근사)")
    ap.add_argument("video")
    ap.add_argument("--out", help="CSV 경로 (기본: .data/cva/<영상이름>_cva.csv)")
    ap.add_argument("--stride", type=int, default=3, help="N프레임마다 한 번 계산 (기본 3)")
    ap.add_argument("--tragus-hsv", default=None, help="귀구슬 스티커 HSV 범위 h1,s1,v1,h2,s2,v2 (기본 초록)")
    ap.add_argument("--c7-hsv", default=None, help="C7 스티커 HSV 범위 (기본 파랑)")
    ap.add_argument("--min-area", type=int, default=30, help="스티커로 인정할 최소 픽셀 수")
    ap.add_argument("--mediapipe-task", help="주면 귀–어깨 근사 CVA도 함께 계산")
    ap.add_argument("--min-conf", type=float, default=0.5, help="근사 CVA에 쓸 점 최소 신뢰도")
    ap.add_argument("--segments", help="자세 구간 JSON [{start_ms,end_ms,label}] → 구간별 요약")
    ap.add_argument("--threshold", type=float, default=50.0, help="참고 기준 각도 (기본 50°)")
    ap.add_argument("--check", type=int, default=None, help="이 프레임에 찾은 점·선을 그린 확인 이미지만 저장")
    args = ap.parse_args(argv)

    import cv2

    video = Path(args.video)
    out_dir = Path(".data/cva")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = Path(args.out) if args.out else out_dir / f"{video.stem}_cva.csv"
    tragus_hsv = HsvRange.parse(args.tragus_hsv) if args.tragus_hsv else DEFAULT_TRAGUS_HSV
    c7_hsv = HsvRange.parse(args.c7_hsv) if args.c7_hsv else DEFAULT_C7_HSV

    runner = None
    if args.mediapipe_task:
        from extract import MediaPipeRunner  # tools/pose-compare

        runner = MediaPipeRunner(args.mediapipe_task)

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise SystemExit(f"영상을 열 수 없어요: {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    rows: list[dict] = []
    index = -1
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            index += 1
            if args.check is not None and index != args.check:
                continue
            if args.check is None and index % max(1, args.stride):
                continue
            ts = index * 1000.0 / fps
            tragus = find_sticker(bgr, tragus_hsv, args.min_area)
            c7 = find_sticker(bgr, c7_hsv, args.min_area)
            sticker = cva_deg(tragus, c7) if tragus and c7 and (tragus.x, tragus.y) != (c7.x, c7.y) else None
            approx = approx_cva(runner(bgr, ts), args.min_conf) if runner else None
            if args.check is not None:
                draw = bgr.copy()
                for point, color in ((tragus, (0, 255, 0)), (c7, (255, 0, 0))):
                    if point:
                        cv2.circle(draw, (int(point.x), int(point.y)), 8, color, 2)
                if tragus and c7:
                    cv2.line(draw, (int(c7.x), int(c7.y)), (int(tragus.x), int(tragus.y)), (0, 255, 255), 2)
                text = f"sticker {fmt(sticker) or '-'} / approx {fmt(approx[0]) if approx else '-'}"
                cv2.putText(draw, text, (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)
                path = out_dir / f"{video.stem}_check_{index:06d}.jpg"
                cv2.imwrite(str(path), draw)
                print(f"확인 이미지 저장 → {path} ({text})")
                return 0
            rows.append(
                {
                    "frame": index,
                    "timestamp_ms": f"{ts:.1f}",
                    "sticker_cva": fmt(sticker),
                    "tragus_x": fmt(tragus.x if tragus else None),
                    "tragus_y": fmt(tragus.y if tragus else None),
                    "c7_x": fmt(c7.x if c7 else None),
                    "c7_y": fmt(c7.y if c7 else None),
                    "approx_cva": fmt(approx[0] if approx else None),
                    "approx_side": approx[1] if approx else "",
                }
            )
    finally:
        cap.release()
        if runner:
            runner.close()

    if args.check is not None:
        raise SystemExit(f"{args.check}번 프레임이 영상에 없어요")
    with out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    sticker_ok = sum(1 for r in rows if r["sticker_cva"])
    print(f"{len(rows)}프레임 저장 → {out} (스티커 인식 {sticker_ok}/{len(rows)})")

    if args.segments:
        segments = json.loads(Path(args.segments).read_text(encoding="utf-8"))
        summary = summarize_segments(rows, segments, args.threshold)
        summary_path = out.with_name(out.stem + "_segments.csv")
        with summary_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(asdict(summary[0]).keys()) if summary else ["label"])
            writer.writeheader()
            for item in summary:
                writer.writerow(asdict(item))
        for item in summary:
            med = "-" if item.sticker_median is None else f"{item.sticker_median:.1f}°"
            print(f"  {item.label}: 스티커 CVA 중앙값 {med} ({item.sticker_valid}/{item.frames}프레임)")
        print(f"구간 요약 → {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
