import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../web/src/api', async (orig) => {
  const real = await orig<typeof import('../../web/src/api')>();
  const { apiMock } = await import('./fixtures');
  return { ...real, api: apiMock() };
});
import { ApiFailure, api } from '../../web/src/api';
import ActivityChart from '../../web/src/components/ActivityChart.vue';
import App from '../../web/src/App.vue';
import { useToasts } from '../../web/src/format';
import { shared } from '../../web/src/store';
import MemoriesView from '../../web/src/views/MemoriesView.vue';
import { deferred, mem, memDetail, msg, msgDetail, overview, page } from './fixtures';

const m = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.resetAllMocks();
  location.hash = '#/memories';
  shared.paused = false;
  useToasts().items.value = [];
  m.overview.mockResolvedValue(overview());
  m.projects.mockResolvedValue([]);
  m.memories.mockResolvedValue(page([mem('A'), mem('B'), mem('C')]));
  m.detail.mockImplementation(async (id: string) => (id.startsWith('m') ? msgDetail(id) : memDetail(id)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.className = '';
});

async function mountView(hash = '#/memories'): Promise<ReturnType<typeof mount>> {
  location.hash = hash;
  const w = mount(MemoriesView, { attachTo: document.body });
  await flushPromises();
  return w;
}

describe('accessibility and copy (B14, B15)', () => {
  it('the chart is a group of labelled image bars', () => {
    const activity = Array.from({ length: 3 }, (_, i) => ({ day: `2026-09-${20 + i}`, count: i + 1 }));
    const w = mount(ActivityChart, { props: { activity } });
    expect(w.find('svg').attributes('role')).toBe('group');
    const bars = w.findAll('rect.bar');
    expect(bars).toHaveLength(3);
    for (const b of bars) {
      expect(b.attributes('role')).toBe('img');
      expect(b.attributes('aria-label')).toMatch(/captured/);
      expect(b.attributes('tabindex')).toBe('0');
    }
  });

  it('section headings in the detail pane are h2, never h3', async () => {
    const w = await mountView('#/memories/A');
    expect(w.find('.detail').findAll('h2').map((h) => h.text())).toContain('Where this came from');
    expect(w.find('.detail h3').exists()).toBe(false);
  });

  it('the document title follows the view', async () => {
    location.hash = '#/health';
    m.health.mockResolvedValue(null);
    const w = mount(App, { props: { connected: true }, attachTo: document.body });
    await flushPromises();
    expect(document.title).toBe('Health – engram');
    location.hash = '#/memories';
    await flushPromises();
    expect(document.title).toBe('Memories – engram');
    location.hash = '#/';
    await flushPromises();
    expect(document.title).toBe('Overview – engram');
    w.unmount();
  });

  it('a search says only the best 50 matches are shown', async () => {
    const w = await mountView();
    await w.find('[data-search]').setValue('vitest');
    expect(w.find('.hint').text()).toBe('Keyword search, showing up to 50 matches.');
  });

  it('a captured message without a project says "No project" in the detail too', async () => {
    const w = await mountView('#/memories/m1');
    expect(w.find('.detail').text()).toContain('No project');
  });
});

function viewport(desktop: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width') ? !desktop : false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
}
const arrow = (key: string): void => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};
const forgetOk = { forgotten: true, erased: { memories: 1, messages: 0 } } as const;
const preview = (id: string) => ({ digest: 'd', kind: 'memory', erases: { memories: [mem(id)], messages: [] }, stays: { memories: [], messages: [] }, notes: [] });

describe('auto-selection (B4)', () => {
  it('on desktop selects the first row without adding a history entry', async () => {
    viewport(true);
    const before = history.length;
    const w = await mountView('#/memories');
    expect(location.hash).toBe('#/memories/A');
    expect(history.length).toBe(before);
    expect(w.find('.detail blockquote').text()).toBe('Statement A');
  });

  it('on a narrow screen nothing is selected', async () => {
    viewport(false);
    const w = await mountView('#/memories');
    expect(location.hash).toBe('#/memories');
    expect(w.text()).toContain('Select a memory');
  });

  it('after a forget on desktop the next row is selected', async () => {
    viewport(true);
    m.forgetPreview.mockResolvedValue(preview('A'));
    m.forgetConfirm.mockResolvedValue(forgetOk);
    m.memories.mockResolvedValueOnce(page([mem('A'), mem('B'), mem('C')])).mockResolvedValue(page([mem('B'), mem('C')]));
    const w = await mountView('#/memories/A');
    await w.findAll('.detail .actions button').find((b) => b.text() === 'Forget')!.trigger('click');
    await flushPromises();
    await w.find('[role=dialog]').findAll('button').find((b) => b.text() === 'Forget permanently')!.trigger('click');
    await flushPromises();
    expect(location.hash).toBe('#/memories/B');
    expect(w.find('[aria-selected=true]').attributes('data-id')).toBe('B');
  });
});

