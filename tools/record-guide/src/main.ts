/**
 * Local recording tool for the validation videos (not a service page; never deployed).
 *
 * Same pieces as the service calibration screen: MediaPipe adapter (frontend), guideFit and
 * 3 s calibration (ai). The baseline must pass inside the guide before recording can start.
 * Everything stays in this browser; files are downloaded to this computer only.
 */
import {
  advanceCalibration,
  cameraFeatures,
  defaultGuide,
  guideFit,
  guideLabel,
  initialCalibration,
  policy,
  type CalibrationState,
  type CameraFrame,
  type GuideFit,
} from '@ecolephant/ai';
import { createMediaPipeAdapter } from '../../../frontend/src/features/measurement/pose/mediapipe-adapter';
import {
  cvaSegmentsJson,
  defaultScript,
  evaluateSegmentsCsv,
  fileStem,
  guideCsv,
  guideSummary,
  landmarksCsv,
  phaseAt,
  planSchedule,
  type LoggedFrame,
  type Plan,
} from './script';

const ANALYSIS_INTERVAL_MS = 1000 / 15; // camera-pipeline.ts

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const canvas = $<HTMLCanvasElement>('overlay');
const ctx = canvas.getContext('2d')!;
const statusEl = $('status');
const promptEl = $('prompt');
const timerEl = $('timer');
const progressEl = $<HTMLProgressElement>('calib');
const flashEl = $('flash');
const participantEl = $<HTMLInputElement>('participant');
const sessionEl = $<HTMLInputElement>('session');
const speakEl = $<HTMLInputElement>('speak');
const cameraBtn = $<HTMLButtonElement>('camera');
const calibBtn = $<HTMLButtonElement>('calibrate');
const recordBtn = $<HTMLButtonElement>('record');
const stopBtn = $<HTMLButtonElement>('stop');
const againBtn = $<HTMLButtonElement>('again');
const summaryEl = $('summary');
const noticeEl = $('notice');
const nextStepEl = $('nextstep');
const calibLabelEl = $('caliblabel');

type Mode = 'off' | 'preview' | 'calibrating' | 'ready' | 'countdown' | 'recording' | 'saved';
let mode: Mode = 'off';
let stream: MediaStream | null = null;
const adapter = createMediaPipeAdapter();
let calibration: CalibrationState = initialCalibration();
let baseline: { r0: number; h0: number; n0: number | null } | null = null;
let lastFrame: CameraFrame | null = null;
let lastGuide: GuideFit | null = null;
let loopTimer: number | null = null;

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let mimeType = '';
let t0 = 0;
let plan: Plan = planSchedule(defaultScript);
let logged: LoggedFrame[] = [];
let syncDone = false;
let lastPhaseKey = '';
let files: { name: string; blob: Blob }[] = [];

