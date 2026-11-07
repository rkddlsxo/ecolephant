import type { Session, SessionEvent } from '../../api/client';
import type { components } from '../../api/generated';
import { formatDate, formatDuration, modeLabel } from '../../components/ui';
import {
  bucketModes,
  sessionLength,
  statusLabel,
  summaryTitle,
  summaryView,
} from '../history/format';
import {
  CONTENT_W,
  MARGIN,
  Pages,
  chip,
  color,
  finishDocument,
  sectionTitle,
  startDocument,
} from './canvas-doc';

type Bucket = components['schemas']['Timeline']['buckets'][number];

export type ReportInput = {
  session: Session;
  buckets: Bucket[];
  events: SessionEvent[];
  eventNames: Record<SessionEvent['type'], string>;
};

function drawTitle(doc: Pages, session: Session) {
  doc.text(formatDate(session.started_at), MARGIN, doc.y + 18, 20, color.ink, 750);
  doc.font(20, 750);
  let x = MARGIN + doc.ctx.measureText(formatDate(session.started_at)).width + 10;
  const done = session.status === 'completed';
  x +=
    chip(
      doc,
      statusLabel(session.status),
      x,
      doc.y + 14,
      done ? '#dcfce7' : '#fef3c7',
      done ? '#15803d' : '#b45309',
    ) + 6;
  const real = session.data_source === 'real';
  chip(
    doc,
    real ? '실제' : '테스트',
    x,
    doc.y + 14,
    real ? color.tint : '#efe9f0',
    real ? color.primary : '#644068',
  );
  doc.text(
    `${modeLabel[session.requested_mode]} 방식으로 측정한 세션 · 측정 길이 ${sessionLength(session)}`,
    MARGIN,
    doc.y + 38,
    10,
    color.muted,
  );
  doc.y += 58;
}

const TILE_H = 62;
const DETAIL_H = 22;

/** 화면의 요약과 같은 구성: 방식 이름 → 핵심 타일 3개 → 상태 분포 막대 → 나머지 지표 2열 표 */
function drawSummaryBlock(doc: Pages, mode: string, view: ReturnType<typeof summaryView>) {
  const detailRows = Math.ceil(view.details.length / 2);
  doc.ensure(20 + TILE_H + 14 + 30 + detailRows * DETAIL_H + 18);

  doc.text(mode, MARGIN, doc.y + 12, 12, color.ink, 700);
  doc.y += 22;

  const gap = 10;
  const w = (CONTENT_W - gap * 2) / 3;
  view.tiles.forEach((tile, i) => {
    const x = MARGIN + i * (w + gap);
    doc.strokeRect(x, doc.y, w, TILE_H, color.line, 6);
    doc.text(tile.label, x + 12, doc.y + 18, 9, color.muted, 600);
    doc.text(tile.value, x + 12, doc.y + 40, 17, color.ink, 750);
    if ('caption' in tile && tile.caption)
      doc.text(tile.caption, x + 12, doc.y + 54, 8, color.muted);
  });
  doc.y += TILE_H + 14;

  // 분포 막대 (가로 전체)
  const barH = 7;
  doc.rect(MARGIN, doc.y, CONTENT_W, barH, color.soft, 3.5);
  if (view.total > 0) {
    doc.ctx.save();
    doc.ctx.beginPath();
    doc.ctx.roundRect(MARGIN, doc.y, CONTENT_W, barH, 3.5);
    doc.ctx.clip();
    let x = MARGIN;
    view.parts.forEach(({ key, ms }) => {
      const pw = (ms / view.total) * CONTENT_W;
      if (pw > 0) doc.rect(x, doc.y, pw, barH, color[key]);
      x += pw;
    });
    doc.ctx.restore();
  }
  let lx = MARGIN;
  const ly = doc.y + barH + 12;
  view.parts.forEach(({ key, label, ms }) => {
    const text = `${label} ${formatDuration(ms)}`;
    doc.rect(lx, ly - 7, 7, 7, color[key], 1.5);
    doc.text(text, lx + 11, ly, 8.5, color.muted);
    doc.font(8.5);
    lx += 11 + doc.ctx.measureText(text).width + 14;
  });
  doc.y = ly + 10;

  // 나머지 지표 2열
  const colGap = 24;
  const cw = (CONTENT_W - colGap) / 2;
  view.details.forEach(([label, value], i) => {
    const x = MARGIN + (i % 2) * (cw + colGap);
    const y = doc.y + Math.floor(i / 2) * DETAIL_H;
    doc.text(label, x, y + 14, 9, color.muted);
    doc.text(value, x + cw, y + 14, 9, color.ink, 600, 'right');
    doc.ctx.strokeStyle = color.line;
    doc.ctx.lineWidth = 0.6;
    doc.ctx.beginPath();
    doc.ctx.moveTo(x, y + DETAIL_H);
    doc.ctx.lineTo(x + cw, y + DETAIL_H);
    doc.ctx.stroke();
  });
  doc.y += detailRows * DETAIL_H + 18;
}

