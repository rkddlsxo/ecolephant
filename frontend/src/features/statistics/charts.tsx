import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** 범주 색: 검증된 순서대로만 사용 (최대 3개, 흰 바탕 기준 CVD 통과). */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'] as const;

export type Point = { x: string; label: string; value: number | null };
export type Series = { key: string; name: string; color: string; points: Point[] };

const HEIGHT = 240;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(Math.max(280, node.clientWidth));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function labelStep(count: number, plotWidth: number) {
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / 72))));
}

/** 호버 카드 고정 폭. 위치에 따라 폭이 바뀌지 않게 하고, 차트 밖으로 나가지 않게 가운데를 제한 */
const TOOLTIP_W = 184;

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const half = TOOLTIP_W / 2;
  const left = Math.min(Math.max(x, half), width - half);
  return (
    <div className="chart-tooltip" style={{ left }} role="presentation">
      {children}
    </div>
  );
}

/** 선 끝(그래프 오른쪽 끝)에서 이름까지 간격 */
const LABEL_OFFSET = 14;
/**
 * 그래프 바깥 여백. 왼쪽 축 글자('100%', 11px)가 PAD.left 안에서 남기는 여백과 같게 맞춰
 * 양옆 여백이 같아 보이게 함.
 */
const OUTER = 10;

let measureContext: CanvasRenderingContext2D | null | undefined;
/** 직접 라벨(.chart-direct, 600 12px) 글자 폭. 캔버스를 못 쓰는 환경에서는 글자 수로 어림 */
function textWidth(text: string) {
  if (measureContext === undefined) {
    try {
      measureContext =
        typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)
          ? null
          : document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext)
    return [...text].reduce((w, ch) => w + (/[\u3131-\uD79D]/.test(ch) ? 12 : 7), 0);
  measureContext.font = `600 12px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
  return measureContext.measureText(text).width;
}

/** 직접 라벨 사이 최소 세로 간격(px). 글자 높이 + 여유 */
const LABEL_GAP = 15;

type Placed = { key: string; name: string; color: string; x: number; y: number; labelY: number };

/**
 * 계열 이름을 마지막 값 높이에 맞춰 오른쪽 여백에 두되, 끝 값이 비슷해 겹치면 위아래로 밀어
 * 최소 간격을 지킴. 차트 위·아래 밖으로는 나가지 않게 함.
 */
export function placeDirectLabels(
  anchors: { key: string; name: string; color: string; x: number; y: number }[],
  top: number,
  bottom: number,
): Placed[] {
  const sorted = [...anchors].sort((a, b) => a.y - b.y).map((a) => ({ ...a, labelY: a.y }));
  // 위에서 아래로: 앞 라벨과 간격이 모자라면 아래로 밈
  for (let i = 0; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    sorted[i]!.labelY = Math.max(sorted[i]!.labelY, prev ? prev.labelY + LABEL_GAP : top);
  }
  // 아래로 넘쳤으면 아래에서 위로 다시 올림
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const next = sorted[i + 1];
    sorted[i]!.labelY = Math.min(sorted[i]!.labelY, next ? next.labelY - LABEL_GAP : bottom);
  }
  return sorted;
}

function DirectLabels({
  series,
  xAt,
  yAt,
  labelX,
  top,
  bottom,
}: {
  series: Series[];
  xAt: (i: number) => number;
  yAt: (v: number) => number;
  labelX: number;
  top: number;
  bottom: number;
}) {
  const anchors = series.flatMap((s) => {
    for (let i = s.points.length - 1; i >= 0; i -= 1) {
      const value = s.points[i]?.value;
      if (value != null)
        return [{ key: s.key, name: s.name, color: s.color, x: xAt(i), y: yAt(value) }];
    }
    return [];
  });
  return (
    <>
      {placeDirectLabels(anchors, top, bottom).map((label) => (
        <g key={label.key}>
          {/* 라벨이 끝점에서 멀어졌으면 짧은 연결선으로 어느 선의 이름인지 이어 줌 */}
          {Math.abs(label.labelY - label.y) > 2 || labelX - label.x > 14 ? (
            <polyline
              className="chart-leader"
              points={`${label.x + 6},${label.y} ${labelX - 8},${label.labelY} ${labelX - 3},${label.labelY}`}
              fill="none"
              stroke={label.color}
            />
          ) : null}
          <text className="chart-direct" x={labelX} y={label.labelY + 4}>
            {label.name}
          </text>
        </g>
      ))}
    </>
  );
}

/** 시간에 따른 비율(0–100%) 꺾은선. 값이 없는 구간은 선을 끊음. */
export function LineChart({
  labels,
  series,
  format,
  ariaLabel,
}: {
  labels: { x: string; label: string }[];
  series: Series[];
  format: (value: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const directLabels = series.length > 1;
  // 오른쪽 여백은 가장 긴 계열 이름에 맞춤 (한글 약 12px, 그 외 약 7px로 어림, 최대 170px)
  // 오른쪽 여백 = 선 끝과 이름 사이 간격 + 가장 긴 이름 폭 + 왼쪽 바깥 여백과 같은 값
  const labelWidth = Math.max(0, ...series.map((s) => textWidth(s.name)));
  const right = directLabels ? LABEL_OFFSET + Math.ceil(labelWidth) + OUTER : PAD.right;
  const plotW = width - PAD.left - right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const n = labels.length;
  const xAt = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => PAD.top + plotH - (v / 100) * plotH;
  const step = labelStep(n, plotW);

  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.points.forEach((p, i) => {
      if (p.value == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xAt(i)},${yAt(p.value)}`;
      pen = true;
    });
    return d;
  });

  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const rel = event.clientX - box.left;
    setHover(n <= 1 ? 0 : Math.round((rel / box.width) * (n - 1)));
  };

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel}>
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line
              className="chart-grid"
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={yAt(tick)}
              y2={yAt(tick)}
            />
            <text className="chart-axis" x={PAD.left - 8} y={yAt(tick) + 4} textAnchor="end">
              {tick}%
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % step === 0 ? (
            <text key={l.x} className="chart-axis" x={xAt(i)} y={HEIGHT - 8} textAnchor="middle">
              {l.label}
            </text>
          ) : null,
        )}
        {hover != null && (
          <line
            className="chart-crosshair"
            x1={xAt(hover)}
            x2={xAt(hover)}
            y1={PAD.top}
            y2={PAD.top + plotH}
          />
        )}
        {series.map((s, si) => (
          <g key={s.key}>
            <path d={paths[si]} fill="none" stroke={s.color} strokeWidth={2} />
            {s.points.map((p, i) =>
              p.value == null ? null : (
                <circle
                  key={p.x}
                  cx={xAt(i)}
                  cy={yAt(p.value)}
                  r={hover === i ? 5 : 4}
                  fill={s.color}
                  stroke="white"
                  strokeWidth={2}
                />
              ),
            )}
          </g>
        ))}
        {directLabels && (
          <DirectLabels
            series={series}
            xAt={xAt}
            yAt={yAt}
            labelX={PAD.left + plotW + LABEL_OFFSET}
            top={PAD.top}
            bottom={PAD.top + plotH}
          />
        )}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover != null && labels[hover] && (
        <Tooltip x={xAt(hover)} width={width}>
          <strong>{labels[hover].label}</strong>
          {series.map((s) => {
            const value = s.points[hover]?.value;
            return (
              <span key={s.key}>
                <i style={{ background: s.color }} />
                <em>{s.name}</em>
                <b>{value == null ? '—' : format(value)}</b>
              </span>
            );
          })}
        </Tooltip>
      )}
    </div>
  );
}

