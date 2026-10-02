import { defineComponent } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../web/src/api', async (orig) => {
  const real = await orig<typeof import('../../web/src/api')>();
  const { apiMock } = await import('./fixtures');
  return { ...real, api: apiMock() };
});
import { ApiFailure, api } from '../../web/src/api';
import { shared } from '../../web/src/store';
import { NO_PROJECT, useMemories } from '../../web/src/useMemories';
import MemoriesView from '../../web/src/views/MemoriesView.vue';
import { deferred, mem, memDetail, msg, overview, page } from './fixtures';

const m = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.resetAllMocks();
  location.hash = '#/memories';
  shared.paused = false;
  m.overview.mockResolvedValue(overview());
  m.projects.mockResolvedValue(['nova', 'atlas']);
  m.memories.mockResolvedValue(page([mem('A'), mem('B', { pinned: true }), mem('C', { status: 'superseded', flags: ['x'] })]));
  m.detail.mockImplementation(async (id: string) => memDetail(id));
});
afterEach(() => vi.useRealTimers());

async function mountView(): Promise<ReturnType<typeof mount>> {
  const w = mount(MemoriesView, { attachTo: document.body });
  await flushPromises();
  return w;
}
const lastQuery = (): unknown => m.memories.mock.calls.at(-1)![0];

describe('useMemories.remove', () => {
  function host(): ReturnType<typeof useMemories> {
    let api_!: ReturnType<typeof useMemories>;
    mount(defineComponent({ setup() { api_ = useMemories(); return () => null; } }));
    return api_;
  }
  it('moves the paging cursor to the last remaining row when the cursor row is forgotten', async () => {
    m.memories.mockResolvedValueOnce(page([mem('A', { seq: 90 }), mem('B', { seq: 80 })], 'memories', 80));
    const h = host();
    await h.load();
    m.memories.mockResolvedValueOnce(page([mem('C', { seq: 70 }), mem('D', { seq: 60 })], 'memories', 60));
    await h.more();
    h.remove(['D']);
    expect(h.next.value).toBe(70);
    m.memories.mockResolvedValueOnce(page([], 'memories', null));
    await h.more();
    expect(lastQuery()).toEqual({ kind: 'memories', before: 70 });
  });
  it('reloads page 1 when nothing remains', async () => {
    m.memories.mockResolvedValueOnce(page([mem('A', { seq: 90 })], 'memories', 90));
    const h = host();
    await h.load();
    m.memories.mockResolvedValueOnce(page([mem('Z', { seq: 99 })], 'memories', null));
    h.remove(['A']);
    await flushPromises();
    expect(h.items.value.map((r) => r.id)).toEqual(['Z']);
  });
});

