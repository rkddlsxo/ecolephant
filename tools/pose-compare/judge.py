"""Python port of the service's webcam judgement, for offline evaluation of recorded videos.

Mirrors (keep in sync when those change):
  - frontend/src/features/measurement/pose/pose-result.ts   quality: no_pose / low_confidence / motion / valid
  - ai/src/camera-features.ts                               features r, h, n
  - ai/src/calibration.ts                                   3 s stable-segment baseline
  - ai/src/camera-window.ts                                 1 s window summary and level / posture type
Thresholds come from the policy JSON (ai/src/policy.json, the app's current policy).

Pure functions only: no video, model or network access. Landmarks are normalized 0..1 in the
original frame and never leave this machine (AGENTS.md).
"""

from __future__ import annotations

import json
import math
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

POINT_NAMES = ("nose", "left_ear", "right_ear", "left_shoulder", "right_shoulder")
LEVEL_RANK = {"normal": 0, "caution": 1, "high": 2}
RISK_LABELS = ("chin_forward", "head_down", "combined")
LABEL_ALIASES = {"turn_talk": "turn"}
KNOWN_LABELS = (
    "upright",
    "chin_forward",
    "head_down",
    "combined",
    "trunk_lean",
    "turn",
)
# ai/src/posture-display.ts (2026-11-28): the type shown to the user. A stored "combined" (and an
# instructed "combined" segment) is head down, because the front camera cannot tell them apart.
DISPLAY_TYPE = {
    "chin_forward": "chin_forward",
    "head_down": "head_down",
    "combined": "head_down",
}


# ---------------------------------------------------------------- options (same draft values)


@dataclass
class QualityOptions:  # pose-result.ts draftQualityOptions
    min_confidence: float = 0.7
    motion_limit: float = 0.15
    motion_baseline_ms: float = 250
    motion_max_gap_ms: float = 500


@dataclass
class FeatureOptions:  # camera-features.ts defaultFeatureOptions
    min_confidence: float = 0.7
    min_shoulder_fraction: float = 0.05


@dataclass
class CalibrationOptions:  # calibration.ts draftCalibrationOptions
    stable_duration_ms: float = 3000
    max_gap_ms: float = 500
    r_tolerance: float = 0.08
    h_tolerance: float = 0.06
    min_samples: int = 10


@dataclass
class WindowOptions:  # camera-window.ts defaultCameraWindowOptions
    min_coverage: float = 0.8
    min_frames: int = 3


@dataclass
class Thresholds:
    forward: tuple[float, float]  # (caution, high), rChange >= value
    drop: tuple[float, float]  # (caution, high), hChange <= value
    nose_drop: tuple[float, float]  # (caution, high), nChange <= value
    policy_id: str = ""


def load_policy(
    path: Path,
) -> tuple[Thresholds, QualityOptions, FeatureOptions, CalibrationOptions, WindowOptions]:
    policy = json.loads(Path(path).read_text(encoding="utf-8"))
    t = policy["camera_change_thresholds"]
    thresholds = Thresholds(
        forward=(t["forward"]["caution"], t["forward"]["high"]),
        drop=(t["drop"]["caution"], t["drop"]["high"]),
        nose_drop=(t["nose_drop"]["caution"], t["nose_drop"]["high"]),
        policy_id=policy.get("policy_id", ""),
    )
    conf = policy["calibration"]["landmark_confidence_min"]
    quality = QualityOptions(
        min_confidence=conf, motion_max_gap_ms=policy["quality"]["max_sample_age_ms"]
    )
    features = FeatureOptions(min_confidence=conf)
    calibration = CalibrationOptions(
        stable_duration_ms=policy["calibration"]["stable_duration_ms"],
        max_gap_ms=policy["quality"]["max_sample_age_ms"],
    )
    window = WindowOptions(min_coverage=policy["quality"]["min_valid_coverage"])
    return thresholds, quality, features, calibration, window


