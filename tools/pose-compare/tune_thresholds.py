"""Choose camera thresholds from recorded sessions, with leave-one-person-out (LOPO) checking.

python tools/pose-compare/tune_thresholds.py --data-dir .data/test-c [--check-dir .data/test-b]

Uses the same landmark caches and segment tables as evaluate_segments.py. Window features (rChange,
hChange, nChange) are computed once with the current policy's quality/calibration/window options;
only the thresholds (and the optional logistic score) change between candidates.

Selection rule (written before looking at the results, 11/21 proposal, approved 11/28):
  1. Keep only candidates with no false-positive upright segment and an upright *window*
     false-positive rate <= --max-window-fp (default 10 %) for every person.
  2. Among those, pick the highest segment recall over all risk segments.
  3. If several are within --tie (default 0.05) of the best recall, keep the most conservative one
     (largest forward threshold, then the most negative drop threshold).
  4. If the current policy passes step 1 and is within --tie of the best recall, keep the current
     policy (no change is the simpler choice).
LOPO: for each person, the rule picks thresholds from the other people only and is scored on the
held-out person. This estimates how the chosen numbers do on someone they were not tuned on.

Sessions of one person (P05_s1, P05_s2) are grouped by the part before "_s".
Nothing here changes the service: the output is a recommendation for a new policy ID.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass, replace
from pathlib import Path

import evaluate_segments as ev
import judge

FORWARD_GRID = (0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.06, 0.07)
DROP_GRID = (-0.03, -0.04, -0.05, -0.06, -0.07, -0.08, -0.10)
CURRENT = (0.07, -0.10)


@dataclass
class Session:
    sid: str
    person: str
    segments: list  # judge.Segment
    windows: list  # judge.WindowResult (features filled, levels from the base policy)


def person_of(sid: str) -> str:
    return sid.split("_s")[0]


def load_sessions(data_dir: Path, policy: Path, exclude: list[str]) -> list[Session]:
    out = []
    for video in sorted(p for p in data_dir.iterdir() if p.suffix in ev.VIDEO_EXT):
        sid = video.stem
        if sid in exclude or person_of(sid) in exclude:
            continue
        seg_path = data_dir / f"{sid}.csv"
        cache = data_dir / "cache" / f"{sid}.landmarks.csv"
        if not seg_path.exists() or not cache.exists():
            print(
                f"{sid}: 구간표나 관절점 캐시가 없어 건너뜀 (먼저 evaluate_segments.py 실행)"
            )
            continue
        segments = judge.read_segments(seg_path)
        res = ev.evaluate(ev.load_cache(cache), segments, policy)
        if "error" in res:
            print(f"{sid}: {res['error']} → 건너뜀")
            continue
        out.append(Session(sid, person_of(sid), segments, res["windows"]))
    return out


# ---------------------------------------------------------------- re-judging windows


def thresholds_for(forward: float, drop: float) -> judge.Thresholds:
    """High levels keep the current policy's ratio (0.12/0.07, -0.20/-0.10); the nose follows drop."""
    return judge.Thresholds(
        forward=(forward, round(forward * 12 / 7, 4)),
        drop=(drop, round(drop * 2, 4)),
        nose_drop=(drop, round(drop * 2, 4)),
        policy_id=f"candidate r{forward:+.3f} h{drop:+.3f}",
    )


def relevel(w: judge.WindowResult, t: judge.Thresholds) -> judge.WindowResult:
    if not w.ok:
        return w
    forward = judge.level_above(w.r_change, t.forward)
    drop = judge.level_below(w.h_change, t.drop)
    if w.n_change is not None:
        drop = judge.worst(drop, judge.level_below(w.n_change, t.nose_drop))
    return replace(
        w,
        level=judge.worst(forward, drop),
        posture_type=judge.posture_type_of(forward, drop),
    )


def logistic_level(
    w: judge.WindowResult, model: Logistic, cutoff: float
) -> judge.WindowResult:
    if not w.ok:
        return w
    p = model.prob(features(w))
    level = "high" if p >= max(cutoff, 0.8) else "caution" if p >= cutoff else "normal"
    return replace(w, level=level, posture_type="" if level == "normal" else "logistic")


# ---------------------------------------------------------------- scoring