describe('Memories list', () => {
  it('renders memory rows with chips, project and date', async () => {
    const w = await mountView();
    const rows = w.findAll('[role=option]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('Statement A');
    expect(rows[0]!.text()).toContain('All projects');
    expect(rows[0]!.text()).not.toContain('No project');
    expect(rows[0]!.text()).toContain('28 Sep 2026');
    expect(rows[1]!.text()).toContain('Pinned');
    expect(rows[2]!.text()).toContain('Replaced');
    expect(rows[2]!.text()).toContain('Flagged');
    expect(w.find('[role=listbox]').exists()).toBe(true);
    expect(w.find('.search, [data-search]').attributes('placeholder')).toBe('Search memories');
  });

  it('switches to captured messages: placeholder, rows with who, Flagged-only toggle', async () => {
    const w = await mountView();
    m.memories.mockResolvedValue(page([msg('x1', { role: 'assistant', text: 'hello there', project: 'nova', flags: ['truncated'] }), msg('x2', { role: 'tool' })], 'messages'));
    await w.findAll('.seg button')[1]!.trigger('click');
    await flushPromises();
    expect(lastQuery()).toEqual({ kind: 'messages' });
    const rows = w.findAll('[role=option]');
    expect(rows[0]!.classes()).toContain('event');
    expect(rows[0]!.text()).toContain('hello there');
    expect(rows[0]!.text()).toContain('Claude');
    expect(rows[0]!.text()).toContain('nova');
    expect(rows[0]!.text()).toContain('Flagged');
    expect(rows[1]!.text()).toContain('Tool');
    expect(rows[1]!.text()).toContain('No project');
    expect(rows[1]!.text()).not.toContain('All projects');
    expect(w.find('[data-search]').attributes('placeholder')).toBe('Search captured messages');
    expect(w.text()).toContain('Flagged only');
    expect(w.text()).not.toContain('Include replaced');
  });

  it('turns toggles and the project select into the right query', async () => {
    const w = await mountView();
    expect(lastQuery()).toEqual({ kind: 'memories' });
    await w.find('select').setValue('nova');
    await flushPromises();
    expect(lastQuery()).toEqual({ kind: 'memories', project: 'nova' });
    await w.find('select').setValue(NO_PROJECT);
    await flushPromises();
    expect(lastQuery()).toEqual({ kind: 'memories', project: null });
    const boxes = w.findAll('input[type=checkbox]');
    await boxes[0]!.setValue(true); // pinned only
    await flushPromises();
    expect(lastQuery()).toEqual({ kind: 'memories', project: null, pinned: true });
    await boxes[1]!.setValue(true); // include replaced
    await flushPromises();
    expect(lastQuery()).toEqual({ kind: 'memories', project: null, pinned: true, replaced: true });
    await w.find('select').setValue('');
    await flushPromises();
    expect(lastQuery()).toEqual({ kind: 'memories', pinned: true, replaced: true });
    await w.findAll('.seg button')[1]!.trigger('click');
    await flushPromises();
    await w.find('input[type=checkbox]').setValue(true); // flagged only
    await flushPromises();
    expect(lastQuery()).toEqual({ kind: 'messages', flagged: true });
  });

  it('loads more using next and appends without duplicates', async () => {
    m.memories.mockResolvedValueOnce(page([mem('A'), mem('B')], 'memories', 77));
    const w = await mountView();
    expect(w.findAll('[role=option]')).toHaveLength(2);
    m.memories.mockResolvedValueOnce(page([mem('B'), mem('C')], 'memories', null));
    const more = w.findAll('button').find((b) => b.text() === 'Load more')!;
    await more.trigger('click');
    await flushPromises();
    expect(lastQuery()).toEqual({ kind: 'memories', before: 77 });
    expect(w.findAll('[role=option]').map((r) => r.attributes('data-id'))).toEqual(['A', 'B', 'C']);
    expect(w.findAll('button').some((b) => b.text() === 'Load more')).toBe(false);
  });

  it('debounces search by 250 ms and shows the keyword note', async () => {
    vi.useFakeTimers();
    const w = mount(MemoriesView, { attachTo: document.body });
    await vi.advanceTimersByTimeAsync(0);
    const calls = m.memories.mock.calls.length;
    const input = w.find('[data-search]');
    await input.setValue('v');
    await vi.advanceTimersByTimeAsync(200);
    await input.setValue('vi');
    await vi.advanceTimersByTimeAsync(200);
    expect(m.memories.mock.calls.length).toBe(calls);
    expect(w.text()).toContain('Keyword search');
    await vi.advanceTimersByTimeAsync(60);
    expect(m.memories.mock.calls.length).toBe(calls + 1);
    expect(lastQuery()).toEqual({ kind: 'memories', q: 'vi' });
  });

  it('keeps the newest search results when an older request answers last', async () => {
    vi.useFakeTimers();
    const w = mount(MemoriesView, { attachTo: document.body });
    await vi.advanceTimersByTimeAsync(0);
    const older = deferred<ReturnType<typeof page>>();
    const newer = deferred<ReturnType<typeof page>>();
    m.memories.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await w.find('[data-search]').setValue('one');
    await vi.advanceTimersByTimeAsync(260);
    await w.find('[data-search]').setValue('two');
    await vi.advanceTimersByTimeAsync(260);
    newer.resolve(page([mem('N', { statement: 'newer result' })]));
    await vi.advanceTimersByTimeAsync(0);
    older.resolve(page([mem('O', { statement: 'older result' })]));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.text()).toContain('newer result');
    expect(w.text()).not.toContain('older result');
  });

  it('keeps the newer list when an older failure arrives last', async () => {
    const w = await mountView();
    const older = deferred<ReturnType<typeof page>>();
    m.memories.mockReturnValueOnce(older.promise).mockResolvedValueOnce(page([mem('N', { statement: 'newer result' })]));
    await w.find('select').setValue('nova');
    await w.find('select').setValue('atlas');
    await flushPromises();
    older.reject(new ApiFailure('internal', 500, 'boom'));
    await flushPromises();
    expect(w.text()).toContain('newer result');
    expect(w.text()).not.toContain('Retry');
  });
});