# ---------------------------------------------------------------- per-frame quality and features


@dataclass
class Landmark:
    x: float
    y: float
    confidence: float


@dataclass
class Frame:
    t_ms: float
    width: int
    height: int
    landmarks: dict[str, Landmark | None] | None  # None = no pose detected


def to_landmark(
    x: float | None, y: float | None, visibility: float | None, presence: float | None
) -> Landmark | None:
    """pose-result.ts toPoint: off-frame points are missing; confidence = min(visibility, presence)."""
    if x is None or y is None or not (math.isfinite(x) and math.isfinite(y)):
        return None
    if x < 0 or x > 1 or y < 0 or y > 1:
        return None
    vis = visibility if visibility is not None and math.isfinite(visibility) else 0.0
    pres = presence if presence is not None and math.isfinite(presence) else 1.0
    return Landmark(x, y, min(1.0, max(0.0, min(vis, pres))))


def _confident(p: Landmark | None, minimum: float) -> bool:
    return p is not None and p.confidence >= minimum


@dataclass
class MotionSample:
    t_ms: float
    head: tuple[float, float]
    shoulder: tuple[float, float]
    shoulder_width: float


def motion_sample(frame: Frame, q: QualityOptions) -> MotionSample | None:
    lm = frame.landmarks or {}
    ls, rs = lm.get("left_shoulder"), lm.get("right_shoulder")
    if not _confident(ls, q.min_confidence) or not _confident(rs, q.min_confidence):
        return None
    head = [
        p
        for p in (lm.get("nose"), lm.get("left_ear"), lm.get("right_ear"))
        if _confident(p, q.min_confidence)
    ]
    if not head:
        return None
    w, h = frame.width, frame.height
    a, b = (ls.x * w, ls.y * h), (rs.x * w, rs.y * h)
    width = math.hypot(a[0] - b[0], a[1] - b[1])
    if not width > 0:
        return None
    hx = sum(p.x * w for p in head) / len(head)
    hy = sum(p.y * h for p in head) / len(head)
    return MotionSample(frame.t_ms, (hx, hy), ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), width)


def is_moving(current: MotionSample, history: list[MotionSample], q: QualityOptions) -> bool:
    reference = None
    for s in history:
        age = current.t_ms - s.t_ms
        if q.motion_baseline_ms <= age <= q.motion_max_gap_ms and (
            reference is None or s.t_ms > reference.t_ms
        ):
            reference = s
    if reference is None:
        return False
    scale = (current.shoulder_width + reference.shoulder_width) / 2

    def shift(p, r):
        return math.hypot(p[0] - r[0], p[1] - r[1]) / scale

    width_change = abs(current.shoulder_width - reference.shoulder_width) / scale
    return (
        max(
            shift(current.head, reference.head),
            shift(current.shoulder, reference.shoulder),
            width_change,
        )
        > q.motion_limit
    )


def frame_qualities(frames: list[Frame], q: QualityOptions) -> list[str]:
    """pose-result.ts toCameraModelResult over a sequence (history resets on no_pose/low_confidence)."""
    out: list[str] = []
    history: list[MotionSample] = []
    for f in frames:
        history = [s for s in history if s.t_ms < f.t_ms and f.t_ms - s.t_ms <= q.motion_max_gap_ms]
        if not f.landmarks:
            out.append("no_pose")
            history = []
            continue
        sample = motion_sample(f, q)
        if sample is None:
            out.append("low_confidence")
            history = []
            continue
        out.append("motion" if is_moving(sample, history, q) else "valid")
        history = history + [sample]
    return out


@dataclass
class Features:
    t_ms: float
    r: float
    h: float
    n: float | None