describe('keyboard navigation (B8)', () => {
  it('arrows move focus with the selection, keep one tab stop, and add no history entries', async () => {
    const w = await mountView('#/memories/A');
    const before = history.length;
    arrow('ArrowDown');
    await flushPromises();
    arrow('ArrowDown');
    await flushPromises();
    const rows = w.findAll('[role=option]');
    expect(location.hash).toBe('#/memories/C');
    expect(document.activeElement).toBe(rows[2]!.element);
    expect(rows.map((r) => r.attributes('tabindex'))).toEqual(['-1', '-1', '0']);
    expect(rows[2]!.attributes('aria-selected')).toBe('true');
    expect(history.length).toBe(before);
  });

  it('with nothing selected the first row is the tab stop', async () => {
    const w = await mountView('#/memories');
    expect(w.findAll('[role=option]').map((r) => r.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
  });
});

describe('Load more failure (B9)', () => {
  it('shows an inline error with Retry, and Retry loads the page', async () => {
    m.memories.mockResolvedValueOnce(page([mem('A')], 'memories', 7));
    const w = await mountView('#/memories');
    m.memories.mockRejectedValueOnce(new ApiFailure('network', 0, 'x'));
    await w.find('.more button').trigger('click');
    await flushPromises();
    expect(w.find('.more [role=alert]').text()).toContain('Could not reach engram');
    expect(w.findAll('[role=option]')).toHaveLength(1);
    m.memories.mockResolvedValueOnce(page([mem('Z')], 'memories', null));
    const retry = w.find('.more button');
    expect(retry.text()).toBe('Retry');
    await retry.trigger('click');
    await flushPromises();
    expect(w.findAll('[role=option]')).toHaveLength(2);
    expect(w.find('.more').exists()).toBe(false);
  });
});

describe('Forget dialog while confirming (B10, B11)', () => {
  const openDialog = async (w: ReturnType<typeof mount>): Promise<void> => {
    await w.findAll('.detail .actions button').find((b) => b.text() === 'Forget')!.trigger('click');
    await flushPromises();
  };
  const dlg = (w: ReturnType<typeof mount>) => w.find('[role=dialog]');

  it('disables both buttons, says Forgetting…, is busy, locks and inerts the page; restores on close', async () => {
    m.forgetPreview.mockResolvedValue(preview('A'));
    const pending = deferred<typeof forgetOk>();
    m.forgetConfirm.mockReturnValue(pending.promise);
    const rail = document.body.appendChild(document.createElement('nav')); // stands in for the app rail, a sibling of the page
    rail.className = 'rail';
    const w = await mountView('#/memories/A');
    await openDialog(w);
    expect(document.documentElement.classList.contains('dialog-open')).toBe(true);
    expect(document.querySelector('.rail')!.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.ledger')!.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.scrim')!.hasAttribute('inert')).toBe(false);
    await dlg(w).findAll('button').find((b) => b.text() === 'Forget permanently')!.trigger('click');
    const buttons = dlg(w).findAll('button');
    expect(buttons.map((b) => b.text())).toEqual(['Keep it', 'Forgetting…']);
    expect(buttons.every((b) => b.attributes('disabled') !== undefined)).toBe(true);
    expect(dlg(w).attributes('aria-busy')).toBe('true');
    pending.resolve(forgetOk);
    await flushPromises();
    expect(w.find('[role=dialog]').exists()).toBe(false);
    expect(document.documentElement.classList.contains('dialog-open')).toBe(false);
    expect(document.querySelector('[inert]')).toBeNull();
    rail.remove();
  });

  it('a confirm that finishes after leaving the screen still toasts', async () => {
    m.forgetPreview.mockResolvedValue(preview('A'));
    const pending = deferred<typeof forgetOk>();
    m.forgetConfirm.mockReturnValue(pending.promise);
    const w = await mountView('#/memories/A');
    await openDialog(w);
    await dlg(w).findAll('button').find((b) => b.text() === 'Forget permanently')!.trigger('click');
    w.unmount(); // the route changed: the view and its dialog are gone
    expect(document.documentElement.classList.contains('dialog-open')).toBe(false);
    pending.resolve(forgetOk);
    await flushPromises();
    expect(useToasts().items.value.map((t) => t.message)).toContain('Forgotten');
    expect(m.overview).toHaveBeenCalled();
  });

  it('keeps rows paged in by hand after a forget instead of resetting to page 1', async () => {
    m.forgetPreview.mockResolvedValue(preview('A'));
    m.forgetConfirm.mockResolvedValue(forgetOk);
    m.memories.mockResolvedValueOnce(page([mem('A'), mem('B')], 'memories', 5)).mockResolvedValueOnce(page([mem('C'), mem('D')], 'memories', null));
    const w = await mountView('#/memories/A');
    await w.find('.more button').trigger('click');
    await flushPromises();
    const calls = m.memories.mock.calls.length;
    await openDialog(w);
    await dlg(w).findAll('button').find((b) => b.text() === 'Forget permanently')!.trigger('click');
    await flushPromises();
    expect(w.findAll('[role=option]').map((r) => r.attributes('data-id'))).toEqual(['B', 'C', 'D']);
    expect(m.memories.mock.calls.length).toBe(calls); // no reload of page 1
  });
});

describe('scrolling and CSS (B12)', () => {
  it('uses auto scrolling when reduced motion is requested', async () => {
    const { scrollBehavior } = await import('../../web/src/motion');
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    expect(scrollBehavior()).toBe('auto');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(scrollBehavior()).toBe('smooth');
  });

  it('rows get an inset focus ring, the detail pane scrolls inside itself, and checkboxes use the accent', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '../../web/src/styles/base.css'), 'utf8');
    expect(css).toMatch(/\.row:focus-visible \{[^}]*outline-offset: -2px/);
    expect(css).toMatch(/\.detail \{[^}]*max-height: calc\(100vh - 32px\)[^}]*overflow: auto/);
    expect(css).toMatch(/input\[type=checkbox\][^{]*\{[^}]*accent-color: var\(--accent\)/);
    expect(css).not.toMatch(/\.dialog \.actions \{ flex: none; padding-top/);
  });
});
