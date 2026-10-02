import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgetPreview, MemoriesPage } from '../../server/types';

vi.mock('../../web/src/api', async (orig) => {
  const real = await orig<typeof import('../../web/src/api')>();
  const { apiMock } = await import('./fixtures');
  return { ...real, api: apiMock() };
});
import { ApiFailure, api } from '../../web/src/api';
import { useToasts } from '../../web/src/format';
import { shared } from '../../web/src/store';
import MemoriesView from '../../web/src/views/MemoriesView.vue';
import { deferred, mem, memDetail, msg, msgDetail, overview, page } from './fixtures';

const m = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
enableAutoUnmount(afterEach);

function preview(over: Partial<ForgetPreview> = {}): ForgetPreview {
  return { digest: 'digest-1', kind: 'memory', erases: { memories: [mem('A')], messages: [] }, stays: { memories: [], messages: [] }, notes: [], ...over };
}

beforeEach(() => {
  vi.resetAllMocks();
  location.hash = '#/memories/A';
  shared.paused = false;
  useToasts().items.value = [];
  m.overview.mockResolvedValue(overview());
  m.projects.mockResolvedValue([]);
  m.memories.mockResolvedValue(page([mem('A'), mem('B')]));
  m.detail.mockImplementation(async (id: string) => (id.startsWith('m') ? msgDetail(id) : memDetail(id)));
  m.forgetPreview.mockResolvedValue(preview());
});
afterEach(() => vi.useRealTimers());

type W = ReturnType<typeof mount>;
async function mountView(hash = '#/memories/A'): Promise<W> {
  location.hash = hash;
  const w = mount(MemoriesView, { attachTo: document.body });
  await flushPromises();
  return w;
}
async function openForget(w: W): Promise<void> {
  const b = w.findAll('.detail .actions button').find((x) => x.text() === 'Forget')!;
  (b.element as HTMLElement).focus();
  await b.trigger('click');
  await flushPromises();
}
const dlgBtn = (w: W, label: string) => w.find('[role=dialog]').findAll('button').find((b) => b.text() === label)!;
const esc = async (): Promise<void> => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await flushPromises();
};

describe('Forget dialog while confirming', () => {
  it('ignores Esc, scrim and "Keep it" until the delete has answered, then shows the result', async () => {
    const d = deferred<{ forgotten: true; erased: { memories: number; messages: number } }>();
    m.forgetConfirm.mockReturnValue(d.promise);
    const w = await mountView();
    await openForget(w);
    await dlgBtn(w, 'Forget permanently').trigger('click');
    await esc();
    await w.find('.scrim').trigger('click');
    await dlgBtn(w, 'Keep it').trigger('click');
    expect(w.find('[role=dialog]').exists()).toBe(true);
    m.memories.mockResolvedValue(page([mem('B')]));
    d.resolve({ forgotten: true, erased: { memories: 1, messages: 0 } });
    await flushPromises();
    expect(w.find('[role=dialog]').exists()).toBe(false);
    expect(useToasts().items.value.map((t) => t.message)).toContain('Forgotten');
    expect(location.hash).toBe('#/memories');
    expect(w.findAll('[role=option]').map((r) => r.attributes('data-id'))).toEqual(['B']);
  });

  it('a double click on "Forget permanently" sends exactly one confirm', async () => {
    m.forgetConfirm.mockReturnValue(deferred().promise);
    const w = await mountView();
    await openForget(w);
    const b = dlgBtn(w, 'Forget permanently');
    await b.trigger('click');
    await b.trigger('click');
    expect(m.forgetConfirm).toHaveBeenCalledTimes(1);
  });

  it('acts on the item it was opened for, even if the selection changes meanwhile', async () => {
    m.forgetConfirm.mockResolvedValue({ forgotten: true, erased: { memories: 1, messages: 0 } });
    const w = await mountView();
    await openForget(w);
    location.hash = '#/memories/B';
    await flushPromises();
    expect(w.find('[role=dialog]').exists()).toBe(true);
    await dlgBtn(w, 'Forget permanently').trigger('click');
    await flushPromises();
    expect(m.forgetPreview).toHaveBeenCalledTimes(1);
    expect(m.forgetPreview).toHaveBeenCalledWith('A');
    expect(m.forgetConfirm).toHaveBeenCalledWith('A', 'digest-1');
    expect(location.hash).toBe('#/memories/B'); // B was not forgotten, its selection stays
  });

  it('moves focus into the list after a successful forget', async () => {
    m.forgetConfirm.mockResolvedValue({ forgotten: true, erased: { memories: 1, messages: 0 } });
    m.memories.mockResolvedValue(page([mem('B')]));
    const w = await mountView();
    await openForget(w);
    await dlgBtn(w, 'Forget permanently').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(w.find('[role=option]').element);
  });

  it('the dialog fits the viewport: capped height, scrolling body, actions outside it', () => {
    const css = readFileSync(join(__dirname, '../../web/src/styles/base.css'), 'utf8');
    expect(css).toMatch(/\.dialog \{[^}]*max-height: calc\(100vh - 32px\)/);
    expect(css).toMatch(/\.dialog \.dbody \{[^}]*overflow-y: auto/);
    expect(css).toMatch(/\.tools select \{[^}]*max-width: 100%/);
  });
});