def camera_features(frame: Frame, quality: str, o: FeatureOptions) -> Features | str:
    """camera-features.ts cameraFeatures. Returns Features or a failure reason string."""
    if quality in ("no_pose", "low_confidence", "motion"):
        return quality
    lm = frame.landmarks or {}
    le, re_, ls, rs, nose = (
        lm.get(k) for k in ("left_ear", "right_ear", "left_shoulder", "right_shoulder", "nose")
    )
    if not all(_confident(p, o.min_confidence) for p in (le, re_, ls, rs)):
        return "missing_points"
    w, hgt = frame.width, frame.height
    if not (w > 0 and hgt > 0):
        return "degenerate"

    def px(p):
        return (p.x * w, p.y * hgt)

    lep, rep, lsp, rsp = px(le), px(re_), px(ls), px(rs)
    face = math.hypot(lep[0] - rep[0], lep[1] - rep[1])
    shoulder = math.hypot(lsp[0] - rsp[0], lsp[1] - rsp[1])
    if shoulder < o.min_shoulder_fraction * math.hypot(w, hgt) or not face > 0:
        return "degenerate"
    mid_ear_y = (lep[1] + rep[1]) / 2
    mid_shoulder_y = (lsp[1] + rsp[1]) / 2
    n = (mid_ear_y - px(nose)[1]) / shoulder if _confident(nose, o.min_confidence) else None
    return Features(frame.t_ms, face / shoulder, (mid_shoulder_y - mid_ear_y) / shoulder, n)


# ---------------------------------------------------------------- calibration


def median(values: list[float]) -> float:
    s = sorted(values)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


@dataclass
class Baseline:
    r0: float
    h0: float
    n0: float | None
    samples: int
    start_ms: float
    end_ms: float


def _nose_baseline(samples: list[Features]) -> float | None:
    values = [s.n for s in samples if s.n is not None and math.isfinite(s.n)]
    return median(values) if len(values) * 2 >= len(samples) else None


def calibrate(results: list[Features | str], o: CalibrationOptions) -> Baseline | None:
    """calibration.ts advanceCalibration run until done. `results` in time order."""
    samples: list[Features] = []

    def stable(seg: list[Features]) -> bool:
        r = median([s.r for s in seg])
        h = median([s.h for s in seg])
        return all(abs(s.r / r - 1) <= o.r_tolerance and abs(s.h - h) <= o.h_tolerance for s in seg)

    for res in results:
        if isinstance(res, str):
            samples = []
            continue
        if samples and res.t_ms <= samples[-1].t_ms:
            samples = []
            continue
        if samples and res.t_ms - samples[-1].t_ms > o.max_gap_ms:
            samples = [res]
            continue
        candidate = samples + [res]
        if not stable(candidate):
            samples = [res]
            continue
        samples = candidate
        span = res.t_ms - samples[0].t_ms
        if span >= o.stable_duration_ms and len(samples) >= o.min_samples:
            return Baseline(
                r0=median([s.r for s in samples]),
                h0=median([s.h for s in samples]),
                n0=_nose_baseline(samples),
                samples=len(samples),
                start_ms=samples[0].t_ms,
                end_ms=res.t_ms,
            )
    return None


# ---------------------------------------------------------------- 1 s windows and judgement


@dataclass
class WindowResult:
    start_ms: float
    frames: int
    coverage: float
    ok: bool
    reason: str = ""  # no_sensor / low_confidence / motion when not ok
    r_change: float | None = None
    h_change: float | None = None
    n_change: float | None = None
    level: str = ""  # normal / caution / high when ok
    posture_type: str = ""  # chin_forward / head_down / combined / "" (normal)


def _window_failure(failures: list[str]) -> str:
    motion = sum(1 for f in failures if f == "motion")
    return "motion" if motion > 0 and motion * 2 >= len(failures) else "low_confidence"


def level_above(value: float, th: tuple[float, float]) -> str:
    return "high" if value >= th[1] else "caution" if value >= th[0] else "normal"


def level_below(value: float, th: tuple[float, float]) -> str:
    return "high" if value <= th[1] else "caution" if value <= th[0] else "normal"


