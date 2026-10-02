import { describe, expect, it } from 'vitest';
import { useLatest } from '../../web/src/latest';

describe('useLatest', () => {
  it('only the newest call is current', () => {
    const next = useLatest();
    const a = next();
    expect(a()).toBe(true);
    const b = next();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });
});
