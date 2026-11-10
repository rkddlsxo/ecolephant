import { create } from 'zustand';
import type { DerivedWindow, Mode, Scenario } from '@ecolephant/ai';
import type { Session } from '../api/client';
/** camera: real webcam via the pose model. demo: synthetic signals for flow tests. */
export type MeasurementInput = 'camera' | 'demo';
export type Phase =
  'idle' | 'starting' | 'active' | 'paused' | 'recalibrating' | 'ending' | 'completed';
interface Measurement {
  phase: Phase;
  session: Session | null;
  mode: Mode;
  input: MeasurementInput;
  scenario: Scenario;
  camera: number;
  head: number;
  elapsedMs: number;
  /** 일시정지 구간 길이. 화면의 측정 시간은 elapsedMs - pausedMs */
  pausedMs: number;
  epoch: number;
  latest: DerivedWindow | null;
  recent: DerivedWindow[];
  pending: number;
  saved: number;
  saving: boolean;
  memoryFull: boolean;
  missingSession: boolean;
  error: string | null;
  alert: { key: number; stage: 1 | 2; elapsedMs: number } | null;
}
export const initialMeasurement: Measurement = {
  phase: 'idle',
  session: null,
  mode: 'combined',
  input: 'demo',
  scenario: 'auto',
  camera: 10,
  head: 8,
  elapsedMs: 0,
  pausedMs: 0,
  epoch: 1,
  latest: null,
  recent: [],
  pending: 0,
  saved: 0,
  saving: false,
  memoryFull: false,
  missingSession: false,
  error: null,
  alert: null,
};
export const useMeasurement = create<Measurement>(() => initialMeasurement);
