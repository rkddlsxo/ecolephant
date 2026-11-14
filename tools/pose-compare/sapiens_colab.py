"""Run Sapiens pose (0.3B torchscript) on dumped frames in Google Colab, without a person detector.

Why no detector: the official Sapiens lite demo needs an mmdet person detector, which is heavy to
install on Colab. Our comparison videos have one seated person, so a fixed crop around the body
centre is enough. Output JSON matches what `import_sapiens.py` reads.

Colab (Runtime -> T4 GPU), after uploading and unzipping frames.zip:
  !wget -q -O pose03b.pt2 "https://huggingface.co/facebook/sapiens-pose-0.3b-torchscript/resolve/main/sapiens_0.3b_goliath_best_goliath_AP_573_torchscript.pt2"
  !python sapiens_colab.py --frames frames --model pose03b.pt2 --cx 659 --width 1280 --height 720

`--cx`: body centre x in pixels (median shoulder midpoint from the MediaPipe CSV, see README).
Sapiens is CC BY-NC 4.0 (research only) and is the agreement reference, not ground truth.
Delete the uploaded frames from Colab when done (they show your face).
"""

from __future__ import annotations

import argparse
import glob
import json
import os

MEAN = (123.675, 116.28, 103.53)
STD = (58.395, 57.12, 57.375)
IN_H, IN_W = 1024, 768  # Sapiens pose input (H x W)
KEEP = (
    17  # Goliath-308 starts with the COCO-17 order (nose, eyes, ears, shoulders, ...)
)


def crop_x0(cx: int, width: int, height: int) -> tuple[int, int]:
    """Left edge and width of a 3:4 (W:H) crop covering the full frame height around cx."""
    cw = height * IN_W // IN_H
    return int(min(max(cx - cw // 2, 0), width - cw)), cw


def main() -> None:
    import cv2
    import torch

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--frames", default="frames")
    ap.add_argument("--model", default="pose03b.pt2")
    ap.add_argument("--out", default="sapiens_json")
    ap.add_argument("--cx", type=int, required=True, help="body centre x (pixels)")
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument(
        "--batch",
        type=int,
        default=8,
        help="lower to 2 if the runtime runs out of memory",
    )
    args = ap.parse_args()

    x0, cw = crop_x0(args.cx, args.width, args.height)
    model = (
        torch.jit.load(args.model).eval().cuda()
    )  # FutureWarning about torch.jit is harmless
    mean = torch.tensor(MEAN).view(1, 3, 1, 1).cuda()
    std = torch.tensor(STD).view(1, 3, 1, 1).cuda()
    os.makedirs(args.out, exist_ok=True)
    paths = sorted(glob.glob(os.path.join(args.frames, "*.jpg")))
    for i in range(0, len(paths), args.batch):
        batch = paths[i : i + args.batch]
        imgs = []
        for p in batch:
            crop = cv2.imread(p)[:, x0 : x0 + cw]
            rgb = cv2.cvtColor(cv2.resize(crop, (IN_W, IN_H)), cv2.COLOR_BGR2RGB)
            imgs.append(torch.from_numpy(rgb).permute(2, 0, 1))
        x = (torch.stack(imgs).float().cuda() - mean) / std
        with torch.no_grad():
            heat = model(x).float()[:, :KEEP]
        b, k, h, w = heat.shape
        score, idx = heat.reshape(b, k, -1).max(-1)  # heatmap peak; ~3 px steps at 720p
        ys, xs = (idx // w).float(), (idx % w).float()
        sx, sy = cw / w, args.height / h
        for j, p in enumerate(batch):
            kps = [
                [float(xs[j, n] * sx + x0 + sx / 2), float(ys[j, n] * sy + sy / 2)]
                for n in range(k)
            ]
            scores = [float(score[j, n]) for n in range(k)]
            name = os.path.basename(p).replace(".jpg", ".json")
            with open(os.path.join(args.out, name), "w") as f:
                json.dump(
                    {"instance_info": [{"keypoints": kps, "keypoint_scores": scores}]},
                    f,
                )
    print(f"완료 {len(paths)}장, 자르기 x0={x0} 폭={cw} → {args.out}/")


if __name__ == "__main__":
    main()