describe('Memories states', () => {
  it('no memories at all: hint and a button that shows captured messages', async () => {
    m.memories.mockResolvedValueOnce(page([]));
    const w = await mountView();
    expect(w.text()).toContain('No memories yet. Captured messages become memories after consolidation.');
    m.memories.mockResolvedValueOnce(page([msg('x1')], 'messages'));
    await w.findAll('button').find((b) => b.text() === 'Show captured messages')!.trigger('click');
    await flushPromises();
    expect(lastQuery()).toEqual({ kind: 'messages' });
    expect(w.findAll('[role=option]')).toHaveLength(1);
    expect(w.text()).not.toContain('No memories yet');
  });

  it('no results for a search says what to try', async () => {
    vi.useFakeTimers();
    const w = mount(MemoriesView, { attachTo: document.body });
    await vi.advanceTimersByTimeAsync(0);
    m.memories.mockResolvedValueOnce(page([]));
    await w.find('[data-search]').setValue('zebra');
    await vi.advanceTimersByTimeAsync(300);
    expect(w.text()).toContain('Nothing matches “zebra”. Try fewer words, or switch to captured messages.');
    expect(w.text()).not.toContain('No memories yet');
  });

  it('shows a skeleton while loading, then an error with Retry', async () => {
    const d = deferred<ReturnType<typeof page>>();
    m.memories.mockReturnValueOnce(d.promise);
    const w = mount(MemoriesView, { attachTo: document.body });
    await flushPromises();
    expect(w.find('.skeleton').exists()).toBe(true);
    d.reject(new ApiFailure('internal', 500, 'boom'));
    await flushPromises();
    expect(w.text()).toContain('Retry');
    await w.findAll('button').find((b) => b.text() === 'Retry')!.trigger('click');
    await flushPromises();
    expect(w.findAll('[role=option]')).toHaveLength(3);
  });

  it('shows the disconnected page on 401', async () => {
    m.memories.mockRejectedValueOnce(new ApiFailure('unauthorized', 401, 'no'));
    const w = mount(MemoriesView, { attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain('This page is no longer connected.');
  });

  it('shows the paused banner and keeps the rail count in the shared store', async () => {
    m.overview.mockResolvedValue(overview({ paused: true }));
    const w = await mountView();
    expect(w.text()).toContain('engram is paused. Pin and forget are disabled until you resume.');
    expect(shared.memories).toBe(4);
  });

  it('refetches when the tab becomes visible again', async () => {
    await mountView();
    const calls = m.memories.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(m.memories.mock.calls.length).toBe(calls + 1);
  });
});

describe('Memories hostile text', () => {
  it('renders script and img payloads as text in list and detail', async () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    m.memories.mockResolvedValue(page([mem('E', { statement: evil })]));
    const d = memDetail('E');
    if (d.kind === 'memory') d.memory.statement = evil;
    m.detail.mockResolvedValue(d);
    location.hash = '#/memories/E';
    const w = await mountView();
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('script').exists()).toBe(false);
    expect(w.find('.row .text').text()).toBe(evil);
    expect(w.find('blockquote').text()).toBe(evil);
  });

  it('renders message payloads as text', async () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    m.memories.mockResolvedValue(page([msg('E', { text: evil })], 'messages'));
    await mountView().then(async (w) => {
      await w.findAll('.seg button')[1]!.trigger('click');
      await flushPromises();
      expect(w.find('img').exists()).toBe(false);
      expect(w.find('script').exists()).toBe(false);
      expect(w.find('.row .text').text()).toBe(evil);
    });
  });

  it('copes with 100 KB of unbroken text, and the stylesheet wraps it', async () => {
    const big = 'x'.repeat(100_000);
    m.memories.mockResolvedValue(page([msg('L', { text: big.slice(0, 300), cut: true })], 'messages'));
    m.detail.mockResolvedValue({ kind: 'message', message: msg('L', { text: big }), built: [] });
    location.hash = '#/memories/L';
    const w = await mountView();
    expect(w.find('blockquote.body').text()).toHaveLength(100_000);
    const css = readFileSync(join(process.cwd(), 'web/src/styles/base.css'), 'utf8');
    expect(css).toMatch(/\.row \.text[^{]*\{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.detail blockquote\.body[^{]*\{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.detail blockquote\.body[^{]*\{[^}]*max-height/);
  });
});

describe('Memories keyboard', () => {
  it('"/" focuses the search box, but not while typing in a field', async () => {
    const w = await mountView();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(w.find('[data-search]').element);
    (w.find('select').element as HTMLElement).focus();
    const ev = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    w.find('select').element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(w.find('select').element);
  });

  it('arrow keys move the selection through the list and the URL follows', async () => {
    const w = await mountView();
    const press = async (key: string): Promise<void> => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await flushPromises();
    };
    await press('ArrowDown');
    expect(location.hash).toBe('#/memories/A');
    await press('ArrowDown');
    expect(location.hash).toBe('#/memories/B');
    expect(w.find('[aria-selected=true]').attributes('data-id')).toBe('B');
    await press('ArrowUp');
    await press('ArrowUp');
    expect(location.hash).toBe('#/memories/A');
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(location.hash).toBe('#/memories/C');
  });
});
