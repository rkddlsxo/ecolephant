import { formatDuration } from '../../components/ui';
import type { Point, Series } from '../statistics/charts';
import { groupName, showsPolicy, type Group, type StatsView, type Unit } from '../statistics/model';
import { correctionRatio, meanCorrection, summaryView } from '../history/format';
import { STATE_COLORS } from '../statistics/StateDonut';
import {
  CONTENT_W,
  MARGIN,
  Pages,
  color,
  finishDocument,
  sectionTitle,
  startDocument,
} from './canvas-doc';

export type StatisticsReportInput = {
  /** 예: "최근 7일 · 전체 방식 · 일별" */
  filterLabel: string;
  rangeLabel: string;
  unit: Unit;
  groups: Group[];
  unassigned: number;
  /** 방식 필터를 고른 경우 미분류 시간은 의미가 없어 '—'로 표시 */
  unassignedApplies: boolean;
  view: StatsView;
};

const CHART_H = 150;

function alertTile(view: StatsView) {
  return view.totalCorrected == null
    ? `${view.totalAlerts}회`
    : `${view.totalAlerts}회 (변화 ${view.totalCorrected}회)`;
}
const AXIS_W = 34;

function drawTiles(doc: Pages, input: StatisticsReportInput) {
  const tiles = [
    ['유효 측정 시간', formatDuration(input.view.totalValid)],
    ['1차 알림', alertTile(input.view)],
    ['미분류 시간', input.unassignedApplies ? formatDuration(input.unassigned) : '—'],
  ] as const;
  const gap = 10;
  const w = (CONTENT_W - gap * 2) / 3;
  const h = 58;
  doc.ensure(h + 16);
  tiles.forEach(([label, value], i) => {
    const x = MARGIN + i * (w + gap);
    doc.strokeRect(x, doc.y, w, h, color.line, 6);
    doc.text(label, x + 12, doc.y + 20, 9, color.muted, 600);
    doc.text(value, x + 12, doc.y + 44, 17, color.ink, 750);
  });
  doc.y += h + 22;
}

const DONUT_R = 34;
const DONUT_W = 12;

/** 화면의 '자세 상태 분포'와 같은 도넛. 그룹마다 하나, 한 줄에 두 개씩 */
function drawDonuts(doc: Pages, groups: Group[], policy: boolean) {
  const colW = CONTENT_W / 2;
  const rowH = DONUT_R * 2 + DONUT_W + 34;
  groups.forEach((group, index) => {
    const col = index % 2;
    if (col === 0) doc.ensure(rowH);
    const x = MARGIN + col * colW;
    const top = doc.y;
    const title = policy ? `${groupName(group)} · 기준 ${group.policy_id}` : groupName(group);
    doc.text(title, x, top + 10, 10, color.ink, 700);
    const { total, parts } = summaryView(group.summary);
    const cx = x + DONUT_R + DONUT_W / 2;
    const cy = top + 22 + DONUT_R + DONUT_W / 2;
    const ctx = doc.ctx;
    ctx.lineWidth = DONUT_W;
    ctx.strokeStyle = color.soft;
    ctx.beginPath();
    ctx.arc(cx, cy, DONUT_R, 0, Math.PI * 2);
    ctx.stroke();
    if (total > 0) {
      const shown = parts.filter((part) => part.ms > 0);
      const gap = shown.length > 1 ? 2 / DONUT_R : 0;
      let angle = -Math.PI / 2;
      shown.forEach((part) => {
        const sweep = (part.ms / total) * Math.PI * 2;
        ctx.strokeStyle = STATE_COLORS[part.key];
        ctx.beginPath();
        ctx.arc(cx, cy, DONUT_R, angle, angle + Math.max(0.01, sweep - gap));
        ctx.stroke();
        angle += sweep;
      });
      doc.text(
        `${((parts[0].ms / total) * 100).toFixed(1)}%`,
        cx,
        cy + 2,
        12,
        color.ink,
        750,
        'center',
      );
      doc.text('정상', cx, cy + 14, 7.5, color.muted, 400, 'center');
    } else {
      doc.text('유효 시간 없음', cx, cy + 3, 8, color.faint, 400, 'center');
    }
    const lx = x + DONUT_R * 2 + DONUT_W + 18;
    parts.forEach((part, i) => {
      const ly = top + 36 + i * 16;
      doc.rect(lx, ly - 7, 8, 8, STATE_COLORS[part.key], 2);
      doc.text(part.label, lx + 13, ly, 9, color.muted);
      doc.text(
        total > 0 ? `${((part.ms / total) * 100).toFixed(1)}%` : '—',
        lx + 88,
        ly,
        9,
        color.ink,
        600,
        'right',
      );
      doc.text(formatDuration(part.ms), lx + 96, ly, 9, color.muted);
    });
    if (col === 1 || index === groups.length - 1) doc.y += rowH;
  });
  doc.text(
    '유효 측정 시간 기준이에요. 판단 불가 시간은 빠져 있고, 측정 방식·출처·판정 기준이 다르면 따로 그려요.',
    MARGIN,
    doc.y,
    8.5,
    color.faint,
  );
  doc.y += 20;
}