// ---------- sound and speech ----------
let audio: AudioContext | null = null;
function beep(freq: number, ms: number, gain = 0.4) {
  if (!audio) return;
  const osc = audio.createOscillator();
  const g = audio.createGain();
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + ms / 1000);
}
function say(text: string) {
  if (!speakEl.checked || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  speechSynthesis.speak(u);
}

// ---------- UI helpers ----------
const NEXT_STEP: Record<Mode, string> = {
  off: '다음: 참가자 ID·회차를 넣고 카메라 켜기',
  preview: '다음: 가이드 안에 앉아서 기준 자세 잡기 (녹화 시작은 기준 자세 저장 후에 눌려요)',
  calibrating: '바른 자세로 3초 가만히…',
  ready: '다음: 측면 폰 녹화를 켜고 녹화 시작',
  countdown: '곧 녹화가 시작돼요',
  recording: '녹화 중 — 지시를 따라 주세요',
  saved: '저장 완료 — 다음 녹화를 하려면 다음 녹화',
};

function setMode(next: Mode) {
  mode = next;
  cameraBtn.disabled = next !== 'off';
  calibBtn.disabled = !(next === 'preview' || next === 'ready');
  recordBtn.disabled = next !== 'ready';
  stopBtn.disabled = !(next === 'recording' || next === 'countdown');
  againBtn.disabled = next !== 'saved';
  participantEl.disabled = sessionEl.disabled = next === 'recording' || next === 'countdown';
  nextStepEl.textContent = NEXT_STEP[next];
}

/** Stays until the next button press, unlike the per-frame status line. */
function notice(text: string) {
  noticeEl.textContent = text;
  noticeEl.hidden = !text;
}

function status(text: string, tone: 'ok' | 'warn' | 'info' = 'info') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

// ---------- drawing ----------
function drawOverlay() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, w, h);
  // The preview is mirrored; draw in mirrored coordinates (x → 1 - x) to match.
  const X = (x: number) => (1 - x) * w;
  const Y = (y: number) => y * h;
  const g = defaultGuide;
  const fit = lastGuide?.fit ?? false;
  ctx.lineWidth = 3;
  ctx.strokeStyle = fit ? 'rgba(46, 204, 113, 0.9)' : 'rgba(255, 170, 0, 0.9)';
  ctx.setLineDash([10, 8]);
  // Head: ellipse spanning the allowed ear band.
  const headCy = Y((g.earY.min + g.earY.max) / 2);
  const headRy = (Y(g.earY.max) - Y(g.earY.min)) / 2;
  const shoulderMid = (g.shoulderWidth.min + g.shoulderWidth.max) / 2;
  ctx.beginPath();
  ctx.ellipse(X(g.centerX), headCy, shoulderMid * w * 0.32, headRy * 0.9, 0, 0, Math.PI * 2);
  ctx.stroke();
  // Shoulders: arc at the middle of the allowed shoulder band.
  const sy = Y((g.shoulderY.min + g.shoulderY.max) / 2);
  const half = (shoulderMid * w) / 2;
  ctx.beginPath();
  ctx.moveTo(X(g.centerX) - half, h);
  ctx.lineTo(X(g.centerX) - half, sy + 30);
  ctx.quadraticCurveTo(X(g.centerX) - half, sy, X(g.centerX) - half * 0.4, sy - 10);
  ctx.lineTo(X(g.centerX) + half * 0.4, sy - 10);
  ctx.quadraticCurveTo(X(g.centerX) + half, sy, X(g.centerX) + half, sy + 30);
  ctx.lineTo(X(g.centerX) + half, h);
  ctx.stroke();
  ctx.setLineDash([]);
  // Detected points.
  const lm = lastFrame?.landmarks;
  if (lm) {
    for (const p of [lm.nose, lm.leftEar, lm.rightEar, lm.leftShoulder, lm.rightShoulder]) {
      if (!p) continue;
      ctx.fillStyle =
        p.confidence >= policy.calibration.landmark_confidence_min ? '#2ecc71' : '#e74c3c';
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------- analysis loop (≤15 fps, like the service) ----------
async function analyseOnce() {
  const started = performance.now();
  try {
    const frame = (await adapter.analyze(video, started)) as CameraFrame;
    lastFrame = frame;
    lastGuide = guideFit(frame);
    onFrame(frame, lastGuide, started);
  } catch {
    // Frame not ready: skipped, like camera-pipeline.ts.
  }
  drawOverlay();
  const elapsed = performance.now() - started;
  loopTimer = window.setTimeout(analyseOnce, Math.max(0, ANALYSIS_INTERVAL_MS - elapsed));
}

function onFrame(frame: CameraFrame, guide: GuideFit, at: number) {
  if (mode === 'calibrating') return calibrate(frame, guide);
  if (mode === 'recording') return record(frame, guide, at);
  if (mode === 'preview' || mode === 'ready' || mode === 'countdown') {
    if (mode !== 'countdown')
      status(
        guide.fit ? '가이드 안에 있어요.' : guideLabel[guide.issue],
        guide.fit ? 'ok' : 'warn',
      );
  }
}

// Same rule as camera-pipeline.ts (requireGuide): a usable frame outside the guide restarts.
function calibrate(frame: CameraFrame, guide: GuideFit) {
  const result = cameraFeatures(frame);
  if (!guide.fit && result.ok) {
    calibration = initialCalibration();
    progressEl.value = 0;
    status(guideLabel[guide.issue], 'warn');
    return;
  }
  const next = advanceCalibration(calibration, result);
  if (next.status === 'done') {
    baseline = { r0: next.baseline.r0, h0: next.baseline.h0, n0: next.baseline.n0 ?? null };
    progressEl.value = 1;
    calibLabelEl.textContent = '기준 자세: 저장 완료 ✓';
    setMode('ready');
    status('기준 자세 저장 완료. 녹화를 시작할 수 있어요.', 'ok');
    beep(880, 150, 0.2);
    return;
  }
  calibration = next;
  progressEl.value = next.progress;
  status(
    next.lastRestart
      ? `다시 모으는 중 (${next.lastRestart}) — 바른 자세로 가만히`
      : '바른 자세로 3초 가만히 있어 주세요',
    'info',
  );
}

function record(frame: CameraFrame, guide: GuideFit, at: number) {
  const tMs = at - t0;
  const lm = frame.landmarks;
  logged.push({
    tMs,
    width: frame.frameWidth,
    height: frame.frameHeight,
    quality: frame.quality,
    points: {
      nose: lm.nose,
      leftEar: lm.leftEar,
      rightEar: lm.rightEar,
      leftShoulder: lm.leftShoulder,
      rightShoulder: lm.rightShoulder,
    },
    guide: guide.fit ? 'ok' : guide.issue,
    shoulderWidth: guide.shoulderWidth,
  });
  // Show guide problems during recording but keep going; they are flagged in guide.csv.
  status(guide.fit ? '녹화 중' : `녹화 중 · ${guideLabel[guide.issue]}`, guide.fit ? 'ok' : 'warn');
}

// ---------- script ticker (independent of the analysis rate) ----------
function tick() {
  if (mode !== 'recording') return;
  const t = performance.now() - t0;
  if (!syncDone && t >= plan.syncMs) {
    syncDone = true;
    beep(1000, 300, 0.8);
    flashEl.classList.add('on');
    window.setTimeout(() => flashEl.classList.remove('on'), 300);
  }
  const p = phaseAt(plan, t);
  if (p.phase === 'done') {
    void stopRecording();
    return;
  }
  const key = p.phase === 'lead_in' ? 'lead' : `${p.phase}-${p.segment.index}`;
  if (key !== lastPhaseKey) {
    lastPhaseKey = key;
    if (p.phase === 'prep') {
      beep(600, 80, 0.3);
      say(p.segment.prompt);
    } else if (p.phase === 'hold') {
      beep(900, 60, 0.2);
    }
  }
  const sec = Math.ceil(p.remainingMs / 1000);
  if (p.phase === 'lead_in') {
    promptEl.textContent = '곧 시작해요 (삐 소리 = 맞춤 신호)';
    timerEl.textContent = `${sec}`;
  } else {
    const n = `${p.segment.index + 1}/${plan.segments.length}`;
    promptEl.textContent = p.segment.prompt;
    timerEl.textContent = p.phase === 'prep' ? `${n} · 준비 ${sec}` : `${n} · 유지 ${sec}`;
  }
  requestAnimationFrame(tick);
}

// ---------- buttons ----------
cameraBtn.onclick = async () => {
  audio ??= new AudioContext();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, // useWebcam.ts
      audio: false,
    });
  } catch {
    status('카메라를 켜지 못했어요. 권한과 다른 앱의 카메라 사용을 확인해 주세요.', 'warn');
    return;
  }
  video.srcObject = stream;
  await video.play();
  status('AI 모델 불러오는 중...', 'info');
  try {
    await adapter.load();
  } catch {
    status(
      '모델을 불러오지 못했어요. 저장소 루트에서 npm run pose:assets 를 실행했는지 확인해 주세요.',
      'warn',
    );
    return;
  }
  setMode('preview');
  void analyseOnce();
};