@dataclass
class Score:
    risk: int = 0  # risk segments with a known level
    detected: int = 0
    unknown: int = 0
    upright: int = 0
    upright_fp: int = 0
    upright_windows: int = 0
    upright_fp_windows: int = 0
    worst_person_window_fp: float = 0.0

    def add(self, other: Score) -> None:
        for k in (
            "risk",
            "detected",
            "unknown",
            "upright",
            "upright_fp",
            "upright_windows",
            "upright_fp_windows",
        ):
            setattr(self, k, getattr(self, k) + getattr(other, k))
        self.worst_person_window_fp = max(self.worst_person_window_fp, other.window_fp)

    @property
    def recall(self) -> float:
        return self.detected / self.risk if self.risk else 0.0

    @property
    def window_fp(self) -> float:
        return (
            self.upright_fp_windows / self.upright_windows
            if self.upright_windows
            else 0.0
        )


def score_session(s: Session, windows: list[judge.WindowResult]) -> Score:
    sc = Score()
    for i, seg in enumerate(s.segments):
        r = judge.aggregate_segment(seg, windows, is_baseline=(i == 0))
        if seg.label in judge.RISK_LABELS:
            if r.level in ("unknown", "too_short"):
                sc.unknown += 1
            else:
                sc.risk += 1
                sc.detected += r.level in ("caution", "high")
        elif seg.label == "upright" and i != 0:
            if r.level not in ("unknown", "too_short"):
                sc.upright += 1
                sc.upright_fp += r.level in ("caution", "high")
            inside = [w for w in judge.segment_windows(windows, seg) if w.ok]
            sc.upright_windows += len(inside)
            sc.upright_fp_windows += sum(w.level != "normal" for w in inside)
    sc.worst_person_window_fp = sc.window_fp
    return sc


def score_people(sessions: list[Session], judge_fn) -> Score:
    """Per-person scores are summed; worst_person_window_fp keeps the worst person."""
    total = Score()
    for person in sorted({s.person for s in sessions}):
        p = Score()
        for s in (x for x in sessions if x.person == person):
            p.add(score_session(s, [judge_fn(w) for w in s.windows]))
        p.worst_person_window_fp = p.window_fp
        total.add(p)
    return total


def grid(sessions: list[Session]) -> list[tuple[float, float, Score]]:
    out = []
    for f in FORWARD_GRID:
        for d in DROP_GRID:
            t = thresholds_for(f, d)
            out.append((f, d, score_people(sessions, lambda w, t=t: relevel(w, t))))
    return out


def choose(results: list[tuple[float, float, Score]], max_window_fp: float, tie: float):
    ok = [
        r
        for r in results
        if r[2].upright_fp == 0 and r[2].worst_person_window_fp <= max_window_fp
    ]
    if not ok:
        return None
    best = max(r[2].recall for r in ok)
    near = [r for r in ok if r[2].recall >= best - tie - 1e-9]
    # Most conservative: largest forward threshold, then the strictest (most negative) drop.
    return max(near, key=lambda r: (r[0], -r[1]))


# ---------------------------------------------------------------- logistic score (numpy-free)


def features(w: judge.WindowResult) -> list[float]:
    return [w.r_change, w.h_change, w.n_change if w.n_change is not None else 0.0]


class Logistic:
    """Plain gradient-descent logistic regression on (Δr, Δh, Δn), class-balanced."""

    def __init__(self, steps: int = 3000, lr: float = 0.5, l2: float = 1e-3):
        self.steps, self.lr, self.l2 = steps, lr, l2

    def fit(self, xs: list[list[float]], ys: list[int]) -> Logistic:
        n, k = len(xs), len(xs[0])
        self.mu = [sum(x[j] for x in xs) / n for j in range(k)]
        self.sd = [
            math.sqrt(sum((x[j] - self.mu[j]) ** 2 for x in xs) / n) or 1.0
            for j in range(k)
        ]
        z = [[(x[j] - self.mu[j]) / self.sd[j] for j in range(k)] for x in xs]
        pos = sum(ys) or 1
        neg = (n - sum(ys)) or 1
        wt = [n / (2 * pos) if y else n / (2 * neg) for y in ys]
        self.w, self.b = [0.0] * k, 0.0
        for _ in range(self.steps):
            gw, gb = [0.0] * k, 0.0
            for zi, yi, wi in zip(z, ys, wt):
                e = (
                    self._sig(sum(a * b for a, b in zip(self.w, zi)) + self.b) - yi
                ) * wi
                gb += e
                for j in range(k):
                    gw[j] += e * zi[j]
            self.b -= self.lr * gb / n
            self.w = [
                wj - self.lr * (gj / n + self.l2 * wj) for wj, gj in zip(self.w, gw)
            ]
        return self

    @staticmethod
    def _sig(v: float) -> float:
        return 1 / (1 + math.exp(-max(min(v, 40), -40)))

    def prob(self, x: list[float]) -> float:
        z = [(x[j] - self.mu[j]) / self.sd[j] for j in range(len(x))]
        return self._sig(sum(a * b for a, b in zip(self.w, z)) + self.b)