function xLabels(doc: Pages, labels: { label: string }[], xAt: (i: number) => number, y: number) {
  const step = Math.max(1, Math.ceil(labels.length / 8));
  labels.forEach((l, i) => {
    if (i % step === 0) doc.text(l.label, xAt(i), y, 7.5, color.muted, 400, 'center');
  });
}

function grid(doc: Pages, ticks: number[], yAt: (v: number) => number, fmt: (v: number) => string) {
  ticks.forEach((t) => {
    const y = yAt(t);
    doc.ctx.strokeStyle = '#eceef0';
    doc.ctx.lineWidth = 0.6;
    doc.ctx.beginPath();
    doc.ctx.moveTo(MARGIN + AXIS_W, y);
    doc.ctx.lineTo(MARGIN + CONTENT_W, y);
    doc.ctx.stroke();
    doc.text(fmt(t), MARGIN + AXIS_W - 6, y + 3, 7.5, color.muted, 400, 'right');
  });
}

function drawLineChart(doc: Pages, labels: { label: string }[], series: Series[]) {
  doc.ensure(CHART_H + 40);
  // 범례 (계열 2개 이상)
  if (series.length > 1) {
    let lx = MARGIN;
    series.forEach((s) => {
      doc.rect(lx, doc.y - 4, 8, 8, s.color, 2);
      doc.text(s.name, lx + 12, doc.y + 3, 8.5, color.muted);
      doc.font(8.5);
      lx += 12 + doc.ctx.measureText(s.name).width + 14;
    });
    doc.y += 14;
  }
  const top = doc.y + 4;
  const plotW = CONTENT_W - AXIS_W - 8;
  const n = labels.length;
  const xAt = (i: number) => MARGIN + AXIS_W + 4 + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => top + CHART_H - (v / 100) * CHART_H;
  grid(doc, [0, 25, 50, 75, 100], yAt, (v) => `${v}%`);
  series.forEach((s) => {
    doc.ctx.strokeStyle = s.color;
    doc.ctx.lineWidth = 1.5;
    doc.ctx.beginPath();
    let pen = false;
    s.points.forEach((p, i) => {
      if (p.value == null) {
        pen = false;
        return;
      }
      if (pen) doc.ctx.lineTo(xAt(i), yAt(p.value));
      else doc.ctx.moveTo(xAt(i), yAt(p.value));
      pen = true;
    });
    doc.ctx.stroke();
    s.points.forEach((p, i) => {
      if (p.value == null) return;
      doc.ctx.fillStyle = 'white';
      doc.ctx.beginPath();
      doc.ctx.arc(xAt(i), yAt(p.value), 3.2, 0, Math.PI * 2);
      doc.ctx.fill();
      doc.ctx.fillStyle = s.color;
      doc.ctx.beginPath();
      doc.ctx.arc(xAt(i), yAt(p.value), 2.3, 0, Math.PI * 2);
      doc.ctx.fill();
    });
  });
  xLabels(doc, labels, xAt, top + CHART_H + 14);
  doc.y = top + CHART_H + 28;
}

function drawBarChart(doc: Pages, points: Point[]) {
  doc.ensure(CHART_H + 30);
  const top = doc.y + 4;
  const plotW = CONTENT_W - AXIS_W - 8;
  const n = Math.max(1, points.length);
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  const slot = plotW / n;
  const barW = Math.max(3, Math.min(26, slot - 2));
  const yAt = (v: number) => top + CHART_H - (v / max) * CHART_H;
  grid(doc, [0, max / 2, max], yAt, (v) => `${Math.round(v / 60000)}분`);
  points.forEach((p, i) => {
    const h = ((p.value ?? 0) / max) * CHART_H;
    if (h <= 0) return;
    const x = MARGIN + AXIS_W + 4 + i * slot + (slot - barW) / 2;
    doc.ctx.fillStyle = '#2a78d6';
    doc.ctx.beginPath();
    doc.ctx.roundRect(x, top + CHART_H - h, barW, h, [
      Math.min(3, barW / 2, h),
      Math.min(3, barW / 2, h),
      0,
      0,
    ]);
    doc.ctx.fill();
  });
  xLabels(doc, points, (i) => MARGIN + AXIS_W + 4 + i * slot + slot / 2, top + CHART_H + 14);
  doc.y = top + CHART_H + 28;
}

