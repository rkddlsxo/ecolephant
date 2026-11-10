"""Convert Sapiens pose outputs (one JSON per frame, from the Colab run) into the comparison CSV.

Sapiens is the offline *agreement* reference, not ground truth (CC BY-NC 4.0, research only).

Expected JSON (Sapiens pose demo, `--save_json`):
  {"instance_info": [{"keypoints": [[x, y], ...], "keypoint_scores": [s, ...]}, ...]}
File names must contain the frame number written by `extract.py --dump-frames`
(frame_000123.json or frame_000123.jpg.json).

The keypoint layout differs by checkpoint (COCO-17 vs Goliath-308). The defaults below are the
COCO-ordered head/shoulder indices; Goliath also starts with the same order, but check it on the
first run with `--check FRAME_JPG` and pass `--index` if it is wrong.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np

from common import COCO_INDEX, POINTS, Point, frame_rows, write_rows

FRAME_RE = re.compile(r"frame_(\d+)")


def parse_index(text: str | None) -> dict[str, int]:
    if not text:
        return dict(COCO_INDEX)
    values = [int(v) for v in text.split(",")]
    if len(values) != len(POINTS):
        raise SystemExit(f"--index는 {len(POINTS)}개 값이 필요합니다: {','.join(POINTS)}")
    return dict(zip(POINTS, values))


def points_from_json(data: dict, index: dict[str, int], w: int | None, h: int | None) -> dict[str, Point]:
    people = data.get("instance_info") or []
    if not people:
        return {}
    idx = list(index.values())

    def score(person):
        s = np.asarray(person.get("keypoint_scores", []), dtype=float)
        return s[idx].mean() if len(s) > max(idx) else -1

    person = max(people, key=score)
    kps = np.asarray(person["keypoints"], dtype=float)
    scores = np.asarray(person.get("keypoint_scores", np.ones(len(kps))), dtype=float)
    out = {}
    for name, i in index.items():
        x, y = kps[i][:2]
        if w is not None and h is not None and not (0 <= x < w and 0 <= y < h):
            continue
        out[name] = Point(float(x), float(y), float(scores[i]))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("json_dir", type=Path)
    ap.add_argument("--fps", type=float, required=True, help="원본 영상 fps (timestamp 계산용)")
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--index", help="nose,left_ear,right_ear,left_shoulder,right_shoulder 순서의 인덱스")
    ap.add_argument("--out", type=Path, default=Path(".data/pose-compare/points.csv"))
    ap.add_argument("--check", type=Path, help="프레임 JPG 하나에 점을 그려 인덱스가 맞는지 확인")
    args = ap.parse_args()

    index = parse_index(args.index)
    files = sorted(args.json_dir.glob("*.json"))
    if not files:
        raise SystemExit(f"JSON이 없습니다: {args.json_dir}")

    if args.check:
        import cv2

        m = FRAME_RE.search(args.check.name)
        match = next((f for f in files if m and FRAME_RE.search(f.name) and FRAME_RE.search(f.name).group(1) == m.group(1)), None)
        if match is None:
            raise SystemExit("같은 프레임 번호의 JSON을 찾지 못했습니다")
        img = cv2.imread(str(args.check))
        pts = points_from_json(json.loads(match.read_text()), index, args.width, args.height)
        for name, p in pts.items():
            cv2.circle(img, (int(p.x), int(p.y)), 5, (0, 255, 0), -1)
            cv2.putText(img, name, (int(p.x) + 6, int(p.y)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
        out = args.out.parent / f"check_{args.check.stem}.jpg"
        out.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out), img)
        print(f"확인 이미지 저장: {out}  (점 이름이 실제 위치와 맞는지 눈으로 보세요)")
        return

    rows = []
    for f in files:
        m = FRAME_RE.search(f.name)
        if not m:
            continue
        frame = int(m.group(1))
        pts = points_from_json(json.loads(f.read_text()), index, args.width, args.height)
        rows += frame_rows("sapiens", frame, frame * 1000.0 / args.fps, args.width, args.height, pts)
    write_rows(args.out, rows)
    print(f"sapiens: {len(rows) // len(POINTS)}프레임 저장 → {args.out}")


if __name__ == "__main__":
    main()
