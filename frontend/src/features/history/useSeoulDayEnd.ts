import { useEffect, useState } from 'react';

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;

function seoulDayEnd(now: number) {
  const local = new Date(now + SEOUL_OFFSET_MS);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - SEOUL_OFFSET_MS
  );
}

export function useSeoulDayEnd() {
  const [dayEnd, setDayEnd] = useState(() => seoulDayEnd(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = Date.now();
      const next = seoulDayEnd(now);
      setDayEnd(next);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(update, Math.max(1, next - now + 50));
    };
    const visible = () => {
      if (!document.hidden) update();
    };
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', visible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return dayEnd;
}