calibBtn.onclick = () => {
  notice('');
  calibLabelEl.textContent = '기준 자세 진행';
  calibration = initialCalibration();
  baseline = null;
  progressEl.value = 0;
  setMode('calibrating');
};

recordBtn.onclick = () => {
  let stem: string;
  try {
    stem = fileStem(participantEl.value, sessionEl.value);
  } catch (e) {
    // The status line is rewritten every frame, so the reason goes to the persistent notice.
    notice((e as Error).message);
    participantEl.classList.add('missing');
    participantEl.focus();
    return;
  }
  notice('');
  participantEl.classList.remove('missing');
  mimeType =
    ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    ) ?? '';
  setMode('countdown');
  let n = 3;
  promptEl.textContent = '측면 폰 녹화를 먼저 켜 두세요';
  const count = () => {
    if (mode !== 'countdown') return;
    timerEl.textContent = `${n}`;
    beep(500, 60, 0.15);
    if (n-- > 0) return void window.setTimeout(count, 1000);
    startRecording(stem);
  };
  count();
};

function startRecording(stem: string) {
  if (!stream) return;
  plan = planSchedule(defaultScript);
  logged = [];
  chunks = [];
  syncDone = false;
  lastPhaseKey = '';
  recorder = new MediaRecorder(stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: 5_000_000,
  });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstart = () => {
    t0 = performance.now();
    setMode('recording');
    requestAnimationFrame(tick);
  };
  recorder.onstop = () => save(stem);
  recorder.start(1000);
}