/** 구간별 합계 막대 (단일 계열). */
export function BarChart({
  points,
  color,
  format,
  axisFormat = format,
  ariaLabel,
}: {
  points: Point[];
  color: string;
  format: (value: number) => string;
  axisFormat?: (value: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const n = points.length;
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(4, Math.min(36, slot - 2));
  const step = labelStep(n, plotW);
  const ticks = [0, 0.5, 1].map((t) => t * max);

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel}>
        {ticks.map((tick) => {
          const y = PAD.top + plotH - (tick / max) * plotH;
          return (
            <g key={tick}>
              <line className="chart-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y} y2={y} />
              <text className="chart-axis" x={PAD.left - 8} y={y + 4} textAnchor="end">
                {axisFormat(tick)}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const value = p.value ?? 0;
          const h = (value / max) * plotH;
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const y = PAD.top + plotH - h;
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={p.x}>
              {h > 0 && (
                <path
                  d={`M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${y + h}Z`}
                  fill={color}
                  opacity={hover == null || hover === i ? 1 : 0.45}
                />
              )}
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={plotH}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              />
              {i % step === 0 && (
                <text className="chart-axis" x={x + barW / 2} y={HEIGHT - 8} textAnchor="middle">
                  {p.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover != null && points[hover] && (
        <Tooltip x={PAD.left + hover * slot + slot / 2} width={width}>
          <strong>{points[hover].label}</strong>
          <span>
            <i style={{ background: color }} />
            <em>유효 시간</em>
            <b>{format(points[hover].value ?? 0)}</b>
          </span>
        </Tooltip>
      )}
    </div>
  );
}