def training_windows(sessions: list[Session]) -> tuple[list[list[float]], list[int]]:
    xs, ys = [], []
    for s in sessions:
        for seg in s.segments:
            if seg.label not in judge.RISK_LABELS and seg.label != "upright":
                continue
            for w in judge.segment_windows(s.windows, seg):
                if w.ok:
                    xs.append(features(w))
                    ys.append(int(seg.label in judge.RISK_LABELS))
    return xs, ys


def fit_logistic(
    sessions: list[Session], max_window_fp: float
) -> tuple[Logistic, float]:
    """Fit, then pick the lowest probability cutoff that keeps the training upright windows within
    the false-positive limit for every person (the same rule as for the thresholds)."""
    xs, ys = training_windows(sessions)
    model = Logistic().fit(xs, ys)
    for cutoff in [c / 100 for c in range(30, 96)]:
        sc = score_people(sessions, lambda w, k=cutoff: logistic_level(w, model, k))
        if sc.upright_fp == 0 and sc.worst_person_window_fp <= max_window_fp:
            return model, cutoff
    return model, 0.95


# ---------------------------------------------------------------- report


def fmt(sc: Score) -> str:
    return (
        f"재현율 {sc.detected}/{sc.risk} ({sc.recall:.0%})  판단불가 {sc.unknown}  "
        f"바른자세 오탐 {sc.upright_fp}/{sc.upright}  창 오탐 {sc.window_fp:.1%} "
        f"(가장 나쁜 사람 {sc.worst_person_window_fp:.1%})"
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--data-dir", type=Path, default=Path(".data/test-c"))
    ap.add_argument(
        "--check-dir",
        type=Path,
        help="score the chosen numbers on another set (not used to choose)",
    )
    ap.add_argument("--policy", type=Path, default=Path("ai/src/policy.json"))
    ap.add_argument(
        "--exclude", nargs="*", default=[], help="session or person IDs to leave out"
    )
    ap.add_argument("--max-window-fp", type=float, default=0.10)
    ap.add_argument("--tie", type=float, default=0.05)
    ap.add_argument("--top", type=int, default=12)
    args = ap.parse_args()

    sessions = load_sessions(args.data_dir, args.policy, args.exclude)
    people = sorted({s.person for s in sessions})
    if len(people) < 2:
        raise SystemExit("사람이 2명 이상이어야 사람 하나 빼기를 할 수 있습니다")
    print(
        f"세션 {len(sessions)}개: {', '.join(s.sid for s in sessions)} / 사람 {len(people)}명: {', '.join(people)}"
    )

    cur = thresholds_for(*CURRENT)
    print(
        f"\n[현재 v2] r {CURRENT[0]} / h {CURRENT[1]}\n  {fmt(score_people(sessions, lambda w: relevel(w, cur)))}"
    )

    results = grid(sessions)
    chosen = choose(results, args.max_window_fp, args.tie)
    ok_rows = sorted(
        (
            r
            for r in results
            if r[2].upright_fp == 0
            and r[2].worst_person_window_fp <= args.max_window_fp
        ),
        key=lambda r: (-r[2].recall, -r[0], r[1]),
    )
    print(
        f"\n[조건 통과 후보 상위 {args.top}] (바른 자세 구간 오탐 0, 사람별 창 오탐 ≤ {args.max_window_fp:.0%})"
    )
    for f, d, sc in ok_rows[: args.top]:
        mark = " ← 선택" if chosen and (f, d) == chosen[:2] else ""
        print(f"  r {f:<6} h {d:<6} {fmt(sc)}{mark}")
    if chosen is None:
        print("  조건을 통과한 후보가 없습니다")

    cur_sc = score_people(sessions, lambda w: relevel(w, cur))
    keep_current = (
        chosen is not None
        and cur_sc.upright_fp == 0
        and cur_sc.worst_person_window_fp <= args.max_window_fp
        and cur_sc.recall >= chosen[2].recall - args.tie - 1e-9
    )
    if chosen is not None:
        if keep_current:
            print(
                f"\n→ 추천: 현재 v2 유지 (가장 좋은 후보와 재현율 차이 {args.tie:.0%} 이내)"
            )
        else:
            print(f"\n→ 추천: r {chosen[0]} / h {chosen[1]} (새 정책 ID로)")

    print("\n[사람 하나 빼기] 나머지 사람으로 고른 수치 → 빠진 사람에게 적용")
    lopo_t, lopo_l = Score(), Score()
    rows = []
    for person in people:
        train = [s for s in sessions if s.person != person]
        test = [s for s in sessions if s.person == person]
        c = choose(grid(train), args.max_window_fp, args.tie)
        if c is None:
            print(f"  {person}: 나머지 사람으로 조건을 통과한 후보가 없음")
            continue
        t = thresholds_for(c[0], c[1])
        st = score_people(test, lambda w, t=t: relevel(w, t))
        model, cutoff = fit_logistic(train, args.max_window_fp)
        sl = score_people(test, lambda w, m=model, k=cutoff: logistic_level(w, m, k))
        lopo_t.add(st)
        lopo_l.add(sl)
        rows.append((person, c[0], c[1], st, cutoff, sl))
        print(f"  {person}: 기준값 r {c[0]} / h {c[1]} → {fmt(st)}")
        print(f"  {' ' * len(person)}  로지스틱(컷 {cutoff:.2f}) → {fmt(sl)}")
    print(f"\n  합계 기준값    : {fmt(lopo_t)}")
    print(f"  합계 로지스틱  : {fmt(lopo_l)}")

    summary = {
        "sessions": [s.sid for s in sessions],
        "rule": {"max_window_fp": args.max_window_fp, "tie": args.tie},
        "current": {"forward": CURRENT[0], "drop": CURRENT[1]},
        "keep_current": keep_current,
        "chosen_all": None
        if chosen is None
        else {"forward": chosen[0], "drop": chosen[1], "recall": chosen[2].recall},
        "lopo": [
            {
                "person": p,
                "forward": f,
                "drop": d,
                "recall": st.recall,
                "upright_fp": st.upright_fp,
                "window_fp": st.window_fp,
                "logistic_cutoff": k,
                "logistic_recall": sl.recall,
                "logistic_upright_fp": sl.upright_fp,
                "logistic_window_fp": sl.window_fp,
            }
            for p, f, d, st, k, sl in rows
        ],
        "lopo_total": {
            "threshold_recall": lopo_t.recall,
            "threshold_upright_fp": lopo_t.upright_fp,
            "logistic_recall": lopo_l.recall,
            "logistic_upright_fp": lopo_l.upright_fp,
        },
    }

    if args.check_dir and chosen is not None:
        check = load_sessions(args.check_dir, args.policy, args.exclude)
        if check:
            t = thresholds_for(chosen[0], chosen[1])
            print(
                f"\n[별도 확인 세트 {args.check_dir}] 고른 수치를 그대로 적용 (고르는 데 안 씀)"
            )
            print(f"  현재 v2  : {fmt(score_people(check, lambda w: relevel(w, cur)))}")
            sc = score_people(check, lambda w: relevel(w, t))
            print(f"  고른 수치: {fmt(sc)}")
            summary["check"] = {
                "dir": str(args.check_dir),
                "recall": sc.recall,
                "upright_fp": sc.upright_fp,
                "window_fp": sc.window_fp,
            }

    out = args.data_dir / "results" / "tune_thresholds.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n결과 저장: {out}")


if __name__ == "__main__":
    main()