function drawSummary(doc: Pages, session: Session) {
  sectionTitle(doc, '요약');
  if (!session.summaries.length) {
    doc.text('기록 없음', MARGIN, doc.y + 10, 10, color.faint);
    doc.y += 28;
    return;
  }
  session.summaries.forEach((summary) =>
    drawSummaryBlock(
      doc,
      summaryTitle(session.requested_mode, summary.active_mode),
      summaryView(summary.metrics),
    ),
  );
  if (session.unassigned_unknown_duration_ms > 0) {
    doc.text(
      `미분류 시간 ${formatDuration(session.unassigned_unknown_duration_ms)}`,
      MARGIN,
      doc.y,
      9,
      color.muted,
    );
    doc.y += 16;
  }
  doc.y += 6;
}

const columns = [
  { label: '시작', x: 0, w: 62 },
  { label: '방식', x: 62, w: 62 },
  { label: '분포', x: 124, w: 120 },
  { label: '정상', x: 252, w: 62 },
  { label: '주의', x: 314, w: 62 },
  { label: '높음', x: 376, w: 62 },
  { label: '판단 불가', x: 438, w: 77 },
] as const;
const ROW_H = 22;

function tableHeader(doc: Pages) {
  doc.rect(MARGIN, doc.y, CONTENT_W, ROW_H, color.soft, 4);
  columns.forEach((c) => doc.text(c.label, MARGIN + c.x + 8, doc.y + 15, 9, color.muted, 600));
  doc.y += ROW_H;
}

function drawTimeline(doc: Pages, buckets: Bucket[]) {
  sectionTitle(doc, '타임라인');
  // 범례
  let lx = MARGIN;
  (
    [
      ['정상', color.normal],
      ['주의', color.caution],
      ['높음', color.high],
      ['판단 불가', color.unknown],
    ] as const
  ).forEach(([label, fill]) => {
    doc.rect(lx, doc.y - 4, 7, 7, fill, 1.5);
    doc.text(label, lx + 11, doc.y + 3, 8, color.muted);
    doc.font(8);
    lx += 11 + doc.ctx.measureText(label).width + 12;
  });
  doc.y += 12;
  if (!buckets.length) {
    doc.text('기록 없음', MARGIN, doc.y + 10, 10, color.faint);
    doc.y += 28;
    return;
  }
  doc.ensure(ROW_H * 2);
  tableHeader(doc);
  buckets.forEach((b) => {
    if (doc.ensure(ROW_H)) tableHeader(doc);
    const base = doc.y + 15;
    doc.text(formatDuration(b.elapsed_start_ms), MARGIN + 8, base, 9, color.ink);
    doc.text(bucketModes(b.active_modes), MARGIN + columns[1].x + 8, base, 9, color.ink);
    const parts = [
      [b.normal_ms, color.normal],
      [b.caution_ms, color.caution],
      [b.high_ms, color.high],
      [b.unknown_ms, color.unknown],
    ] as const;
    const total = parts.reduce((sum, [ms]) => sum + ms, 0);
    const barX = MARGIN + columns[2].x + 8;
    const barW = columns[2].w - 16;
    doc.rect(barX, doc.y + 8, barW, 6, color.soft, 3);
    if (total > 0) {
      doc.ctx.save();
      doc.ctx.beginPath();
      doc.ctx.roundRect(barX, doc.y + 8, barW, 6, 3);
      doc.ctx.clip();
      let x = barX;
      parts.forEach(([ms, fill]) => {
        const w = (ms / total) * barW;
        if (w > 0) doc.rect(x, doc.y + 8, w, 6, fill);
        x += w;
      });
      doc.ctx.restore();
    }
    [b.normal_ms, b.caution_ms, b.high_ms, b.unknown_ms].forEach((ms, i) =>
      doc.text(formatDuration(ms), MARGIN + columns[i + 3].x + 8, base, 9, color.ink),
    );
    doc.y += ROW_H;
    doc.hline(doc.y, '#eceef0');
  });
  doc.y += 18;
}

function drawEvents(doc: Pages, events: SessionEvent[], names: ReportInput['eventNames']) {
  sectionTitle(doc, '이벤트');
  if (!events.length) {
    doc.text('기록 없음', MARGIN, doc.y + 10, 10, color.faint);
    doc.y += 28;
    return;
  }
  events.forEach((event) => {
    doc.ensure(22);
    const cy = doc.y + 10;
    doc.ctx.fillStyle = color.tint;
    doc.ctx.beginPath();
    doc.ctx.arc(MARGIN + 7, cy, 5, 0, Math.PI * 2);
    doc.ctx.fill();
    doc.text(names[event.type], MARGIN + 22, cy + 4, 10, color.ink, 600);
    doc.text(
      formatDuration(event.elapsed_ms),
      MARGIN + CONTENT_W,
      cy + 4,
      9,
      color.muted,
      400,
      'right',
    );
    doc.y += 22;
  });
}

export async function createSessionPdf(input: ReportInput): Promise<Blob> {
  const doc = await startDocument('세션 리포트');
  drawTitle(doc, input.session);
  drawSummary(doc, input.session);
  drawTimeline(doc, input.buckets);
  drawEvents(doc, input.events, input.eventNames);
  return finishDocument(doc);
}
