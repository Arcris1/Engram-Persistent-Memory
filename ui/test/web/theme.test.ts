import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function load(): Promise<typeof import('../../web/src/theme')> {
  vi.resetModules();
  return import('../../web/src/theme');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => vi.restoreAllMocks());

describe('theme', () => {
  it('starts as system with no data-theme attribute', async () => {
    const t = (await load()).useTheme();
    expect(t.mode.value).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('light and dark set data-theme and persist; system removes both', async () => {
    const t = (await load()).useTheme();
    t.set('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('engram-ui-theme')).toBe('dark');
    t.set('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('engram-ui-theme')).toBe('light');
    t.set('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('engram-ui-theme')).toBeNull();
  });

  it('restores the saved choice on load', async () => {
    localStorage.setItem('engram-ui-theme', 'dark');
    const t = (await load()).useTheme();
    expect(t.mode.value).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('ignores a garbage saved value', async () => {
    localStorage.setItem('engram-ui-theme', 'purple');
    expect((await load()).useTheme().mode.value).toBe('system');
  });

  it('still applies the choice when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const t = (await load()).useTheme();
    expect(t.mode.value).toBe('system');
    expect(() => t.set('dark')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(() => t.set('system')).not.toThrow();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