const ROW_H = 20;
function table(doc: Pages, headers: { label: string; w: number }[], rows: string[][]) {
  const header = () => {
    doc.rect(MARGIN, doc.y, CONTENT_W, ROW_H, color.soft, 4);
    let x = MARGIN;
    headers.forEach((h) => {
      doc.text(h.label, x + 8, doc.y + 14, 8.5, color.muted, 600);
      x += h.w;
    });
    doc.y += ROW_H;
  };
  doc.ensure(ROW_H * 2);
  header();
  rows.forEach((row) => {
    if (doc.ensure(ROW_H)) header();
    let x = MARGIN;
    row.forEach((cell, i) => {
      doc.text(cell, x + 8, doc.y + 14, 8.5, color.ink);
      x += headers[i]!.w;
    });
    doc.y += ROW_H;
    doc.hline(doc.y, '#eceef0');
  });
  doc.y += 16;
}

function metricCells(m: Group['summary']) {
  const valid = m.valid_duration_ms > 0;
  return [
    formatDuration(m.valid_duration_ms),
    valid && m.within_range_percent != null ? `${m.within_range_percent.toFixed(1)}%` : '—',
    valid ? `${((m.high_duration_ms / m.valid_duration_ms) * 100).toFixed(1)}%` : '—',
    `${m.first_stage_alert_count}회`,
    correctionRatio(m) ?? '—',
    meanCorrection(m),
  ];
}

const dayFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});
const hourFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export async function createStatisticsPdf(input: StatisticsReportInput): Promise<Blob> {
  const doc = await startDocument('통계 리포트');
  doc.text('통계·추이', MARGIN, doc.y + 18, 20, color.ink, 750);
  doc.text(`${input.filterLabel} · ${input.rangeLabel}`, MARGIN, doc.y + 38, 10, color.muted);
  doc.y += 58;

  if (!input.groups.length && !input.unassigned) {
    doc.text('이 기간에는 통계가 없어요.', MARGIN, doc.y + 10, 11, color.faint);
    return finishDocument(doc);
  }

  drawTiles(doc, input);

  if (input.groups.length) {
    sectionTitle(doc, '자세 상태 분포');
    drawDonuts(doc, input.groups, showsPolicy(input.groups));
  }

  if (input.view.labels.length) {
    sectionTitle(doc, '정상 범위 비율 추이');
    drawLineChart(doc, input.view.labels, input.view.series);
    if (input.view.hidden > 0)
      doc.text(
        `그룹이 많아 처음 ${input.view.series.length}개만 그렸어요. 나머지는 아래 표를 확인해 주세요.`,
        MARGIN,
        doc.y,
        8.5,
        color.faint,
      );
    doc.text(
      '측정 방식·출처·판정 기준이 다르면 비율을 합치지 않고 따로 보여 줘요.',
      MARGIN,
      doc.y + (input.view.hidden > 0 ? 14 : 0),
      8.5,
      color.faint,
    );
    doc.y += input.view.hidden > 0 ? 34 : 20;

    sectionTitle(doc, '유효 측정 시간');
    drawBarChart(doc, input.view.validByStart);
  }

  const metricHeaders = [
    { label: '유효 시간', w: 58 },
    { label: '정상 비율', w: 52 },
    { label: '높은 신호 비율', w: 70 },
    { label: '알림', w: 38 },
    { label: '알림 후 변화', w: 62 },
    { label: '평균 변화', w: 52 },
  ];
  const metricW = metricHeaders.reduce((sum, h) => sum + h.w, 0);
  const policy = showsPolicy(input.groups);
  const name = (g: Group) => (policy ? `${groupName(g)} · ${g.policy_id}` : groupName(g));
  sectionTitle(doc, '전체');
  table(
    doc,
    [{ label: policy ? '방식 · 기준' : '방식', w: CONTENT_W - metricW }, ...metricHeaders],
    input.groups.map((g) => [name(g), ...metricCells(g.summary)]),
  );

  const buckets = input.groups
    .flatMap((g) => g.buckets.map((b) => ({ g, b })))
    .sort((a, b) => Date.parse(a.b.starts_at) - Date.parse(b.b.starts_at));
  if (buckets.length) {
    sectionTitle(doc, '기간별');
    const fmt = input.unit === 'day' ? dayFormat : hourFormat;
    table(
      doc,
      [{ label: '기간', w: 82 }, { label: '방식', w: CONTENT_W - metricW - 82 }, ...metricHeaders],
      buckets.map(({ g, b }) => [
        fmt.format(new Date(b.starts_at)),
        name(g),
        ...metricCells(b.metrics),
      ]),
    );
  }
  if (input.unassignedApplies && input.unassigned > 0)
    doc.text(`미분류 시간 ${formatDuration(input.unassigned)}`, MARGIN, doc.y, 9, color.muted);

  return finishDocument(doc);
}
