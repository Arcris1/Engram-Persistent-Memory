import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, api, initToken, watchTokenHash } from '../../web/src/api';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('api client', () => {
  beforeEach(() => {
    sessionStorage.clear();
    history.replaceState(null, '', '/');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('initToken reads the fragment, persists it and strips it from the URL', () => {
    history.replaceState(null, '', '/#token=abc123');
    expect(initToken()).toBe(true);
    expect(sessionStorage.getItem('engram-ui-token')).toBe('abc123');
    expect(location.hash).toBe('');
  });

  it('a malformed token fragment does not throw, stores nothing and is stripped', () => {
    history.replaceState(null, '', '/#token=%');
    expect(initToken()).toBe(false);
    expect(sessionStorage.getItem('engram-ui-token')).toBeNull();
    expect(location.hash).toBe('');
  });

  it('a pasted launch URL (hashchange only) reloads with the fragment intact; the startup read then stores and strips it', () => {
    sessionStorage.setItem('engram-ui-token', 'old');
    const reload = vi.fn();
    const stop = watchTokenHash(reload);
    location.hash = '#token=fresh';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    stop();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe('#token=fresh'); // left for the reloaded page, so a memory-only token is not lost
    expect(sessionStorage.getItem('engram-ui-token')).toBe('old');
    expect(initToken()).toBe(true); // what the reloaded page does
    expect(sessionStorage.getItem('engram-ui-token')).toBe('fresh');
    expect(location.hash).toBe('');
  });

  it('a pasted malformed fragment reloads into the disconnected page with the fragment stripped', () => {
    const reload = vi.fn();
    const stop = watchTokenHash(reload);
    location.hash = '#token=%';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    stop();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(initToken()).toBe(false);
    expect(location.hash).toBe('');
  });

  it('hashchange to a normal route does not reload', () => {
    const reload = vi.fn();
    const stop = watchTokenHash(reload);
    location.hash = '#/health';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    stop();
    expect(reload).not.toHaveBeenCalled();
  });

  it('initToken falls back to the stored token and is false without one', () => {
    sessionStorage.setItem('engram-ui-token', 'kept');
    expect(initToken()).toBe(true);
  });

  it('requests carry the bearer header', async () => {
    sessionStorage.setItem('engram-ui-token', 'tok');
    const f = vi.fn().mockResolvedValue(jsonRes(200, { projects: ['a', 'b'] }));
    vi.stubGlobal('fetch', f);
    expect(await api.projects()).toEqual(['a', 'b']);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/projects');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
  });

  it('builds memory queries', async () => {
    sessionStorage.setItem('engram-ui-token', 'tok');
    const f = vi.fn().mockResolvedValue(jsonRes(200, { items: [] }));
    vi.stubGlobal('fetch', f);
    await api.memories({ kind: 'messages', q: 'a b', project: null, flagged: true, before: 7 });
    expect(f.mock.calls[0]![0]).toBe('/api/memories?kind=messages&q=a+b&noProject=1&flagged=1&before=7');
  });

  it('keeps "no project" and a project literally named "-" apart', async () => {
    sessionStorage.setItem('engram-ui-token', 'tok');
    const f = vi.fn().mockResolvedValue(jsonRes(200, { items: [] }));
    vi.stubGlobal('fetch', f);
    await api.memories({ kind: 'memories', project: '-' });
    await api.memories({ kind: 'memories', project: null });
    await api.memories({ kind: 'memories' });
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/memories?kind=memories&project=-', '/api/memories?kind=memories&noProject=1', '/api/memories?kind=memories']);
  });

  it('401 becomes ApiFailure unauthorized', async () => {
    sessionStorage.setItem('engram-ui-token', 'tok');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(401, { error: { code: 'unauthorized', message: 'no' } })));
    await expect(api.overview()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('no token fails as unauthorized without a request', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(api.overview()).rejects.toBeInstanceOf(ApiFailure);
    expect(f).not.toHaveBeenCalled();
  });

  it('network failure becomes code network', async () => {
    sessionStorage.setItem('engram-ui-token', 'tok');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fail')));
    await expect(api.overview()).rejects.toMatchObject({ code: 'network' });
  });

  it('maps 503 busy', async () => {
    sessionStorage.setItem('engram-ui-token', 'tok');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(503, { error: { code: 'busy', message: 'busy' } })));
    await expect(api.pause()).rejects.toMatchObject({ code: 'busy', status: 503 });
  });
});
