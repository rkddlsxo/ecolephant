import type { Mode } from '@ecolephant/ai';
import { Bell, Clock, Target } from 'lucide-react';
import type { Metrics } from '../../api/client';
import { formatDuration, modeLabel } from '../../components/ui';
import { summaryView } from './format';

const tileIcons = { valid: Clock, normal: Target, alerts: Bell } as const;

/** 세션 상세의 측정 방식별 요약: 핵심 타일 3개 → 상태 분포 막대 → 나머지 지표 2열 표. */
export function SessionSummary({
  mode,
  metrics,
  title,
}: {
  mode: Mode;
  metrics: Metrics;
  /** 기본은 측정 방식 이름. 통계 상세처럼 출처·기준까지 구분할 때 바꿔 씀 */
  title?: string;
}) {
  const view = summaryView(metrics);
  return (
    <div className="session-summary-block">
      <h3>{title ?? modeLabel[mode]}</h3>
      <div className="stats-tiles session-summary-tiles">
        {view.tiles.map((tile) => {
          const Icon = tileIcons[tile.key];
          return (
            <div key={tile.key} className="stats-tile">
              <span>
                <Icon size={16} aria-hidden="true" />
                {tile.label}
              </span>
              <strong>{tile.value}</strong>
              {'caption' in tile && tile.caption && <small>{tile.caption}</small>}
            </div>
          );
        })}
      </div>
      <div className="session-summary-dist">
        <div className="session-bar" aria-hidden="true">
          {view.total > 0 &&
            view.parts.map(({ key, ms }) =>
              ms > 0 ? (
                <span
                  key={key}
                  className={`is-${key}`}
                  style={{ width: `${(ms / view.total) * 100}%` }}
                />
              ) : null,
            )}
        </div>
        <ul className="session-legend">
          {view.parts.map(({ key, label, ms }) => (
            <li key={key} className={`is-${key}`}>
              {label} {formatDuration(ms)}
            </li>
          ))}
        </ul>
      </div>
      <dl className="session-summary-details">
        {view.details.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
