import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryLine, Overview } from '../../server/types';

vi.mock('../../web/src/api', async (orig) => {
  const real = await orig<typeof import('../../web/src/api')>();
  return {
    ...real,
    api: { overview: vi.fn(), projects: vi.fn(), pause: vi.fn(), resume: vi.fn() },
  };
});
import { ApiFailure, api } from '../../web/src/api';
import ActivityChart from '../../web/src/components/ActivityChart.vue';
import App from '../../web/src/App.vue';
import { shared } from '../../web/src/store';
import OverviewView from '../../web/src/views/OverviewView.vue';

const mocked = api as unknown as Record<'overview' | 'projects' | 'pause' | 'resume', ReturnType<typeof vi.fn>>;

function line(over: Partial<MemoryLine> = {}): MemoryLine {
  return {
    id: '01A', statement: 'The user prefers vitest.', subject: 'user', predicate: 'prefers', object: 'vitest', project: null, since: '2026-09-28T11:02:00Z', until: null,
    status: 'active', pinned: false, used: 3, sources: 2, flags: [], seq: null, ...over,
  };
}
function overview(over: Partial<Overview> = {}): Overview {
  const activity = Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.UTC(2026, 8, 19 + i)).toISOString().slice(0, 10), count: i === 9 ? 204 : i % 2 }));
  return {
    version: '0.1.0', paused: false, project: null,
    stats: {
      db_path: '/x', db_bytes: 1, schema_version: 3, events: 2000, sessions: 35, unconsolidated_sessions: 0,
      claims: { active: 4, superseded: 1, retracted: 0 }, oldest_event: null, newest_event: null, flagged: { instruction_like: 0, secret_redacted: 0, truncated: 0 },
    },
    profile: [line(), line({ id: '01B', statement: 'Pinned one', pinned: true })],
    activity, semantic: { enabled: false, embedded: 0 },
    ...over,
  };
}

enableAutoUnmount(afterEach);
beforeEach(() => {
  vi.resetAllMocks();
  mocked.projects.mockResolvedValue(['nova']);
});

describe('Overview', () => {
  it('renders statements as text, never as markup', async () => {
    mocked.overview.mockResolvedValue(overview({ profile: [line({ statement: '<img src=x onerror=alert(1)>' })] }));
    const w = mount(OverviewView);
    await flushPromises();
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('q').text()).toBe('<img src=x onerror=alert(1)>');
  });

  it('shows pinned chip or usage, and the sources line', async () => {
    mocked.overview.mockResolvedValue(overview());
    const w = mount(OverviewView);
    await flushPromises();
    const text = w.text();
    expect(text).toContain('Used 3×');
    expect(text).toContain('Pinned');
    expect(text).toContain('All projects, since 28 Sep 2026, from 2 messages');
  });

  it('hides the usage chip for memories that were never used', async () => {
    mocked.overview.mockResolvedValue(overview({ profile: [line({ used: 0 })] }));
    const w = mount(OverviewView);
    await flushPromises();
    expect(w.text()).not.toContain('Used 0');
    expect(w.find('li .chip').exists()).toBe(false);
  });

  it('explains an empty profile and points to /consolidate', async () => {
    mocked.overview.mockResolvedValue(overview({ profile: [] }));
    const w = mount(OverviewView);
    await flushPromises();
    expect(w.text()).toContain("Claude isn't told anything yet. Memories appear here after consolidation.");
    expect(w.text()).toContain('/consolidate');
  });

  it('with an empty profile and waiting sessions, the /consolidate command appears only once', async () => {
    const o = overview({ profile: [] });
    o.stats.unconsolidated_sessions = 5;
    mocked.overview.mockResolvedValue(o);
    const w = mount(OverviewView);
    await flushPromises();
    expect(w.findAll('code').filter((c) => c.text() === '/consolidate')).toHaveLength(1);
    expect(w.find('.profile').text()).toContain("Claude isn't told anything yet");
    expect(w.find('.profile').text()).not.toContain('/consolidate');
    expect(w.find('.notice').text()).toContain('/consolidate');
  });

  it('shows the consolidation notice only when sessions are waiting', async () => {
    mocked.overview.mockResolvedValue(overview());
    let w = mount(OverviewView);
    await flushPromises();
    expect(w.find('.notice').exists()).toBe(false);
    const o = overview();
    o.stats.unconsolidated_sessions = 32;
    mocked.overview.mockResolvedValue(o);
    w = mount(OverviewView);
    await flushPromises();
    expect(w.find('.notice').text()).toContain('32 sessions are waiting to be turned into memories');
  });

  it('pause button calls api.pause and updates', async () => {
    mocked.overview.mockResolvedValue(overview());
    mocked.pause.mockImplementation(async () => {
      mocked.overview.mockResolvedValue(overview({ paused: true })); // what the server reports from now on
      return { paused: true };
    });
    const w = mount(OverviewView);
    await flushPromises();
    expect(w.text()).toContain('Capturing new messages');
    await w.findAll('button').find((b) => b.text() === 'Pause capture')!.trigger('click');
    await flushPromises();
    expect(mocked.pause).toHaveBeenCalled();
    expect(w.text()).toContain('Capture is paused');
    expect(w.text()).toContain('Resume capture');
    expect(shared.paused).toBe(true); // the Memories view reads the same flag
  });

  it('labels the project selector truthfully and reloads for a project', async () => {
    mocked.overview.mockResolvedValue(overview());
    const w = mount(OverviewView);
    await flushPromises();
    const opts = w.findAll('select option').map((o) => o.text());
    expect(opts).toEqual(['Any session', 'Sessions in nova']);
    await w.find('select').setValue('nova');
    await flushPromises();
    expect(mocked.overview).toHaveBeenLastCalledWith('nova');
  });

  it('401 renders the disconnected page', async () => {
    mocked.overview.mockRejectedValue(new ApiFailure('unauthorized', 401, 'no'));
    const w = mount(OverviewView);
    await flushPromises();
    expect(w.text()).toContain('This page is no longer connected.');
    expect(w.text()).toContain('engram ui');
  });

  it('503 shows the busy message with a retry that reloads', async () => {
    mocked.overview.mockRejectedValueOnce(new ApiFailure('busy', 503, 'busy'));
    const w = mount(OverviewView);
    await flushPromises();
    expect(w.text()).toContain('engram is busy writing. Try again.');
    mocked.overview.mockResolvedValue(overview());
    await w.findAll('button').find((b) => b.text() === 'Retry')!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('The user prefers vitest.');
  });

  it('refetches when the tab becomes visible', async () => {
    mocked.overview.mockResolvedValue(overview());
    mount(OverviewView);
    await flushPromises();
    const before = mocked.overview.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(mocked.overview.mock.calls.length).toBe(before + 1);
  });

  it('App without a token is the disconnected page; the rail counts memories', async () => {
    const off = mount(App, { props: { connected: false } });
    expect(off.text()).toContain('This page is no longer connected.');
    mocked.overview.mockResolvedValue(overview());
    const on = mount(App, { props: { connected: true } });
    await flushPromises();
    expect(on.find('.nav').text()).toContain('Memories 4');
    expect(on.text()).toContain('Local only. Nothing leaves this machine.');
  });
});

