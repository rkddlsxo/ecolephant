import type { PostureType } from './types';

/**
 * Posture-type stretching recommendation (team-agreed set of three, 2026-11-10).
 *
 * Pure rules, no network or storage: the caller passes the current posture type and a short
 * history kept by the app. Not a medical prescription; every result carries the stop-on-pain
 * caution. Hold times are draft values (DEC-007) and should be reviewed with the team.
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

/** Which stretches suit each posture type (team agreement, 2026-11-10). */
export const stretchesForType: Record<PostureType, readonly StretchId[]> = {
  chin_forward: ['chin_tuck'],
  head_down: ['neck_back_stretch'],
  combined: ['chin_tuck', 'chest_opener'],
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
  /** How often each posture type was detected recently (e.g. today's windows). */
  postureCounts?: Partial<Record<PostureType, number>>;
}

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

function mostFrequent(counts: Partial<Record<PostureType, number>> | undefined) {
  let best: PostureType | null = null;
  let bestCount = 0;
  for (const type of ['combined', 'chin_forward', 'head_down'] as const) {
    const count = counts?.[type] ?? 0;
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Picks one stretch.
 * 1. Posture type: the current one, otherwise the most frequent in the history.
 * 2. Among that type's stretches, avoid repeating the one done last.
 * 3. If the last attempt of the chosen stretch was not finished, shorten the hold.
 * Returns null when there is no posture to correct.
 */
export function recommendStretch(
  current: PostureType | null,
  history: StretchHistory = { attempts: [] },
): StretchRecommendation | null {
  const type = current ?? mostFrequent(history.postureCounts);
  if (!type) return null;
  const reason: StretchReason = current ? 'current_posture' : 'most_frequent_posture';
  const candidates = stretchesForType[type];
  const last = history.attempts.at(-1)?.id;
  const id = candidates.find((candidate) => candidate !== last) ?? candidates[0];
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
  return {
    stretch,
    holdSeconds,
    reason,
    eased,
    tip: type === 'head_down' || type === 'combined' ? screenTip : null,
    caution: stretchCaution,
  };
}
