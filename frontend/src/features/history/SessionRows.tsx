import { Link } from '@tanstack/react-router';
import { Camera, ChevronRight, Headphones, Layers } from 'lucide-react';
import type { Session } from '../../api/client';
import { formatDate, modeLabel } from '../../components/ui';
import { sessionLength, statusLabel } from './format';

const modeIcon = { webcam: Camera, airpods: Headphones, combined: Layers } as const;

/** 세션 기록 목록의 행. 누르면 세션 상세로 이동합니다. */
export function SessionRows({ items }: { items: Session[] }) {
  return (
    <div className="service-list">
      {items.map((session) => {
        const ModeIcon = modeIcon[session.requested_mode];
        const completed = session.status === 'completed';
        return (
          <Link
            key={session.id}
            to="/history/$sessionId"
            params={{ sessionId: session.id }}
            className="service-list-row history-row"
          >
            <span className="history-row-icon" aria-hidden="true">
              <ModeIcon size={18} />
            </span>
            <span className="history-row-main">
              <strong>{formatDate(session.started_at)}</strong>
              <span>
                {modeLabel[session.requested_mode]} · {sessionLength(session)}
              </span>
            </span>
            <span className={`history-chip ${completed ? 'is-done' : 'is-open'}`}>
              {statusLabel(session.status)}
            </span>
            <span
              className={`history-chip ${session.data_source === 'real' ? 'is-real' : 'is-test'}`}
            >
              {session.data_source === 'real' ? '실제' : '테스트'}
            </span>
            <ChevronRight size={18} className="history-row-arrow" aria-hidden="true" />
          </Link>
        );
      })}
    </div>
  );
}
