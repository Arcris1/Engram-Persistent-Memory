import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Health } from '../../server/types';

vi.mock('../../web/src/api', async (orig) => {
  const real = await orig<typeof import('../../web/src/api')>();
  const { apiMock } = await import('./fixtures');
  return { ...real, api: apiMock() };
});
import { ApiFailure, api } from '../../web/src/api';
import App from '../../web/src/App.vue';
import { useToasts } from '../../web/src/format';
import HealthView from '../../web/src/views/HealthView.vue';
import { deferred, overview } from './fixtures';

const m = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
enableAutoUnmount(afterEach);

function health(over: Partial<Health> = {}): Health {
  return {
    version: '0.6.0',
    paused: false,
    stats: overview().stats,
    hooks: [
      { event: 'SessionStart', label: 'When a session starts', ok: true, problem: null },
      { event: 'UserPromptSubmit', label: 'When you send a message', ok: true, problem: null },
      { event: 'Stop', label: 'When Claude replies', ok: true, problem: null },
    ],
    waiting: 3,
    memoryTools: { checked: true, ok: true, detail: 'engram:' },
    search: { semantic: false, embedded: 0 },
    hookErrors: { last24h: 0 },
    storage: { path: '/home/me/.engram/engram.db', bytes: 8 * 1024 * 1024, ownerOnly: true, newestBackup: '2026-10-02T12:55:00', schema: 3 },
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  useToasts().items.value = [];
  m.health.mockResolvedValue(health());
  m.overview.mockResolvedValue(overview());
});

async function mountView(): Promise<ReturnType<typeof mount>> {
  const w = mount(HealthView, { attachTo: document.body });
  await flushPromises();
  return w;
}
const panel = (w: ReturnType<typeof mount>, name: string): string => w.find(`section[aria-label="${name}"]`).text();

