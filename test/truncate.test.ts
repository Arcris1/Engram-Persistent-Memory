import { describe, expect, it } from 'vitest';
import { capSize } from '../src/core/truncate.js';

describe('capSize', () => {
  it('leaves text ≤ 32 KiB unchanged', () => {
    const s = 'a'.repeat(32 * 1024);
    expect(capSize(s)).toEqual({ text: s, truncated: false });
  });

  it('keeps the first 24 KiB and last 8 KiB of larger text', () => {
    const s = 'H'.repeat(24 * 1024) + 'M'.repeat(20 * 1024) + 'T'.repeat(8 * 1024);
    const r = capSize(s);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('H'.repeat(24 * 1024))).toBe(true);
    expect(r.text.endsWith('T'.repeat(8 * 1024))).toBe(true);
    expect(r.text).not.toContain('M');
  });

  it('never splits a multi-byte character', () => {
    const r = capSize('€'.repeat(15_000)); // 45,000 bytes
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain('�');
  });
});
