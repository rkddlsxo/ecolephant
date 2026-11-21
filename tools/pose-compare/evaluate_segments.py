"""Offline webcam judgement on recorded test videos, scored against instructed posture segments.

Same rules as the browser service (judge.py mirrors the TypeScript code), applied to videos the
team recorded with the default laptop camera app. No side-view label: the instructed posture is
the reference, so this reports recall / false positives / unknown windows, not stage agreement.

Folder layout (git-ignored):
  .data/test-b/P01.mp4   (or .mov)   one video per person
  .data/test-b/P01.csv               segments: label,start,end[,note]  (seconds, first row upright)

Run from the repository root:
  python tools/pose-compare/evaluate_segments.py
  python tools/pose-compare/evaluate_segments.py --only P01 --refresh

Landmarks are cached in .data/test-b/cache/ so threshold experiments (--policy) re-run fast.
Results (derived values only, no landmarks) go to .data/test-b/results/.
Videos and landmarks stay on this machine (AGENTS.md).
"""

from __future__ import annotations

import argparse
import csv
import json
from dataclasses import asdict
from pathlib import Path

import judge

VIDEO_EXT = (".mp4", ".mov", ".MP4", ".MOV")


def extract_landmarks(video: Path, task: Path, analysis_fps: float) -> list[judge.Frame]:
    """MediaPipe Pose lite in VIDEO mode, sampled like the browser (≤ analysis_fps)."""
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    options = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(task)),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
    )
    landmarker = vision.PoseLandmarker.create_from_options(options)
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    interval = 1000.0 / analysis_fps
    frames: list[judge.Frame] = []
    index = 0
    last = -1e9
    last_model_ts = -1
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        t_ms = index * 1000.0 / fps
        index += 1
        if t_ms - last < interval - 0.5:
            continue
        last = t_ms
        h, w = bgr.shape[:2]
        image = mp.Image(
            image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        )
        model_ts = max(round(t_ms), last_model_ts + 1)
        last_model_ts = model_ts
        result = landmarker.detect_for_video(image, model_ts)
        if not result.pose_landmarks:
            frames.append(judge.Frame(t_ms, w, h, None))
            continue
        lms = result.pose_landmarks[0]
        idx = {"nose": 0, "left_ear": 7, "right_ear": 8, "left_shoulder": 11, "right_shoulder": 12}
        points = {
            name: judge.to_landmark(
                lms[i].x,
                lms[i].y,
                getattr(lms[i], "visibility", None),
                getattr(lms[i], "presence", None),
            )
            for name, i in idx.items()
        }
        frames.append(judge.Frame(t_ms, w, h, points))
    cap.release()
    landmarker.close()
    return frames