def worst(a: str, b: str) -> str:
    return a if LEVEL_RANK[a] >= LEVEL_RANK[b] else b


def posture_type_of(forward: str, drop: str) -> str:
    f, d = forward != "normal", drop != "normal"
    return "combined" if f and d else "chin_forward" if f else "head_down" if d else ""


def summarize_window(
    start_ms: float,
    results: list[Features | str],
    baseline: Baseline,
    o: WindowOptions,
    t: Thresholds,
) -> WindowResult:
    """camera-window.ts summarizeCameraWindow + judgeCameraChange."""
    frames = len(results)
    if frames < o.min_frames:
        return WindowResult(start_ms, frames, 0.0, False, "no_sensor")
    usable = [r for r in results if not isinstance(r, str)]
    coverage = len(usable) / frames
    if coverage < o.min_coverage:
        return WindowResult(
            start_ms,
            frames,
            coverage,
            False,
            _window_failure([r for r in results if isinstance(r, str)]),
        )
    noses = [f.n for f in usable if f.n is not None and math.isfinite(f.n)]
    n_change = (
        median(noses) - baseline.n0
        if baseline.n0 is not None and len(noses) * 2 >= len(usable)
        else None
    )
    r_change = median([f.r / baseline.r0 - 1 for f in usable])
    h_change = median([f.h - baseline.h0 for f in usable])
    forward = level_above(r_change, t.forward)
    drop = worst(
        level_below(h_change, t.drop),
        "normal" if n_change is None else level_below(n_change, t.nose_drop),
    )
    return WindowResult(
        start_ms,
        frames,
        coverage,
        True,
        "",
        r_change,
        h_change,
        n_change,
        worst(forward, drop),
        posture_type_of(forward, drop),
    )


def judge_windows(
    results: list[Features | str],
    times_ms: list[float],
    baseline: Baseline,
    o: WindowOptions,
    t: Thresholds,
    end_ms: float,
) -> list[WindowResult]:
    """1 s windows [k*1000, (k+1)*1000) from the start of the video, like the controller's clock."""
    out = []
    k = 0
    i = 0
    n = len(results)
    while k * 1000 < end_ms:
        start, stop = k * 1000.0, (k + 1) * 1000.0
        bucket = []
        while i < n and times_ms[i] < stop:
            if times_ms[i] >= start:
                bucket.append(results[i])
            i += 1
        out.append(summarize_window(start, bucket, baseline, o, t))
        k += 1
    return out


# ---------------------------------------------------------------- segments and metrics


@dataclass
class Segment:
    label: str
    start_s: float
    end_s: float
    note: str = ""


def read_segments(path: Path) -> list[Segment]:
    import csv

    segments = []
    with Path(path).open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            label = (row.get("label") or "").strip()
            if not label:
                continue
            label = LABEL_ALIASES.get(label, label)
            if label not in KNOWN_LABELS:
                raise ValueError(
                    f"{path}: 알 수 없는 label '{label}' (가능: {', '.join(KNOWN_LABELS)})"
                )
            start, end = float(row["start"]), float(row["end"])
            if end <= start:
                raise ValueError(
                    f"{path}: {label} 구간의 end({end})가 start({start})보다 커야 합니다"
                )
            segments.append(Segment(label, start, end, (row.get("note") or "").strip()))
    if not segments or segments[0].label != "upright":
        raise ValueError(f"{path}: 첫 줄은 기준 자세 upright여야 합니다")
    return segments


@dataclass
class SegmentResult:
    label: str
    start_s: float
    end_s: float
    windows: int
    unknown_windows: int
    level: str  # normal / caution / high / unknown / too_short
    posture_type: str
    r_change: float | None
    h_change: float | None
    n_change: float | None
    is_baseline: bool = False
    level_counts: dict = field(default_factory=dict)
    display_type: str = ""  # shown type (DISPLAY_TYPE), most common among non-normal windows


