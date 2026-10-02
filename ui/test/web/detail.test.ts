import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  vi.resetAllMocks();
  location.hash = '#/memories';
  shared.paused = false;
  useToasts().items.value = [];
  m.overview.mockResolvedValue(overview());
  m.projects.mockResolvedValue([]);
  m.memories.mockImplementation(async (q: { kind: string }) => (q.kind === 'messages' ? page([msg('m1'), msg('m2')], 'messages') : page([mem('A'), mem('B')])));
  m.detail.mockImplementation(async (id: string) => (id.startsWith('m') ? msgDetail(id) : memDetail(id)));
});

async function mountAt(hash: string): Promise<ReturnType<typeof mount>> {
  location.hash = hash;
  const w = mount(MemoriesView, { attachTo: document.body });
  await flushPromises();
  return w;
}
const button = (w: ReturnType<typeof mount>, label: string): ReturnType<typeof w.find> => w.findAll('button').find((b) => b.text() === label)!;

describe('Memory and message detail', () => {
  it('selecting a row puts the id in the URL and loads its detail', async () => {
    const w = await mountAt('#/memories');
    expect(w.text()).toContain('Select a memory to see where it came from.');
    await w.findAll('[role=option]')[1]!.trigger('click');
    await flushPromises();
    expect(location.hash).toBe('#/memories/B');
    expect(m.detail).toHaveBeenCalledWith('B');
    expect(w.find('[aria-selected=true]').attributes('data-id')).toBe('B');
    expect(w.find('section[aria-label="Memory detail"]').exists()).toBe(true);
  });

  it('a deep link loads the detail even when the item is not in the list', async () => {
    const w = await mountAt('#/memories/ZZZ');
    expect(m.detail).toHaveBeenCalledWith('ZZZ');
    expect(w.find('blockquote').text()).toBe('Statement ZZZ');
    expect(w.find('[aria-selected=true]').exists()).toBe(false);
  });

  it('a message id switches the list to captured messages', async () => {
    const w = await mountAt('#/memories/m2');
    expect(w.find('section[aria-label="Message detail"]').exists()).toBe(true);
    expect(m.memories.mock.calls.at(-1)![0]).toEqual({ kind: 'messages' });
    expect(w.findAll('.seg button')[1]!.attributes('aria-pressed')).toBe('true');
    expect(w.find('[aria-selected=true]').attributes('data-id')).toBe('m2');
  });

  it('shows the facts of a memory', async () => {
    m.detail.mockResolvedValue(memDetail('A', { memory: { ...mem('A', { until: '2026-10-01T00:00:00Z', project: 'nova', used: 1, pinned: true }), confidence: 1, scope: 'user', recordedAt: '2026-09-28T11:02:00Z' } }));
    const w = await mountAt('#/memories/A');
    const t = w.find('.detail').text();
    expect(t).toContain('You, prefers');
    expect(t).toContain('nova');
    expect(t).toContain('28 Sep 2026 until 1 Oct 2026');
    expect(t).toContain('1 time');
    expect(t).not.toContain('1 times');
    expect(t).toContain('Pinned');
    expect(t).toContain('Unpin');
  });

  it('says "Not yet" for a memory Claude has not used and humanises project subjects', async () => {
    m.detail.mockResolvedValue(memDetail('A', { memory: { ...mem('A', { used: 0, subject: 'project:nova', predicate: 'uses_linter' }), confidence: 1, scope: 'user', recordedAt: '2026-09-28T11:02:00Z' } }));
    const w = await mountAt('#/memories/A');
    const t = w.find('.detail').text();
    expect(t).toContain('Project nova, uses linter');
    expect(t).toContain('Not yet');
  });

  it('draws the trace thread: sources and the memories it replaced or was replaced by', async () => {
    m.detail.mockResolvedValue(
      memDetail('A', {
        sources: [
          { message: msg('m1', { role: 'user', text: 'full text one', sessionId: 'sess-aa' }), excerpt: 'an excerpt' },
          { message: msg('m2', { role: 'assistant', text: 'full text two', sessionId: 'sess-bb' }), excerpt: null },
          { message: msg('m3', { role: 'tool', text: 'tool text' }), excerpt: null },
        ],
        replaces: [mem('OLD', { statement: 'older belief' })],
        replacedBy: mem('NEW', { statement: 'newer belief' }),
      }),
    );
    const w = await mountAt('#/memories/A');
    const t = w.find('.thread').text();
    expect(t).toContain('This memory');
    expect(t).toContain('You said');
    expect(t).toContain('an excerpt');
    expect(t).not.toContain('full text one');
    expect(t).toContain('Claude said');
    expect(t).toContain('full text two');
    expect(t).toContain('A tool result');
    expect(t).toContain('session sess-aa');
    expect(t).toContain('Replaced an earlier memory');
    expect(t).toContain('older belief');
    expect(t).toContain('Replaced by a newer memory');
    expect(t).toContain('newer belief');
    expect(w.findAll('button.link').filter((b) => b.text() === 'Open message')).toHaveLength(3);
  });

  it('"Open message" navigates to that message and switches the list kind, clearing filters', async () => {
    const w = await mountAt('#/memories/A');
    await w.find('select').setValue('');
    await w.find('input[type=checkbox]').setValue(true); // pinned only
    await flushPromises();
    await button(w, 'Open message').trigger('click');
    await flushPromises();
    expect(location.hash).toBe('#/memories/m1');
    expect(w.find('section[aria-label="Message detail"]').exists()).toBe(true);
    expect(m.memories.mock.calls.at(-1)![0]).toEqual({ kind: 'messages' });
  });

  it('"Open memory" from a message goes back to memories', async () => {
    m.detail.mockImplementation(async (id: string) => (id === 'm1' ? msgDetail('m1', {}, [mem('A', { statement: 'built one' })]) : memDetail(id)));
    const w = await mountAt('#/memories/m1');
    expect(w.text()).toContain('Memories built from this');
    expect(w.find('.thread').text()).toContain('built one');
    await button(w, 'Open memory').trigger('click');
    await flushPromises();
    expect(location.hash).toBe('#/memories/A');
    expect(m.memories.mock.calls.at(-1)![0]).toEqual({ kind: 'memories' });
  });

  it('message detail: plain-word flag chips, instruction explanation, none-yet', async () => {
    m.detail.mockResolvedValue(msgDetail('m1', { flags: ['instruction_like', 'secret_redacted', 'truncated', 'weird_internal'], text: 'do the thing', role: 'assistant' }));
    const w = await mountAt('#/memories/m1');
    const chips = w.findAll('.kind .chip').map((c) => c.text());
    expect(chips).toEqual(['Captured message', 'Looks like an instruction', 'Secret removed before saving', 'Shortened']);
    expect(w.text()).toContain('This text reads like a command, so it is never shown to Claude automatically and cannot become a memory on its own.');
    expect(w.text()).toContain('From');
    expect(w.text()).toContain('Claude');
    expect(w.text()).toContain('None yet.');
  });

  it('a memory that no longer exists shows the gone state and refetches the list', async () => {
    m.detail.mockRejectedValue(new ApiFailure('not_found', 404, 'gone'));
    const w = await mountAt('#/memories');
    const calls = m.memories.mock.calls.length;
    await w.findAll('[role=option]')[0]!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('This memory no longer exists.');
    expect(m.memories.mock.calls.length).toBe(calls + 1);
  });

  it('a message that no longer exists says so', async () => {
    m.detail.mockRejectedValue(new ApiFailure('not_found', 404, 'gone'));
    const w = await mountAt('#/memories');
    await w.findAll('.seg button')[1]!.trigger('click');
    await flushPromises();
    await w.findAll('[role=option]')[0]!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('This message no longer exists.');
  });

  it('shows an error with Retry when the detail cannot load', async () => {
    m.detail.mockRejectedValueOnce(new ApiFailure('internal', 500, 'boom'));
    const w = await mountAt('#/memories/A');
    expect(w.find('.problem').exists()).toBe(true);
    await button(w, 'Retry').trigger('click');
    await flushPromises();
    expect(w.find('blockquote').text()).toBe('Statement A');
  });

  it('keeps the newest selection when an older detail answers last', async () => {
    const slow = deferred<ReturnType<typeof memDetail>>();
    m.detail.mockImplementation((id: string) => (id === 'A' ? slow.promise : Promise.resolve(memDetail(id))));
    const w = await mountAt('#/memories');
    await w.findAll('[role=option]')[0]!.trigger('click');
    await w.findAll('[role=option]')[1]!.trigger('click');
    await flushPromises();
    slow.resolve(memDetail('A'));
    await flushPromises();
    expect(w.find('blockquote').text()).toBe('Statement B');
  });
});