def save_cache(path: Path, frames: list[judge.Frame]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["t_ms", "width", "height", "detected"] + [
        f"{p}_{k}" for p in judge.POINT_NAMES for k in ("x", "y", "c")
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(fields)
        for fr in frames:
            row = [round(fr.t_ms, 1), fr.width, fr.height, int(fr.landmarks is not None)]
            for p in judge.POINT_NAMES:
                lm = (fr.landmarks or {}).get(p)
                row += (
                    ["", "", ""]
                    if lm is None
                    else [round(lm.x, 5), round(lm.y, 5), round(lm.confidence, 4)]
                )
            writer.writerow(row)


def load_cache(path: Path) -> list[judge.Frame]:
    frames = []
    with path.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row["detected"] == "0":
                frames.append(
                    judge.Frame(float(row["t_ms"]), int(row["width"]), int(row["height"]), None)
                )
                continue
            points = {}
            for p in judge.POINT_NAMES:
                x = row[f"{p}_x"]
                points[p] = (
                    None
                    if x == ""
                    else judge.Landmark(float(x), float(row[f"{p}_y"]), float(row[f"{p}_c"]))
                )
            frames.append(
                judge.Frame(float(row["t_ms"]), int(row["width"]), int(row["height"]), points)
            )
    return frames


def evaluate(frames: list[judge.Frame], segments: list[judge.Segment], policy: Path) -> dict:
    thresholds, q, fo, co, wo = judge.load_policy(policy)
    qualities = judge.frame_qualities(frames, q)
    results = [judge.camera_features(f, qual, fo) for f, qual in zip(frames, qualities)]
    times = [f.t_ms for f in frames]
    base_seg = segments[0]
    in_base = [
        r for r, t in zip(results, times) if base_seg.start_s * 1000 <= t <= base_seg.end_s * 1000
    ]
    baseline = judge.calibrate(in_base, co)
    quality_counts = {
        k: qualities.count(k) for k in ("valid", "motion", "low_confidence", "no_pose")
    }
    if baseline is None:
        return {
            "error": "기준 자세(첫 upright 구간)에서 흔들림 없는 3초를 찾지 못했습니다",
            "frames": len(frames),
            "quality": quality_counts,
        }
    end_ms = times[-1] + 1 if times else 0
    windows = judge.judge_windows(results, times, baseline, wo, thresholds, end_ms)
    seg_results = [
        judge.aggregate_segment(s, windows, is_baseline=(i == 0)) for i, s in enumerate(segments)
    ]
    return {
        "policy_id": thresholds.policy_id,
        "frames": len(frames),
        "quality": quality_counts,
        "baseline": asdict(baseline),
        "windows": windows,
        "segments": seg_results,
        "metrics": judge.metrics(seg_results),
    }


def fmt(v: float | None) -> str:
    return "" if v is None else f"{v:+.3f}"


def print_report(pid: str, res: dict) -> None:
    print(f"\n=== {pid} ===")
    if "error" in res:
        print(f"  ⚠ {res['error']} (분석 프레임 {res['frames']}, 품질 {res['quality']})")
        return
    b = res["baseline"]
    print(f"  분석 프레임 {res['frames']}개, 품질 {res['quality']}")
    print(
        f"  기준 자세: {b['start_ms'] / 1000:.1f}~{b['end_ms'] / 1000:.1f}초, r0={b['r0']:.3f} h0={b['h0']:.3f} n0={b['n0']}"
    )
    print(
        f"  {'label':<13}{'구간(초)':<12}{'창':>3}{'불가':>5}  {'판정':<10}{'유형':<13}{'rChange':>8}{'hChange':>8}{'nChange':>8}"
    )
    for s in res["segments"]:
        mark = " (기준)" if s.is_baseline else ""
        print(
            f"  {s.label:<13}{f'{s.start_s:g}~{s.end_s:g}':<12}{s.windows:>3}{s.unknown_windows:>5}  "
            f"{s.level + mark:<10}{s.posture_type:<13}{fmt(s.r_change):>8}{fmt(s.h_change):>8}{fmt(s.n_change):>8}"
        )
    m = res["metrics"]
    print(
        f"  재현율 {m['risk_detected']}/{m['risk_segments'] - m['risk_unknown'] - m['risk_too_short']} "
        f"(판단 불가 {m['risk_unknown']}, 짧음 {m['risk_too_short']}) | "
        f"바른 자세 오탐 {m['upright_false_positive']}/{m['upright_segments']} | "
        f"판단 불가 창 {m['unknown_windows']}/{m['windows']} | 유형 일치 {m['type_match']}/{m['risk_detected']}"
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--data-dir", type=Path, default=Path(".data/test-b"))
    ap.add_argument(
        "--task", type=Path, default=Path("frontend/public/mediapipe/pose_landmarker_lite.task")
    )
    ap.add_argument("--policy", type=Path, default=Path("ai/src/policy.json"))
    ap.add_argument(
        "--analysis-fps", type=float, default=15.0, help="browser analysis cap (camera-pipeline.ts)"
    )
    ap.add_argument("--only", nargs="*", help="e.g. P01 P03")
    ap.add_argument(
        "--refresh",
        action="store_true",
        help="re-run MediaPipe instead of using the landmark cache",
    )
    args = ap.parse_args()

    videos = sorted(p for p in args.data_dir.iterdir() if p.suffix in VIDEO_EXT)
    if args.only:
        videos = [v for v in videos if v.stem in args.only]
    if not videos:
        raise SystemExit(f"{args.data_dir}에 영상(.mp4/.mov)이 없습니다")
    out_dir = args.data_dir / "results"
    out_dir.mkdir(parents=True, exist_ok=True)

    all_segments: list[judge.SegmentResult] = []
    summary: dict = {"policy": str(args.policy), "people": {}}
    seg_rows, win_rows = [], []
    for video in videos:
        pid = video.stem
        seg_path = args.data_dir / f"{pid}.csv"
        if not seg_path.exists():
            print(f"\n=== {pid} === 구간표 {seg_path.name}이 없어 건너뜁니다")
            continue
        segments = judge.read_segments(seg_path)
        cache = args.data_dir / "cache" / f"{pid}.landmarks.csv"
        if args.refresh or not cache.exists():
            if not args.task.exists():
                raise SystemExit(f"모델 파일이 없습니다: {args.task} (npm run pose:assets)")
            print(f"{pid}: MediaPipe 실행 중 ({video.name}) ...", flush=True)
            save_cache(cache, extract_landmarks(video, args.task, args.analysis_fps))
        res = evaluate(load_cache(cache), segments, args.policy)
        print_report(pid, res)
        summary["people"][pid] = {k: v for k, v in res.items() if k not in ("windows", "segments")}
        if "error" in res:
            continue
        summary["policy_id"] = res["policy_id"]
        all_segments += res["segments"]
        for s in res["segments"]:
            row = asdict(s)
            row["level_counts"] = json.dumps(row["level_counts"], ensure_ascii=False)
            seg_rows.append({"person": pid, **row})
        for w in res["windows"]:
            win_rows.append({"person": pid, **asdict(w)})

    total = judge.metrics(all_segments)
    summary["total"] = total
    print("\n=== 전체 ===")
    print(json.dumps(total, ensure_ascii=False, indent=2))
    for name, rows in (("segments.csv", seg_rows), ("windows.csv", win_rows)):
        if rows:
            with (out_dir / name).open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                writer.writeheader()
                writer.writerows(rows)
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    print(f"\n결과 저장: {out_dir}/segments.csv, windows.csv, summary.json")


if __name__ == "__main__":
    main()
