import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSeoulDayEnd } from './useSeoulDayEnd';

describe('Seoul calendar rollover', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('advances at midnight while the page stays open and clears its timer on unmount', () => {
    vi.setSystemTime(new Date('2026-11-01T14:59:59.500Z'));
    const hook = renderHook(() => useSeoulDayEnd());
    expect(new Date(hook.result.current).toISOString()).toBe('2026-11-01T15:00:00.000Z');
    act(() => vi.advanceTimersByTime(600));
    expect(new Date(hook.result.current).toISOString()).toBe('2026-11-02T15:00:00.000Z');
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('catches up after a suspended tab regains focus', () => {
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    const hook = renderHook(() => useSeoulDayEnd());
    vi.setSystemTime(new Date('2026-11-02T01:00:00Z'));
    fireEvent.focus(window);
    expect(new Date(hook.result.current).toISOString()).toBe('2026-11-02T15:00:00.000Z');
  });

  it('catches up when a suspended document becomes visible', () => {
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    const hook = renderHook(() => useSeoulDayEnd());
    vi.setSystemTime(new Date('2026-11-02T01:00:00Z'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    expect(new Date(hook.result.current).toISOString()).toBe('2026-11-02T15:00:00.000Z');
  });
});
