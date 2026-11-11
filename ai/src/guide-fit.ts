import policy from './policy.json';
import type { CameraFrame, CameraPoint } from './camera-features';

/**
 * Person-shaped guide for the 3 s baseline calibration (team idea, 2026-11-11).
 *
 * The frontend may draw a head-and-shoulders silhouette over the camera preview from
 * `defaultGuide`; this function only checks whether the person sits inside it, so the
 * baseline is taken at a similar position and distance every time. Sitting at a steady
 * distance matters because the forward-shift signal is a face-to-shoulder size ratio.
 *
 * All values are fractions of the original (unmirrored) frame and are design proposals
 * (DEC-007), not validated limits. Nothing here leaves the device.
 */
export interface GuideShape {
  /** Horizontal centre of the shoulders, as a fraction of the frame width. */
  centerX: number;
  /** Allowed distance of the shoulder centre from `centerX`, fraction of the width. */
  centerTolerance: number;
  /** Shoulder width as a fraction of the frame width: below = too far, above = too close. */
  shoulderWidth: { min: number; max: number };
  /** Vertical range of the shoulder centre, fraction of the frame height (0 = top). */
  shoulderY: { min: number; max: number };
  /** Vertical range of the ear centre, fraction of the frame height. */
  earY: { min: number; max: number };
  /** Shoulder line tilt above this many degrees asks the person to sit level. */
  maxTiltDeg: number;
}

export const defaultGuide: GuideShape = {
  centerX: 0.5,
  centerTolerance: 0.12,
  // ~60 cm from a typical 70° laptop camera puts 40 cm shoulders near 0.45 of the width.
  shoulderWidth: { min: 0.3, max: 0.62 },
  shoulderY: { min: 0.55, max: 0.95 },
  earY: { min: 0.15, max: 0.6 },
  maxTiltDeg: 8,
};

/**
 * What to fix, in the person's own left/right (they face the camera, the preview is mirrored).
 * Ordered by priority: the first failing check is reported.
 */
export type GuideIssue =
  | 'no_person'
  | 'missing_points'
  | 'too_far'
  | 'too_close'
  | 'move_left'
  | 'move_right'
  | 'move_down'
  | 'move_up'
  | 'tilted';

export type GuideFit =
  | { fit: true; issue: null; shoulderWidth: number }
  | { fit: false; issue: GuideIssue; shoulderWidth: number | null };

export const guideLabel: Record<GuideIssue, string> = {
  no_person: '사람이 보이지 않아요. 가이드 안에 앉아 주세요.',
  missing_points: '양쪽 귀와 어깨가 가이드 안에 보이게 앉아 주세요.',
  too_far: '카메라와 조금 멀어요. 조금 앞으로 앉아 주세요.',
  too_close: '카메라와 너무 가까워요. 조금 뒤로 앉아 주세요.',
  move_left: '왼쪽으로 조금 옮겨 앉아 주세요.',
  move_right: '오른쪽으로 조금 옮겨 앉아 주세요.',
  move_down: '화면에 비해 너무 위에 있어요. 카메라를 조금 위로 향하게 하거나 낮게 앉아 주세요.',
  move_up: '화면에 비해 너무 아래에 있어요. 카메라를 조금 아래로 향하게 하거나 높게 앉아 주세요.',
  tilted: '어깨가 기울어 있어요. 어깨를 수평으로 편하게 내려 주세요.',
};

/** Posture tips shown before the baseline (the baseline is the person's own "good" posture). */
export const calibrationTips = [
  '등을 등받이에 붙이고 편하게 앉아 주세요.',
  '턱을 살짝 당기고 어깨 힘을 빼 주세요.',
  '화면 윗부분이 눈높이에 오도록 맞춰 주세요.',
] as const;

function usable(point: CameraPoint | null, min: number): point is CameraPoint {
  return (
    point !== null &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.confidence) &&
    point.confidence >= min
  );
}

export function guideFit(
  frame: CameraFrame,
  guide: GuideShape = defaultGuide,
  minConfidence: number = policy.calibration.landmark_confidence_min,
): GuideFit {
  const { leftEar, rightEar, leftShoulder, rightShoulder } = frame.landmarks;
  if (frame.quality === 'no_pose') return { fit: false, issue: 'no_person', shoulderWidth: null };
  if (
    !usable(leftEar, minConfidence) ||
    !usable(rightEar, minConfidence) ||
    !usable(leftShoulder, minConfidence) ||
    !usable(rightShoulder, minConfidence) ||
    !(frame.frameWidth > 0) ||
    !(frame.frameHeight > 0)
  )
    return { fit: false, issue: 'missing_points', shoulderWidth: null };

  const w = frame.frameWidth;
  const h = frame.frameHeight;
  const dx = (rightShoulder.x - leftShoulder.x) * w;
  const dy = (rightShoulder.y - leftShoulder.y) * h;
  const shoulderWidth = Math.hypot(dx, dy) / w;
  const fail = (issue: GuideIssue): GuideFit => ({ fit: false, issue, shoulderWidth });

  if (shoulderWidth < guide.shoulderWidth.min) return fail('too_far');
  if (shoulderWidth > guide.shoulderWidth.max) return fail('too_close');

  // Original frame: small x = the camera's left = the person's right side. A person drawn
  // left of centre in the original frame has to move toward their own left.
  const centerX = (leftShoulder.x + rightShoulder.x) / 2;
  if (centerX < guide.centerX - guide.centerTolerance) return fail('move_left');
  if (centerX > guide.centerX + guide.centerTolerance) return fail('move_right');

  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const earY = (leftEar.y + rightEar.y) / 2;
  if (shoulderY < guide.shoulderY.min || earY < guide.earY.min) return fail('move_down');
  if (shoulderY > guide.shoulderY.max || earY > guide.earY.max) return fail('move_up');

  const tilt = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  if (tilt > guide.maxTiltDeg) return fail('tilted');

  return { fit: true, issue: null, shoulderWidth };
}