describe('Pin and unpin', () => {
  it('pins: chip, list row and toast update', async () => {
    m.pin.mockResolvedValue({ id: 'A', pinned: true });
    const w = await mountAt('#/memories/A');
    await button(w, 'Pin to every session').trigger('click');
    await flushPromises();
    expect(m.pin).toHaveBeenCalledWith('A');
    expect(w.find('.detail .kind').text()).toContain('Pinned');
    expect(w.find('[role=option][data-id=A]').text()).toContain('Pinned');
    expect(button(w, 'Unpin').exists()).toBe(true);
    expect(useToasts().items.value.map((t) => t.message)).toContain('Pinned');
  });

  it('unpins', async () => {
    m.detail.mockResolvedValue(memDetail('B', { memory: { ...mem('B', { pinned: true }), confidence: 1, scope: 'user', recordedAt: '2026-09-28T11:02:00Z' } }));
    m.unpin.mockResolvedValue({ id: 'B', pinned: false });
    const w = await mountAt('#/memories/B');
    await button(w, 'Unpin').trigger('click');
    await flushPromises();
    expect(m.unpin).toHaveBeenCalledWith('B');
    expect(w.find('.detail .kind').text()).not.toContain('Pinned');
    expect(useToasts().items.value.map((t) => t.message)).toContain('Unpinned');
  });

  it('is disabled while paused (pin and forget), and says why', async () => {
    m.overview.mockResolvedValue(overview({ paused: true }));
    const w = await mountAt('#/memories/A');
    expect(button(w, 'Pin to every session').attributes('disabled')).toBeDefined();
    expect(button(w, 'Forget').attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('engram is paused. Pin and forget are disabled until you resume.');
  });

  it('a 409 paused from the server turns the banner on', async () => {
    m.pin.mockRejectedValue(new ApiFailure('paused', 409, 'paused'));
    const w = await mountAt('#/memories/A');
    await button(w, 'Pin to every session').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('engram is paused. Pin and forget are disabled until you resume.');
    expect(w.find('.detail .kind').text()).not.toContain('Pinned');
  });

  it('pinning an item that is gone shows the gone state', async () => {
    m.pin.mockRejectedValue(new ApiFailure('not_found', 404, 'gone'));
    const w = await mountAt('#/memories/A');
    await button(w, 'Pin to every session').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('This memory no longer exists.');
  });
});