describe('ActivityChart', () => {
  const days = (counts: number[]) => counts.map((count, i) => ({ day: new Date(Date.UTC(2026, 8, 19 + i)).toISOString().slice(0, 10), count }));
  it('draws one bar per non-zero day and none for zero days', () => {
    const full = mount(ActivityChart, { props: { activity: days(Array(14).fill(5)) } });
    expect(full.findAll('rect.bar')).toHaveLength(14);
    const some = mount(ActivityChart, { props: { activity: days([0, 3, 0, 9, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2]) } });
    expect(some.findAll('rect.bar')).toHaveLength(4);
  });
  it('names the busiest day in its label', () => {
    const w = mount(ActivityChart, { props: { activity: days([3, 0, 41, 67, 12, 0, 0, 88, 156, 204, 97, 31, 142, 119]) } });
    const label = w.find('svg').attributes('aria-label')!;
    expect(label).toContain('Busiest day 28 Sep with 204');
    expect(label).toContain('19 Sep to 2 Oct');
    expect(w.find('svg').attributes('role')).toBe('group');
  });
  it('shows a tooltip on focus', async () => {
    const w = mount(ActivityChart, { props: { activity: days([0, 204]) } });
    await w.find('rect.bar').trigger('focus');
    expect(w.find('.tip').text()).toBe('20 Sep: 204 captured');
  });
  it('handles no data', () => {
    const w = mount(ActivityChart, { props: { activity: days(Array(14).fill(0)) } });
    expect(w.findAll('rect.bar')).toHaveLength(0);
    expect(w.find('svg').attributes('aria-label')).toContain('No messages captured');
  });
});

describe('Overview stale responses', () => {
  function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('an older response that arrives last never overwrites the newer one', async () => {
    const a = deferred<Overview>();
    const b = deferred<Overview>();
    mocked.overview.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const w = mount(OverviewView);
    await flushPromises();
    await w.find('#ov-project').setValue('nova');
    b.resolve(overview({ profile: [line({ statement: 'newer answer' })] }));
    await flushPromises();
    a.resolve(overview({ profile: [line({ statement: 'older answer' })] }));
    await flushPromises();
    expect(w.text()).toContain('newer answer');
    expect(w.text()).not.toContain('older answer');
  });

  it('an older failure that arrives last does not replace the newer data with an error', async () => {
    const a = deferred<Overview>();
    const b = deferred<Overview>();
    mocked.overview.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const w = mount(OverviewView);
    await flushPromises();
    await w.find('#ov-project').setValue('nova');
    b.resolve(overview({ profile: [line({ statement: 'newer answer' })] }));
    await flushPromises();
    a.reject(new ApiFailure('internal', 500, 'boom'));
    await flushPromises();
    expect(w.text()).toContain('newer answer');
    expect(w.text()).not.toContain('Retry');
  });

  it('a pause result cannot be overwritten by an older overview response still in flight', async () => {
    const slow = deferred<Overview>();
    mocked.overview.mockResolvedValueOnce(overview());
    const w = mount(OverviewView);
    await flushPromises();
    mocked.overview.mockReturnValueOnce(slow.promise); // an older refresh, still pending
    document.dispatchEvent(new Event('visibilitychange'));
    mocked.pause.mockImplementation(async () => {
      mocked.overview.mockResolvedValue(overview({ paused: true }));
      return { paused: true };
    });
    await w.findAll('button').find((b) => b.text() === 'Pause capture')!.trigger('click');
    await flushPromises();
    slow.resolve(overview({ paused: false })); // the stale answer arrives last
    await flushPromises();
    expect(w.text()).toContain('Capture is paused');
    expect(shared.paused).toBe(true);
  });

  it('removes its visibilitychange listener on unmount', async () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    mocked.overview.mockResolvedValue(overview());
    const w = mount(OverviewView);
    await flushPromises();
    w.unmount();
    expect(remove.mock.calls.some(([t]) => t === 'visibilitychange')).toBe(true);
    remove.mockRestore();
  });
});
