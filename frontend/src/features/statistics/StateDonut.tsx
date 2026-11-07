import { useState } from 'react';
import type { Metrics } from '../../api/client';
import { formatDuration } from '../../components/ui';
import { summaryView } from '../history/format';

/** 타임라인·요약 막대와 같은 상태 색. 색만으로 구분하지 않도록 범례에 이름·시간·비율을 함께 씀 */
export const STATE_COLORS = { normal: '#22c55e', caution: '#f59e0b', high: '#ef4444' } as const;

const SIZE = 132;
const STROKE = 18;
/** 호버한 조각은 이만큼 두꺼워짐. 반지름을 그만큼 줄여 SVG 밖으로 잘리지 않게 함 */
const HOVER_EXTRA = 4;
const RADIUS = (SIZE - STROKE - HOVER_EXTRA) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** 조각 사이 2px 틈 (바탕색) */
const GAP = 2;

const percent = (ms: number, total: number) => `${((ms / total) * 100).toFixed(1)}%`;

/**
 * 유효 측정 시간 중 정상·주의·높음이 차지하는 비율 도넛. 가운데는 정상 비율.
 * 판단 불가 시간은 유효 시간이 아니라서 들어가지 않음.
 */
export function StateDonut({ title, metrics }: { title: string; metrics: Metrics }) {
  const { total, parts } = summaryView(metrics);
  const [hover, setHover] = useState<string | null>(null);
  const shown = parts.filter((part) => part.ms > 0);
  let offset = 0;
  const arcs = shown.map((part) => {
    const length = (part.ms / total) * CIRCUMFERENCE;
    const arc = {
      ...part,
      dash: Math.max(0.5, length - (shown.length > 1 ? GAP : 0)),
      offset,
    };
    offset += length;
    return arc;
  });
  const active = hover ? parts.find((part) => part.key === hover) : undefined;

  return (
    <figure className="state-donut">
      <figcaption>{title}</figcaption>
      {total > 0 ? (
        <div className="state-donut-body">
          <div className="state-donut-chart">
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              role="img"
              aria-label={`${title} 자세 상태 분포: ${parts
                .map((part) => `${part.label} ${percent(part.ms, total)}`)
                .join(', ')}`}
            >
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke="var(--color-soft)"
                strokeWidth={STROKE}
              />
              <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
                {arcs.map((arc) => (
                  <circle
                    key={arc.key}
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={RADIUS}
                    fill="none"
                    stroke={STATE_COLORS[arc.key]}
                    strokeWidth={hover === arc.key ? STROKE + HOVER_EXTRA : STROKE}
                    strokeDasharray={`${arc.dash} ${CIRCUMFERENCE - arc.dash}`}
                    strokeDashoffset={-arc.offset}
                    opacity={hover && hover !== arc.key ? 0.45 : 1}
                    onMouseEnter={() => setHover(arc.key)}
                    onMouseLeave={() => setHover(null)}
                    style={{ cursor: 'default', transition: 'opacity 0.15s ease' }}
                  />
                ))}
              </g>
            </svg>
            <div className="state-donut-center" aria-hidden="true">
              {active ? (
                <>
                  <strong>{percent(active.ms, total)}</strong>
                  <span>{active.label}</span>
                </>
              ) : (
                <>
                  <strong>{percent(parts[0].ms, total)}</strong>
                  <span>정상</span>
                </>
              )}
            </div>
          </div>
          <ul className="state-donut-legend">
            {parts.map((part) => (
              <li
                key={part.key}
                className={hover === part.key ? 'is-active' : undefined}
                onMouseEnter={() => setHover(part.key)}
                onMouseLeave={() => setHover(null)}
              >
                <i style={{ background: STATE_COLORS[part.key] }} aria-hidden="true" />
                <span>{part.label}</span>
                <strong>{percent(part.ms, total)}</strong>
                <em>{formatDuration(part.ms)}</em>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="service-note">유효 측정 시간이 없어요.</p>
      )}
    </figure>
  );
}
