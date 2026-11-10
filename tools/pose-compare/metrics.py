"""Compute Q1/Q2/A1/A2 from the comparison CSV and print rows for 에코끼리_모델비교기록.md.

  python tools/pose-compare/metrics.py .data/pose-compare/points.csv \
      --segments .data/pose-compare/segments.json --reference sapiens

Definitions (same as the comparison record, section 2):
  Q1  missing rate   share of analysed frames where any of the 4 required points
                     (both ears, both shoulders) is missing or below the model's threshold.
                     Nose missing is reported separately (n feature is optional).
  Q2  jitter         in "static" segments: std of each point's x and y divided by the median
                     shoulder width of that segment, averaged over points and segments.
                     Also the std of the service features r and h (Q2-r, Q2-h).
  A1  NME            mean distance to the reference point / reference shoulder width.
  A2  PCK@0.1        share of points within 0.1 x reference shoulder width.
A1/A2 against Sapiens are agreement with a stronger model, not accuracy.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from common import DEFAULT_THRESHOLDS, POINTS

REQUIRED = ("left_ear", "right_ear", "left_shoulder", "right_shoulder")


def load(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    # extract.py appends; a rerun of the same model keeps only its latest rows.
    df = df.drop_duplicates(subset=["model", "frame", "point"], keep="last")
    return df


def wide(df: pd.DataFrame, thresholds: dict[str, float]) -> pd.DataFrame:
    """One row per (model, frame); columns <point>_x, <point>_y, NaN when missing/below threshold."""
    df = df.copy()
    thr = df["model"].map(lambda m: thresholds.get(m, 0.0))
    bad = df["x"].isna() | df["y"].isna() | df["conf"].isna() | (df["conf"] < thr)
    df.loc[bad, ["x", "y"]] = np.nan
    out = df.pivot_table(index=["model", "frame"], columns="point", values=["x", "y"], aggfunc="last", dropna=False)
    out.columns = [f"{p}_{c}" for c, p in out.columns]
    for p in POINTS:
        for c in ("x", "y"):
            if f"{p}_{c}" not in out:
                out[f"{p}_{c}"] = np.nan
    ts = df.groupby(["model", "frame"])["timestamp_ms"].first()
    out["timestamp_ms"] = ts
    return out.reset_index()


def shoulder_width(w: pd.DataFrame) -> pd.Series:
    return np.hypot(w["left_shoulder_x"] - w["right_shoulder_x"], w["left_shoulder_y"] - w["right_shoulder_y"])


def features(w: pd.DataFrame) -> pd.DataFrame:
    sw = shoulder_width(w)
    face = np.hypot(w["left_ear_x"] - w["right_ear_x"], w["left_ear_y"] - w["right_ear_y"])
    mid_ear_y = (w["left_ear_y"] + w["right_ear_y"]) / 2
    mid_sh_y = (w["left_shoulder_y"] + w["right_shoulder_y"]) / 2
    return pd.DataFrame({"sw": sw, "r": face / sw, "h": (mid_sh_y - mid_ear_y) / sw})


def missing_rate(w: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for model, g in w.groupby("model"):
        req_missing = g[[f"{p}_x" for p in REQUIRED]].isna().any(axis=1)
        rows.append(
            {
                "model": model,
                "frames": len(g),
                "Q1_missing": float(req_missing.mean()),
                "nose_missing": float(g["nose_x"].isna().mean()),
            }
        )
    return pd.DataFrame(rows)


def jitter(w: pd.DataFrame, segments: list[dict]) -> pd.DataFrame:
    static = [s for s in segments if s.get("label", "static") == "static"]
    rows = []
    for model, g in w.groupby("model"):
        point_vals, r_vals, h_vals = [], [], []
        for s in static:
            seg = g[(g["timestamp_ms"] >= s["start_ms"]) & (g["timestamp_ms"] < s["end_ms"])]
            f = features(seg)
            sw = f["sw"].median()
            if seg.empty or not np.isfinite(sw) or sw <= 0:
                continue
            for p in POINTS:
                for c in ("x", "y"):
                    v = seg[f"{p}_{c}"].dropna()
                    if len(v) >= 3:
                        point_vals.append(v.std(ddof=0) / sw)
            for col, bucket in (("r", r_vals), ("h", h_vals)):
                v = f[col].replace([np.inf, -np.inf], np.nan).dropna()
                if len(v) >= 3:
                    bucket.append(v.std(ddof=0))
        rows.append(
            {
                "model": model,
                "Q2_jitter": float(np.mean(point_vals)) if point_vals else np.nan,
                "Q2_r": float(np.mean(r_vals)) if r_vals else np.nan,
                "Q2_h": float(np.mean(h_vals)) if h_vals else np.nan,
            }
        )
    return pd.DataFrame(rows)


def agreement(w: pd.DataFrame, reference: str, pck: float = 0.1) -> pd.DataFrame:
    ref = w[w["model"] == reference].set_index("frame")
    if ref.empty:
        return pd.DataFrame(columns=["model", "A1_nme", "A2_pck", "ref_frames"])
    ref_sw = shoulder_width(ref)
    rows = []
    for model, g in w[w["model"] != reference].groupby("model"):
        g = g.set_index("frame")
        common = g.index.intersection(ref.index)
        common = common[np.isfinite(ref_sw.loc[common]) & (ref_sw.loc[common] > 0)]
        dists = []
        for p in POINTS:
            dx = g.loc[common, f"{p}_x"] - ref.loc[common, f"{p}_x"]
            dy = g.loc[common, f"{p}_y"] - ref.loc[common, f"{p}_y"]
            d = (np.hypot(dx, dy) / ref_sw.loc[common]).dropna()
            dists.append(d.to_numpy())
        d = np.concatenate(dists) if dists else np.array([])
        rows.append(
            {
                "model": model,
                "A1_nme": float(d.mean()) if d.size else np.nan,
                "A2_pck": float((d < pck).mean()) if d.size else np.nan,
                "ref_frames": len(common),
            }
        )
    return pd.DataFrame(rows)


def report(df: pd.DataFrame, segments: list[dict], reference: str | None, thresholds: dict[str, float]) -> pd.DataFrame:
    w = wide(df, thresholds)
    out = missing_rate(w)
    out = out.merge(jitter(w, segments), on="model", how="left")
    if reference:
        out = out.merge(agreement(w, reference), on="model", how="left")
    out["threshold"] = out["model"].map(lambda m: thresholds.get(m, 0.0))
    return out


def fmt(v, pct=False, digits=3):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "-"
    return f"{v * 100:.1f}%" if pct else f"{v:.{digits}f}"


def markdown(out: pd.DataFrame, reference: str | None) -> str:
    head = "| 모델 | 임계값 | 프레임 | Q1 누락률 | 코 누락 | Q2 흔들림 | Q2-r | Q2-h |"
    sep = "|---|---|---|---|---|---|---|---|"
    if reference:
        head += f" A1 NME(vs {reference}) | A2 PCK@0.1 |"
        sep += "---|---|"
    lines = [head, sep]
    for _, r in out.iterrows():
        line = (
            f"| {r['model']} | {r['threshold']} | {int(r['frames'])} | {fmt(r['Q1_missing'], True)} | "
            f"{fmt(r['nose_missing'], True)} | {fmt(r.get('Q2_jitter'), digits=4)} | "
            f"{fmt(r.get('Q2_r'), digits=4)} | {fmt(r.get('Q2_h'), digits=4)} |"
        )
        if reference:
            if r["model"] == reference:
                line += " 기준 | 기준 |"
            else:
                line += f" {fmt(r.get('A1_nme'))} | {fmt(r.get('A2_pck'), True)} |"
        lines.append(line)
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", type=Path)
    ap.add_argument("--segments", type=Path, help='[{"start_ms":0,"end_ms":10000,"label":"static"}, ...]')
    ap.add_argument("--reference", help="A1/A2 기준 모델 이름 (예: sapiens)")
    ap.add_argument("--threshold", action="append", default=[], metavar="MODEL=VALUE")
    ap.add_argument("--out", type=Path, default=Path(".data/pose-compare/metrics.csv"))
    args = ap.parse_args()

    thresholds = dict(DEFAULT_THRESHOLDS)
    for item in args.threshold:
        k, v = item.split("=")
        thresholds[k] = float(v)
    segments = json.loads(args.segments.read_text()) if args.segments else []

    out = report(load(args.csv), segments, args.reference, thresholds)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.out, index=False)
    print(markdown(out, args.reference))
    print(f"\nCSV 저장: {args.out}")
    if not segments:
        print("참고: --segments가 없어 Q2(흔들림)는 계산하지 않았습니다.")


if __name__ == "__main__":
    main()