async function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else setMode('ready');
}
stopBtn.onclick = () => {
  if (mode === 'countdown') return setMode('ready');
  status(
    '중간에 멈췄어요. 받은 파일은 끝까지 찍은 것이 아니니 이름 뒤에 _partial이 붙어요.',
    'warn',
  );
  partial = true;
  void stopRecording();
};
let partial = false;

function save(stem: string) {
  const name = partial ? `${stem}_partial` : stem;
  partial = false;
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  const lastT = logged.length ? logged[logged.length - 1].tMs : 0;
  const meta = {
    tool: 'tools/record-guide',
    file_stem: name,
    recorded_at: new Date().toISOString(),
    complete: name === stem,
    video_mime: mimeType,
    video_size: { width: video.videoWidth, height: video.videoHeight },
    analysis_interval_ms: ANALYSIS_INTERVAL_MS,
    analysed_frames: logged.length,
    analysed_fps: lastT > 0 ? Number(((logged.length * 1000) / lastT).toFixed(2)) : null,
    model: 'pose_landmarker_lite (browser)',
    delegate: adapter.delegate,
    policy_id: policy.policy_id,
    guide: defaultGuide,
    baseline_service_calibration: baseline,
    sync_ms: plan.syncMs,
    plan: plan.segments.map(({ label, note, prepStartMs, startMs, endMs }) => ({
      label,
      note,
      prep_start_ms: prepStartMs,
      start_ms: startMs,
      end_ms: endMs,
    })),
    guide_per_segment: guideSummary(logged, plan),
    user_agent: navigator.userAgent,
  };
  files = [
    { name: `${name}.${ext}`, blob: new Blob(chunks, { type: mimeType || 'video/webm' }) },
    { name: `${name}.csv`, blob: new Blob([evaluateSegmentsCsv(plan)], { type: 'text/csv' }) },
    { name: `${name}.landmarks.csv`, blob: new Blob([landmarksCsv(logged)], { type: 'text/csv' }) },
    { name: `${name}.guide.csv`, blob: new Blob([guideCsv(logged, plan)], { type: 'text/csv' }) },
    {
      name: `${name}.segments.json`,
      blob: new Blob([cvaSegmentsJson(plan)], { type: 'application/json' }),
    },
    {
      name: `${name}.meta.json`,
      blob: new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }),
    },
  ];
  download();
  const bad = meta.guide_per_segment.filter((s) => s.frames > 0 && s.guideOk / s.frames < 0.8);
  summaryEl.textContent =
    `저장: ${files.map((f) => f.name).join(', ')}\n` +
    `분석 ${logged.length}프레임, 약 ${meta.analysed_fps ?? '-'} fps\n` +
    (bad.length
      ? `가이드 밖이 20% 넘은 구간: ${bad.map((s) => `${s.index + 1}(${s.label} ${s.note})`).join(', ')}`
      : '모든 구간에서 80% 이상 가이드 안');
  promptEl.textContent = '끝! 측면 폰 녹화도 멈춰 주세요';
  timerEl.textContent = '';
  setMode('saved');
}

function download() {
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f.blob);
    a.download = f.name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }
}

againBtn.onclick = () => {
  download();
};
$<HTMLButtonElement>('next').onclick = () => {
  if (mode !== 'saved') return;
  summaryEl.textContent = '';
  setMode('ready');
  status(
    '같은 기준 자세로 다음 녹화를 할 수 있어요. 자리를 옮겼다면 기준 자세를 다시 잡아 주세요.',
    'info',
  );
};

window.addEventListener('beforeunload', () => {
  if (loopTimer !== null) clearTimeout(loopTimer);
  stream?.getTracks().forEach((t) => t.stop());
  adapter.close();
});

setMode('off');
status('참가자 ID를 넣고 카메라 켜기를 눌러 주세요.', 'info');
