import type { PostureType } from './types';

/**
 * Posture type shown to the user (screen, alert wording, stretching), 2026-11-28 (수연).
 *
 * The stored `posture_type` keeps the judgement's three values (chin_forward / head_down /
 * combined) because the server re-checks it with the level and reason. What the user sees has two
 * types, read from that stored value:
 *
 * - `head_down` when the drop part reached caution (stored head_down or combined)
 * - `chin_forward` when only the forward part did
 *
 * Why: from the front camera, dropping the head also enlarges the face, so a large head drop
 * reaches the forward threshold too. In the validation videos (4 people, 5 sessions, 2026-11-23~28)
 * "head down a lot" and "chin forward + head down" gave the same front signals (e.g. r +0.147 with
 * h -0.090 vs -0.070), while chin forward alone kept h near 0 (-0.04~+0.02) and head down moved it
 * to -0.05~-0.35. So "drop reached → head down, otherwise chin forward" is the split the camera
 * can support; "combined" is not shown as its own type. The 2026-11-21 single "거북목 자세" label
 * (draft-web-v2 thresholds) is replaced by this rule with draft-web-v3.
 */
export type DisplayPostureType = 'chin_forward' | 'head_down';

export function displayPostureType(
  type: PostureType | null | undefined,
): DisplayPostureType | null {
  if (!type) return null;
  return type === 'chin_forward' ? 'chin_forward' : 'head_down';
}

export const displayPostureLabel: Record<DisplayPostureType, string> = {
  chin_forward: '고개 앞으로 쏠림',
  head_down: '고개 숙임',
};