def segment_windows(windows: list[WindowResult], seg: Segment) -> list[WindowResult]:
    """Windows that lie fully inside the hold segment (transitions are left out)."""
    return [
        w
        for w in windows
        if w.start_ms >= seg.start_s * 1000 and w.start_ms + 1000 <= seg.end_s * 1000
    ]


def aggregate_segment(
    seg: Segment,
    windows: list[WindowResult],
    is_baseline: bool = False,
    min_windows: int = 3,
) -> SegmentResult:
    """Segment level = most frequent window level (tie → worse).

    Fewer than `min_windows` full windows inside the hold → too_short (left out, counted).
    More than half of the windows unknown → unknown (left out of recall, counted).
    """
    inside = segment_windows(windows, seg)
    ok = [w for w in inside if w.ok]
    unknown = len(inside) - len(ok)
    counts = Counter(w.level for w in ok)
    if len(inside) < min_windows:
        level, ptype = "too_short", ""
    elif unknown * 2 > len(inside) or not ok:
        level, ptype = "unknown", ""
    else:
        top = max(counts.values())
        level = max((lv for lv, c in counts.items() if c == top), key=lambda lv: LEVEL_RANK[lv])
        types = Counter(w.posture_type for w in ok if w.level != "normal")
        ptype = "" if level == "normal" or not types else types.most_common(1)[0][0]
    shown = Counter(
        DISPLAY_TYPE.get(w.posture_type, w.posture_type)
        for w in ok
        if w.level != "normal" and w.posture_type
    )
    display = (
        ""
        if level in ("normal", "unknown", "too_short") or not shown
        else shown.most_common(1)[0][0]
    )

    def med(attr):
        vals = [getattr(w, attr) for w in ok if getattr(w, attr) is not None]
        return round(median(vals), 4) if vals else None

    return SegmentResult(
        seg.label,
        seg.start_s,
        seg.end_s,
        len(inside),
        unknown,
        level,
        ptype,
        med("r_change"),
        med("h_change"),
        med("n_change"),
        is_baseline,
        dict(counts),
        display,
    )


def metrics(segments: list[SegmentResult]) -> dict:
    """Pre-registered metrics (claude/에코끼리_검증실험_준비.md 2장), adapted to instructed labels only."""
    risk = [s for s in segments if s.label in RISK_LABELS]
    excluded = ("unknown", "too_short")
    risk_known = [s for s in risk if s.level not in excluded]
    detected = [s for s in risk_known if s.level in ("caution", "high")]
    upright = [s for s in segments if s.label == "upright" and not s.is_baseline]
    upright_known = [s for s in upright if s.level not in excluded]
    false_pos = [s for s in upright_known if s.level in ("caution", "high")]
    evaluated = [s for s in segments if not s.is_baseline and s.level != "too_short"]
    windows = sum(s.windows for s in evaluated)
    unknown_windows = sum(s.unknown_windows for s in evaluated)
    # Type match uses the shown type (2026-11-28): instructed "combined" is expected as head down.
    type_ok = [s for s in detected if s.display_type == DISPLAY_TYPE.get(s.label)]
    return {
        "risk_segments": len(risk),
        "risk_unknown": sum(1 for s in risk if s.level == "unknown"),
        "risk_too_short": sum(1 for s in risk if s.level == "too_short"),
        "risk_detected": len(detected),
        "recall": round(len(detected) / len(risk_known), 3) if risk_known else None,
        "upright_segments": len(upright),
        "upright_false_positive": len(false_pos),
        "false_positive_rate": round(len(false_pos) / len(upright_known), 3)
        if upright_known
        else None,
        "windows": windows,
        "unknown_windows": unknown_windows,
        "unknown_rate": round(unknown_windows / windows, 3) if windows else None,
        "type_match": len(type_ok),
        "type_match_rate": round(len(type_ok) / len(detected), 3) if detected else None,
    }
