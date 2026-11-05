/**
 * AirPods head flexion normalization (docs/measurement/signal-pipeline.md, AirPods 특징 제안).
 *
 * `head_flexion_deg = max(0, degrees(sign * (pitch - baseline_pitch)))`
 *
 * Negative values (head tilted back from the baseline) become 0 here, so deriveWindow() keeps
 * treating anything outside 0..90 as an axis/unit/mapping error instead of silently clamping.
 * The axis and `sign` are unverified until DEC-003 measurements; callers must pass the sign
 * confirmed for the device rather than relying on the default.
 */
export type FlexionFailure = 'invalid_input' | 'out_of_range';
export type FlexionResult = { ok: true; deg: number } | { ok: false; reason: FlexionFailure };

/** Physically implausible flexion beyond the contract range is reported, not clamped to 90. */
const MAX_FLEXION_DEG = 90;

export function headFlexionDeg(
  pitchRad: number,
  baselinePitchRad: number,
  sign: 1 | -1 = 1,
): FlexionResult {
  if (!Number.isFinite(pitchRad) || !Number.isFinite(baselinePitchRad))
    return { ok: false, reason: 'invalid_input' };
  const deg = (sign * (pitchRad - baselinePitchRad) * 180) / Math.PI;
  // Small epsilon so radians→degrees rounding at exactly 90° stays valid.
  if (deg > MAX_FLEXION_DEG + 1e-9) return { ok: false, reason: 'out_of_range' };
  return { ok: true, deg: Math.min(MAX_FLEXION_DEG, Math.max(0, deg)) };
}
