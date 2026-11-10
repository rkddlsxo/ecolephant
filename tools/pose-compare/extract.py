"""Run pose models on a recorded video and save the five service points per frame.

Usage (one model at a time, append into the same CSV):
  python tools/pose-compare/extract.py VIDEO --model mediapipe --mediapipe-task path/to/pose_landmarker_lite.task
  python tools/pose-compare/extract.py VIDEO --model movenet --movenet-tflite path/to/movenet_lightning.tflite
  python tools/pose-compare/extract.py VIDEO --model rtmpose
  python tools/pose-compare/extract.py VIDEO --model yolo11n
  python tools/pose-compare/extract.py VIDEO --dump-frames 5      # JPGs for the Sapiens run on Colab

Output defaults to .data/pose-compare/ (git-ignored). Keep videos and outputs on your own
machine: they contain your face and body points (AGENTS.md).
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import cv2
import numpy as np

from common import COCO_INDEX, MEDIAPIPE_INDEX, POINTS, Point, frame_rows, write_rows

RTMPOSE_T = (
    "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/"
    "rtmpose-t_simcc-body7_pt-body7_420e-256x192-026a1439_20230504.zip"
)
YOLOX_TINY = (
    "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/"
    "yolox_tiny_8xb8-300e_humanart-6f3252f9.zip"
)


def inside(x: float, y: float, w: int, h: int) -> bool:
    return 0 <= x < w and 0 <= y < h


class MediaPipeRunner:
    name = "mediapipe"

    def __init__(self, task_path: str):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        self.mp = mp
        options = vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=task_path),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=1,
        )
        self.landmarker = vision.PoseLandmarker.create_from_options(options)
        self.last_ts = -1

    def __call__(self, bgr: np.ndarray, ts_ms: float) -> dict[str, Point]:
        h, w = bgr.shape[:2]
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        ts = max(int(ts_ms), self.last_ts + 1)  # MediaPipe needs strictly increasing timestamps
        self.last_ts = ts
        result = self.landmarker.detect_for_video(image, ts)
        if not result.pose_landmarks:
            return {}
        lms = result.pose_landmarks[0]
        out = {}
        for name, idx in MEDIAPIPE_INDEX.items():
            lm = lms[idx]
            x, y = lm.x * w, lm.y * h
            if not inside(x, y, w, h):
                continue  # same rule as the browser adapter: off-frame points are missing
            conf = min(lm.visibility if lm.visibility is not None else 0.0, lm.presence if lm.presence is not None else 0.0)
            out[name] = Point(x, y, conf)
        return out

    def close(self):
        self.landmarker.close()


class MoveNetRunner:
    """MoveNet single-pose TFLite (Lightning 192 or Thunder 256). Output [1,1,17,3] = y, x, score."""

    name = "movenet"

    def __init__(self, tflite_path: str):
        Interpreter = None
        for mod in ("ai_edge_litert.interpreter", "tflite_runtime.interpreter"):
            try:
                Interpreter = __import__(mod, fromlist=["Interpreter"]).Interpreter
                break
            except ImportError:
                pass
        if Interpreter is None:
            import tensorflow as tf  # fallback

            Interpreter = tf.lite.Interpreter
        self.interp = Interpreter(model_path=tflite_path)
        self.interp.allocate_tensors()
        self.inp = self.interp.get_input_details()[0]
        self.out = self.interp.get_output_details()[0]
        self.size = int(self.inp["shape"][1])

    def __call__(self, bgr: np.ndarray, ts_ms: float) -> dict[str, Point]:
        h, w = bgr.shape[:2]
        side = max(h, w)
        pad = np.zeros((side, side, 3), dtype=np.uint8)  # letterbox to a square, top-left aligned
        pad[:h, :w] = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        tensor = cv2.resize(pad, (self.size, self.size))[None].astype(self.inp["dtype"])
        self.interp.set_tensor(self.inp["index"], tensor)
        self.interp.invoke()
        kps = self.interp.get_tensor(self.out["index"])[0, 0]
        out = {}
        for name, idx in COCO_INDEX.items():
            y, x, score = kps[idx]
            px, py = float(x) * side, float(y) * side
            if inside(px, py, w, h):
                out[name] = Point(px, py, float(score))
        return out

    def close(self):
        pass


def best_person(keypoints: np.ndarray, scores: np.ndarray) -> int | None:
    """Index of the person with the highest mean score over the five points."""
    if keypoints is None or len(keypoints) == 0:
        return None
    idx = list(COCO_INDEX.values())
    return int(np.argmax(scores[:, idx].mean(axis=1)))


class RTMPoseRunner:
    """RTMPose-t via rtmlib. Note: rtmlib uses a YOLOX-tiny person detector here; the browser
    plan uses RTMDet-nano. Record that difference in the comparison notes."""

    name = "rtmpose"

    def __init__(self, device: str = "cpu"):
        from rtmlib import Body

        self.body = Body(
            det=YOLOX_TINY,
            det_input_size=(416, 416),
            pose=RTMPOSE_T,
            pose_input_size=(192, 256),
            backend="onnxruntime",
            device=device,
        )

    def __call__(self, bgr: np.ndarray, ts_ms: float) -> dict[str, Point]:
        h, w = bgr.shape[:2]
        keypoints, scores = self.body(bgr)
        i = best_person(keypoints, scores)
        if i is None:
            return {}
        out = {}
        for name, idx in COCO_INDEX.items():
            x, y = keypoints[i, idx]
            if inside(float(x), float(y), w, h):
                out[name] = Point(float(x), float(y), float(scores[i, idx]))
        return out

    def close(self):
        pass


class YoloRunner:
    name = "yolo11n"

    def __init__(self, weights: str = "yolo11n-pose.pt", device: str = "cpu"):
        from ultralytics import YOLO

        self.model = YOLO(weights)
        self.device = device

    def __call__(self, bgr: np.ndarray, ts_ms: float) -> dict[str, Point]:
        h, w = bgr.shape[:2]
        result = self.model.predict(bgr, device=self.device, verbose=False)[0]
        if result.keypoints is None or len(result.keypoints) == 0:
            return {}
        xy = result.keypoints.xy.cpu().numpy()
        conf = result.keypoints.conf
        conf = np.ones(xy.shape[:2]) if conf is None else conf.cpu().numpy()
        i = best_person(xy, conf)
        out = {}
        for name, idx in COCO_INDEX.items():
            x, y = xy[i, idx]
            if (x, y) != (0, 0) and inside(float(x), float(y), w, h):  # YOLO reports missing points as (0, 0)
                out[name] = Point(float(x), float(y), float(conf[i, idx]))
        return out

    def close(self):
        pass


def make_runner(args):
    if args.model == "mediapipe":
        if not args.mediapipe_task:
            raise SystemExit("--mediapipe-task 경로가 필요합니다 (frontend/public/mediapipe/pose_landmarker_lite.task)")
        return MediaPipeRunner(args.mediapipe_task)
    if args.model == "movenet":
        if not args.movenet_tflite:
            raise SystemExit("--movenet-tflite 경로가 필요합니다 (MoveNet SinglePose Lightning TFLite)")
        return MoveNetRunner(args.movenet_tflite)
    if args.model == "rtmpose":
        return RTMPoseRunner(args.device)
    if args.model == "yolo11n":
        return YoloRunner(args.yolo_weights, args.device)
    raise SystemExit(f"알 수 없는 모델: {args.model}")


def dump_frames(video: Path, out_dir: Path, stride: int) -> int:
    cap = cv2.VideoCapture(str(video))
    out_dir.mkdir(parents=True, exist_ok=True)
    frame = count = 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if frame % stride == 0:
            cv2.imwrite(str(out_dir / f"frame_{frame:06d}.jpg"), bgr)
            count += 1
        frame += 1
    cap.release()
    return count


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--model", choices=["mediapipe", "movenet", "rtmpose", "yolo11n"])
    ap.add_argument("--out", type=Path, default=Path(".data/pose-compare/points.csv"))
    ap.add_argument("--stride", type=int, default=1, help="analyse every Nth frame (use the same stride for all models)")
    ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--mediapipe-task")
    ap.add_argument("--movenet-tflite")
    ap.add_argument("--yolo-weights", default="yolo11n-pose.pt")
    ap.add_argument("--dump-frames", type=int, metavar="STRIDE", help="only export JPG frames for the Sapiens run")
    args = ap.parse_args()

    if args.dump_frames:
        out_dir = args.out.parent / "frames"
        n = dump_frames(args.video, out_dir, args.dump_frames)
        print(f"프레임 {n}장 저장: {out_dir}")
        return
    if not args.model:
        raise SystemExit("--model 또는 --dump-frames 중 하나가 필요합니다")

    runner = make_runner(args)
    cap = cv2.VideoCapture(str(args.video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame = done = 0
    times: list[float] = []
    rows: list[dict] = []
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if frame % args.stride == 0:
            ts_ms = frame * 1000.0 / fps
            t0 = time.perf_counter()
            pts = runner(bgr, ts_ms)
            times.append((time.perf_counter() - t0) * 1000)
            h, w = bgr.shape[:2]
            rows += frame_rows(runner.name, frame, ts_ms, w, h, pts)
            done += 1
            if args.max_frames and done >= args.max_frames:
                break
        frame += 1
    cap.release()
    runner.close()
    write_rows(args.out, rows)
    if times:
        t = np.array(times[1:] or times)  # skip the first (warm-up) frame
        print(
            f"{runner.name}: {done}프레임 저장 → {args.out}\n"
            f"  Python 추론 시간 중앙값 {np.median(t):.1f}ms, p95 {np.percentile(t, 95):.1f}ms "
            f"(참고용. 기록 파일의 S1은 브라우저에서 잰 값)"
        )


if __name__ == "__main__":
    main()