describe('Health', () => {
  it('renders the header and the three panels', async () => {
    const w = await mountView();
    expect(w.find('h1').text()).toBe('Health');
    expect(w.text()).toContain('Everything engram needs to capture and recall memories on this machine.');
    const cap = panel(w, 'Capture');
    expect(cap).toContain('When a session starts');
    expect(cap).toContain('When Claude replies');
    expect(w.findAll('.checks .good').map((e) => e.text())).toContain('Working');
    expect(cap).toContain('Messages waiting to be saved3');
    const rec = panel(w, 'Recall');
    expect(rec).toContain('Memory tools in Claude CodeWorking');
    expect(rec).toContain('Keywords only');
    expect(rec).toContain('Errors in the last 24 hoursNone');
    const sto = panel(w, 'Storage');
    expect(sto).toContain('/home/me/.engram/engram.db');
    expect(sto).toContain('8.0 MB');
    expect(sto).toContain('Only you');
    expect(sto).toContain('2 Oct 2026, 12:55');
    expect(sto).toContain('engram 0.6.0, schema 3');
  });

  it('a hook with a problem says what needs attention', async () => {
    m.health.mockResolvedValue(health({ hooks: [{ event: 'Stop', label: 'When Claude replies', ok: false, problem: 'not installed' }], memoryTools: { checked: true, ok: false, detail: 'not registered' }, hookErrors: { last24h: 4 } }));
    const w = await mountView();
    expect(panel(w, 'Capture')).toContain('When Claude repliesNeeds attention: not installed');
    expect(panel(w, 'Recall')).toContain('Needs attention: not registered');
    expect(panel(w, 'Recall')).toContain('Errors in the last 24 hours4');
    expect(w.find('.checks .bad').exists()).toBe(true);
  });

  it('an unchecked memory-tools row is muted, not red, and gives the reason when there is one', async () => {
    m.health.mockResolvedValue(health({ memoryTools: { checked: false, ok: false, detail: 'Claude Code did not answer.' } }));
    let w = await mountView();
    const rec = panel(w, 'Recall');
    expect(rec).toContain('Memory tools in Claude CodeNot checked');
    expect(rec).toContain('Claude Code did not answer.');
    expect(rec).not.toContain('Needs attention');
    expect(w.find('.checks .bad').exists()).toBe(false);
    m.health.mockResolvedValue(health({ memoryTools: { checked: false, ok: false, detail: '' } }));
    w = await mountView();
    expect(panel(w, 'Recall')).toContain('Not checked');
    expect(panel(w, 'Recall')).not.toContain('did not answer');
  });

  it('warns when others on this computer can read the database, and shows "None found" for backups', async () => {
    m.health.mockResolvedValue(health({ storage: { path: '/x/engram.db', bytes: 10, ownerOnly: false, newestBackup: null, schema: 3 } }));
    const w = await mountView();
    const sto = panel(w, 'Storage');
    expect(sto).toContain('Others on this computer can read it');
    expect(sto).toContain('None found');
    expect(sto).toContain('10 B');
    expect(w.findAll('.checks .bad').map((e) => e.text())).toContain('Others on this computer can read it');
  });

  it('puts a long database path on its own line, and keeps short values inline', async () => {
    m.health.mockResolvedValue(health({ storage: { path: '/Users/someone/Library/Application Support/engram/data/engram.db', bytes: 1, ownerOnly: true, newestBackup: null, schema: 3 } }));
    const w = await mountView();
    const rows = w.findAll('section[aria-label="Storage"] li');
    expect(rows[0]!.classes()).toContain('long');
    expect(rows[1]!.classes()).not.toContain('long');
  });

  it('semantic off and on', async () => {
    let w = await mountView();
    expect(panel(w, 'Recall')).toContain('Search by meaning is off. It finds memories worded differently from your question. To turn it on, see “Semantic search” in the README.');
    expect(panel(w, 'Recall')).toContain('Keywords only');
    w.unmount();
    m.health.mockResolvedValue(health({ search: { semantic: true, embedded: 1200 } }));
    w = await mountView();
    expect(panel(w, 'Recall')).toContain('Keywords and meaning');
    expect(panel(w, 'Recall')).toContain('1,200 items indexed');
    expect(panel(w, 'Recall')).not.toContain('is off');
  });

  it('export shows the path with a Copy button and a toast', async () => {
    m.exportAll.mockResolvedValue({ path: '/home/me/engram-export-1.json' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const w = await mountView();
    await w.findAll('button').find((b) => b.text() === 'Export everything')!.trigger('click');
    await flushPromises();
    expect(w.find('.exported code').text()).toBe('/home/me/engram-export-1.json');
    expect(useToasts().items.value.map((t) => t.message)).toContain('Exported');
    await w.findAll('.exported button')[0]!.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('/home/me/engram-export-1.json');
    vi.unstubAllGlobals();
  });

  it('a failed export shows a message and no path', async () => {
    m.exportAll.mockRejectedValue(new ApiFailure('busy', 503, 'busy'));
    const w = await mountView();
    await w.findAll('button').find((b) => b.text() === 'Export everything')!.trigger('click');
    await flushPromises();
    expect(w.find('.exported').exists()).toBe(false);
    expect(useToasts().items.value.map((t) => t.message)).toContain('engram is busy writing. Try again.');
  });

  it('401 renders the disconnected page', async () => {
    m.health.mockRejectedValue(new ApiFailure('unauthorized', 401, 'no'));
    const w = await mountView();
    expect(w.text()).toContain('This page is no longer connected.');
  });

  it('shows a skeleton, then an error with Retry that reloads', async () => {
    const d = deferred<Health>();
    m.health.mockReturnValueOnce(d.promise);
    const w = mount(HealthView);
    await flushPromises();
    expect(w.find('.skeleton').exists()).toBe(true);
    d.reject(new ApiFailure('internal', 500, 'boom'));
    await flushPromises();
    expect(w.find('[role=alert]').exists()).toBe(true);
    m.health.mockResolvedValue(health());
    await w.findAll('button').find((b) => b.text() === 'Retry')!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Capture');
    expect(w.find('[role=alert]').exists()).toBe(false);
  });

  it('503 shows the busy message', async () => {
    m.health.mockRejectedValue(new ApiFailure('busy', 503, 'busy'));
    const w = await mountView();
    expect(w.text()).toContain('engram is busy writing. Try again.');
  });

  it('refetches when the tab becomes visible and removes its listener on unmount', async () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const w = await mountView();
    expect(m.health).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(m.health).toHaveBeenCalledTimes(2);
    w.unmount();
    expect(remove.mock.calls.some(([t]) => t === 'visibilitychange')).toBe(true);
    remove.mockRestore();
  });

  it('an older response that arrives last never overwrites the newer one', async () => {
    const a = deferred<Health>();
    m.health.mockReturnValueOnce(a.promise);
    const w = mount(HealthView);
    await flushPromises();
    m.health.mockResolvedValueOnce(health({ waiting: 42 }));
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    a.resolve(health({ waiting: 7 }));
    await flushPromises();
    expect(panel(w, 'Capture')).toContain('Messages waiting to be saved42');
  });

  it('the #/health route shows this view inside the app', async () => {
    location.hash = '#/health';
    sessionStorage.setItem('engram-ui-token', 'tok');
    const w = mount(App, { props: { connected: true } });
    await flushPromises();
    expect(w.find('main h1').text()).toBe('Health');
    location.hash = '';
  });
});
