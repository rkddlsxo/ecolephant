import type { PostureType } from './types';

/**
 * Stretching recommendation for a detected turtle-neck posture.
 *
 * 2026-11-21 (수연): one common routine instead of a stretch per posture type. In the recorded
 * test videos (4 people) the type from the front camera matched the instructed posture in only
 * 3 of 11 detected segments: pushing the chin forward also lowers the ears, and dropping the
 * head also enlarges the face. The app therefore shows one "거북목 자세" and rotates through the
 * three agreed stretches (2026-11-10). The posture type is still passed in and recorded so the
 * old per-type rule can come back if a better signal appears.
 *
 * Pure rules, no network or storage. Not a medical prescription; every result carries the
 * stop-on-pain caution. Hold times are draft values (DEC-007).
 */
export type StretchId = 'chin_tuck' | 'neck_back_stretch' | 'chest_opener';

export interface Stretch {
  id: StretchId;
  name: string;
  /** Default hold per repetition, seconds. */
  holdSeconds: number;
  reps: number;
  steps: readonly string[];
}

export const stretches: Record<StretchId, Stretch> = {
  chin_tuck: {
    id: 'chin_tuck',
    name: '턱 당기기',
    holdSeconds: 5,
    reps: 5,
    steps: [
      '허리를 펴고 정면을 봐요.',
      '고개를 숙이지 않고 턱을 뒤로 밀어 이중턱을 만들어요.',
      '그대로 유지한 뒤 천천히 풀어요.',
    ],
  },
  neck_back_stretch: {
    id: 'neck_back_stretch',
    name: '목 뒤 늘이기',
    holdSeconds: 15,
    reps: 2,
    steps: [
      '양손을 뒤통수에 가볍게 대요.',
      '턱을 가슴 쪽으로 천천히 당겨 목 뒤가 늘어나는 느낌을 찾아요.',
      '손으로 세게 누르지 말고 그대로 유지해요.',
    ],
  },
  chest_opener: {
    id: 'chest_opener',
    name: '가슴 펴기',
    holdSeconds: 15,
    reps: 2,
    steps: [
      '양손을 등 뒤에서 깍지 껴요.',
      '어깨를 뒤로 모으며 가슴을 앞으로 내밀어요.',
      '숨을 편하게 쉬면서 유지해요.',
    ],
  },
};

/** The common routine, in order (2026-11-21). */
export const commonRoutine: readonly StretchId[] = [
  'chin_tuck',
  'neck_back_stretch',
  'chest_opener',
];

/**
 * Kept for callers of the per-type rule: every posture type now uses the common routine.
 * (2026-11-10 per-type set: chin_forward → chin_tuck, head_down → neck_back_stretch,
 * combined → chin_tuck + chest_opener.)
 */
export const stretchesForType: Record<PostureType, readonly StretchId[]> = {
  chin_forward: commonRoutine,
  head_down: commonRoutine,
  combined: commonRoutine,
};

export const stretchCaution = '통증이나 어지러움이 느껴지면 바로 멈추세요. 의료 처방이 아니에요.';

const screenTip = '화면을 눈높이까지 올리면 고개를 덜 숙이게 돼요.';

export interface StretchAttempt {
  id: StretchId;
  /** Finished every repetition with the full hold. */
  completed: boolean;
  /** Longest hold actually reached, seconds (when not completed). */
  heldSeconds?: number;
}

export interface StretchHistory {
  /** Most recent last. */
  attempts: readonly StretchAttempt[];
  /** How often each posture type was detected recently (e.g. today's windows). Any count > 0 means a stretch is due. */
  postureCounts?: Partial<Record<PostureType, number>>;
}

/** 'most_frequent_posture' keeps its old name: it now means "detected recently, not now". */
export type StretchReason = 'current_posture' | 'most_frequent_posture';

export interface StretchRecommendation {
  stretch: Stretch;
  holdSeconds: number;
  reason: StretchReason;
  /** Hold shortened because the last attempt of this stretch was not finished. */
  eased: boolean;
  tip: string | null;
  caution: string;
}

const MIN_HOLD_SECONDS = 3;

function detectedRecently(counts: Partial<Record<PostureType, number>> | undefined) {
  return Object.values(counts ?? {}).some((count) => (count ?? 0) > 0);
}

/**
 * Picks one stretch from the common routine.
 * 1. Needed when a turtle-neck posture is detected now, otherwise when one was detected recently.
 * 2. Goes through the routine in order and does not repeat the stretch done last.
 * 3. If the last attempt of the chosen stretch was not finished, shortens the hold.
 * Returns null when there is no posture to correct.
 */
export function recommendStretch(
  current: PostureType | null,
  history: StretchHistory = { attempts: [] },
): StretchRecommendation | null {
  if (!current && !detectedRecently(history.postureCounts)) return null;
  const reason: StretchReason = current ? 'current_posture' : 'most_frequent_posture';
  const last = history.attempts.at(-1)?.id;
  const lastIndex = last ? commonRoutine.indexOf(last) : -1;
  const id = commonRoutine[(lastIndex + 1) % commonRoutine.length];
  const stretch = stretches[id];
  const previous = [...history.attempts].reverse().find((attempt) => attempt.id === id);
  let holdSeconds = stretch.holdSeconds;
  let eased = false;
  if (previous && !previous.completed) {
    const reached = previous.heldSeconds ?? 0;
    holdSeconds = Math.max(
      MIN_HOLD_SECONDS,
      Math.min(stretch.holdSeconds - 1, Math.round(Math.max(reached, stretch.holdSeconds * 0.6))),
    );
    eased = true;
  }
  return { stretch, holdSeconds, reason, eased, tip: screenTip, caution: stretchCaution };
}
