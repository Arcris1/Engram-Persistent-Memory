import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../../web/src/format';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('toasts', () => {
  it('shows a message and removes it after 2.2 seconds', () => {
    const { show, items } = useToasts();
    show('Pinned');
    expect(items.value.map((t) => t.message)).toEqual(['Pinned']);
    vi.advanceTimersByTime(2199);
    expect(items.value).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(items.value).toHaveLength(0);
  });

  it('keeps several toasts apart, each expiring on its own', () => {
    const { show, items } = useToasts();
    show('one');
    vi.advanceTimersByTime(1000);
    show('two');
    expect(items.value.map((t) => t.message)).toEqual(['one', 'two']);
    expect(new Set(items.value.map((t) => t.id)).size).toBe(2);
    vi.advanceTimersByTime(1300);
    expect(items.value.map((t) => t.message)).toEqual(['two']);
    vi.advanceTimersByTime(1000);
    expect(items.value).toHaveLength(0);
  });

  it('shares one list between callers', () => {
    useToasts().show('shared');
    expect(useToasts().items.value.map((t) => t.message)).toContain('shared');
    vi.advanceTimersByTime(3000);
  });
});