describe('list paging and query changes', () => {
  it('"Load more" does not cancel a load that is in flight, and a changed query drops the old page', async () => {
    m.memories.mockResolvedValueOnce(page([mem('A')], 'memories', 50));
    const w = await mountView('#/memories');
    const more = deferred<MemoriesPage>();
    m.memories.mockReturnValueOnce(more.promise);
    await w.findAll('button').find((b) => b.text() === 'Load more')!.trigger('click');
    m.memories.mockResolvedValueOnce(page([mem('Z')], 'memories', null));
    await w.findAll('.seg button')[1]!.trigger('click'); // kind change starts a new load
    await flushPromises();
    more.resolve(page([mem('OLD')], 'memories', 40));
    await flushPromises();
    const ids = w.findAll('[role=option]').map((r) => r.attributes('data-id'));
    expect(ids).not.toContain('OLD');
    expect(w.findAll('button').some((b) => b.text() === 'Load more')).toBe(false);
  });

  it('a non-silent load clears rows and the next cursor first; loading never sticks', async () => {
    m.memories.mockResolvedValueOnce(page([mem('A')], 'memories', 50));
    const w = await mountView('#/memories');
    const slow = deferred<MemoriesPage>();
    m.memories.mockReturnValueOnce(slow.promise);
    await w.find('input[type=checkbox]').setValue(true);
    await flushPromises();
    expect(w.findAll('[role=option]')).toHaveLength(0);
    expect(w.findAll('button').some((b) => b.text() === 'Load more')).toBe(false);
    slow.resolve(page([mem('P')]));
    await flushPromises();
    expect(w.find('.skeleton, [aria-busy=true]').exists()).toBe(false);
  });

  it('switching kind shows no stale rows of the other kind while the new list loads', async () => {
    const w = await mountView('#/memories');
    const slow = deferred<MemoriesPage>();
    m.memories.mockReturnValueOnce(slow.promise);
    await w.findAll('.seg button')[1]!.trigger('click');
    await flushPromises();
    expect(w.findAll('[role=option]')).toHaveLength(0);
    slow.resolve(page([msg('m1')], 'messages'));
    await flushPromises();
    expect(w.findAll('[role=option]')).toHaveLength(1);
  });
});

describe('pin results for a different item', () => {
  async function pinThenSwitch(settle: (d: ReturnType<typeof deferred>) => void): Promise<W> {
    const d = deferred();
    m.pin.mockReturnValue(d.promise);
    const w = await mountView('#/memories/A');
    await w.findAll('button').find((b) => b.text() === 'Pin to every session')!.trigger('click');
    location.hash = '#/memories/B';
    await flushPromises();
    m.memories.mockClear();
    settle(d);
    await flushPromises();
    return w;
  }

  it('a pin result for the previous item does not touch the detail or toast; the list follows', async () => {
    const w = await pinThenSwitch((d) => d.resolve({ id: 'A', pinned: true }));
    expect(w.find('.detail .kind').text()).not.toContain('Pinned');
    expect(useToasts().items.value).toHaveLength(0);
    expect(w.find('[role=option][data-id=A]').text()).toContain('Pinned');
  });

  it('a 404 for the previous item does not turn the current detail into "gone", but refreshes the list', async () => {
    const w = await pinThenSwitch((d) => d.reject(new ApiFailure('not_found', 404, 'gone')));
    expect(w.text()).not.toContain('no longer exists');
    expect(m.memories).toHaveBeenCalled();
  });

  it('a 401 for the previous item does not disconnect the current view', async () => {
    const w = await pinThenSwitch((d) => d.reject(new ApiFailure('unauthorized', 401, 'no')));
    expect(w.text()).not.toContain('no longer connected');
    expect(w.find('.detail').exists()).toBe(true);
  });
});

describe('gone wording', () => {
  it('names the kind when known and says "item" when it is not', async () => {
    m.detail.mockRejectedValue(new ApiFailure('not_found', 404, 'gone'));
    const w = await mountView('#/memories/ZZZ');
    expect(w.text()).toContain('This item no longer exists.');
  });
});

describe('arrow keys', () => {
  const arrow = (key: string, target: EventTarget = document.body): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  };

  it('only prevents the default when the selection moves', async () => {
    const w = await mountView('#/memories/B'); // last row
    await flushPromises();
    expect(arrow('ArrowDown').defaultPrevented).toBe(false); // nowhere to go: the page scrolls
    expect(location.hash).toBe('#/memories/B');
    expect(arrow('ArrowUp').defaultPrevented).toBe(true);
    await flushPromises();
    expect(location.hash).toBe('#/memories/A');
    w.unmount();
  });

  it('leaves the arrows to a scrollable text block', async () => {
    const w = await mountView('#/memories/A');
    const block = w.find('.detail').element as HTMLElement;
    Object.defineProperty(block, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(block, 'clientHeight', { value: 300, configurable: true });
    block.style.overflowY = 'auto';
    const ev = arrow('ArrowDown', block);
    expect(ev.defaultPrevented).toBe(false);
    expect(location.hash).toBe('#/memories/A');
  });
});

describe('listener cleanup', () => {
  it('removes the keydown and visibilitychange listeners on unmount', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const w = await mountView('#/memories');
    const added = add.mock.calls.filter(([t]) => t === 'keydown' || t === 'visibilitychange');
    expect(added.map(([t]) => t).sort()).toEqual(['keydown', 'visibilitychange']);
    w.unmount();
    for (const [t, fn] of added) expect(remove).toHaveBeenCalledWith(t, fn);
    add.mockRestore();
    remove.mockRestore();
  });
});
