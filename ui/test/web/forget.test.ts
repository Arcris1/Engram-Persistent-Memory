import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgetPreview } from '../../server/types';

vi.mock('../../web/src/api', async (orig) => {
  const real = await orig<typeof import('../../web/src/api')>();
  const { apiMock } = await import('./fixtures');
  return { ...real, api: apiMock() };
});
import { ApiFailure, api } from '../../web/src/api';
import { useToasts } from '../../web/src/format';
import { shared } from '../../web/src/store';
import { confirmForget } from '../../web/src/forget';
import MemoriesView from '../../web/src/views/MemoriesView.vue';
import { deferred, mem, memDetail, msg, msgDetail, overview, page } from './fixtures';

const m = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
enableAutoUnmount(afterEach);

function preview(over: Partial<ForgetPreview> = {}): ForgetPreview {
  return { digest: 'digest-1', kind: 'memory', erases: { memories: [mem('A', { statement: 'The user prefers vitest.' })], messages: [] }, stays: { memories: [], messages: [msg('m1')] }, notes: ['The messages this memory was built from stay. Forget them too if the text itself must go.'], ...over };
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

async function open(): Promise<{ w: ReturnType<typeof mount>; forgetBtn: HTMLElement }> {
  const w = mount(MemoriesView, { attachTo: document.body });
  await flushPromises();
  const forgetBtn = w.findAll('.detail .actions button').find((b) => b.text() === 'Forget')!.element as HTMLElement;
  forgetBtn.focus();
  forgetBtn.click();
  await flushPromises();
  return { w, forgetBtn };
}
const dlg = (w: ReturnType<typeof mount>) => w.find('[role=dialog]');
const btn = (w: ReturnType<typeof mount>, label: string) => dlg(w).findAll('button').find((b) => b.text() === label)!;

describe('Forget dialog', () => {
  it('is an accessible modal labelled by its heading, previews on open, and focuses "Keep it"', async () => {
    const { w } = await open();
    const d = dlg(w);
    expect(d.attributes('aria-modal')).toBe('true');
    expect(w.find(`#${d.attributes('aria-labelledby')}`).text()).toBe('Forget this memory?');
    expect(m.forgetPreview).toHaveBeenCalledWith('A');
    expect(d.text()).toContain('This erases it from the database for good. It cannot be undone.');
    expect(d.text()).toContain('The user prefers vitest.');
    expect(d.text()).toContain('Its search entries');
    expect(d.text()).toContain('The messages this memory was built from stay.');
    expect(document.activeElement).toBe(btn(w, 'Keep it').element);
  });

  it('disables "Forget permanently" until the preview resolved', async () => {
    const d = deferred<ForgetPreview>();
    m.forgetPreview.mockReturnValue(d.promise);
    const { w } = await open();
    expect(btn(w, 'Forget permanently').attributes('disabled')).toBeDefined();
    d.resolve(preview());
    await flushPromises();
    expect(btn(w, 'Forget permanently').attributes('disabled')).toBeUndefined();
  });

  it('confirms with the preview digest, toasts, refreshes the list and clears the selection', async () => {
    m.forgetConfirm.mockResolvedValue({ forgotten: true, erased: { memories: 1, messages: 0 } });
    m.overview.mockResolvedValue(overview());
    const { w } = await open();
    const listCalls = m.memories.mock.calls.length;
    m.overview.mockResolvedValue(overview({ stats: { ...overview().stats, claims: { active: 3, superseded: 1, retracted: 0 } } }));
    await btn(w, 'Forget permanently').trigger('click');
    await flushPromises();
    expect(m.forgetConfirm).toHaveBeenCalledWith('A', 'digest-1');
    expect(useToasts().items.value.map((t) => t.message)).toContain('Forgotten');
    expect(w.find('[role=dialog]').exists()).toBe(false);
    expect(m.memories.mock.calls.length).toBe(listCalls + 1);
    expect(location.hash).toBe('#/memories');
    expect(w.text()).toContain('Select a memory to see where it came from.');
    expect(shared.memories).toBe(3);
  });

  it('when it changed: says so and previews again with the new digest', async () => {
    m.forgetConfirm.mockRejectedValueOnce(new ApiFailure('changed', 409, 'changed')).mockResolvedValue({ forgotten: true, erased: { memories: 1, messages: 0 } });
    const { w } = await open();
    m.forgetPreview.mockResolvedValue(preview({ digest: 'digest-2' }));
    await btn(w, 'Forget permanently').trigger('click');
    await flushPromises();
    expect(dlg(w).text()).toContain('This changed since you looked. Review it again.');
    expect(m.forgetPreview).toHaveBeenCalledTimes(2);
    await btn(w, 'Forget permanently').trigger('click');
    await flushPromises();
    expect(m.forgetConfirm).toHaveBeenLastCalledWith('A', 'digest-2');
  });

  it('when paused: shows the message and turns the banner on', async () => {
    m.forgetConfirm.mockRejectedValue(new ApiFailure('paused', 409, 'paused'));
    const { w } = await open();
    await btn(w, 'Forget permanently').trigger('click');
    await flushPromises();
    expect(dlg(w).text()).toContain('engram is paused. Resume capture to forget.');
    expect(shared.paused).toBe(true);
  });

  it('a paused failure after the person left the screen sets the shared state and toasts the paused message', async () => {
    m.forgetConfirm.mockRejectedValue(new ApiFailure('paused', 409, 'paused'));
    await expect(confirmForget('A', 'digest-1', () => false)).rejects.toBeInstanceOf(ApiFailure);
    expect(shared.paused).toBe(true);
    expect(useToasts().items.value.map((t) => t.message)).toEqual(['engram is paused. Resume capture to forget.']);
  });

  it('when busy: shows the message with Retry, and Retry confirms again', async () => {
    m.forgetConfirm.mockRejectedValueOnce(new ApiFailure('busy', 503, 'busy')).mockResolvedValue({ forgotten: true, erased: { memories: 1, messages: 0 } });
    const { w } = await open();
    await btn(w, 'Forget permanently').trigger('click');
    await flushPromises();
    expect(dlg(w).text()).toContain('engram is busy writing. Try again.');
    await btn(w, 'Retry').trigger('click');
    await flushPromises();
    expect(m.forgetConfirm).toHaveBeenCalledTimes(2);
    expect(w.find('[role=dialog]').exists()).toBe(false);
  });

  it('when the preview is busy: Retry previews again', async () => {
    m.forgetPreview.mockRejectedValueOnce(new ApiFailure('busy', 503, 'busy')).mockResolvedValue(preview());
    const { w } = await open();
    expect(dlg(w).text()).toContain('engram is busy writing. Try again.');
    expect(btn(w, 'Forget permanently').attributes('disabled')).toBeDefined();
    await btn(w, 'Retry').trigger('click');
    await flushPromises();
    expect(btn(w, 'Forget permanently').attributes('disabled')).toBeUndefined();
  });

  it('when the item is gone: closes and shows the gone state', async () => {
    m.forgetConfirm.mockRejectedValue(new ApiFailure('not_found', 404, 'gone'));
    const { w } = await open();
    await btn(w, 'Forget permanently').trigger('click');
    await flushPromises();
    expect(w.find('[role=dialog]').exists()).toBe(false);
    expect(w.text()).toContain('This memory no longer exists.');
  });

  it('Esc closes it and focus returns to the Forget button', async () => {
    const { w, forgetBtn } = await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(w.find('[role=dialog]').exists()).toBe(false);
    expect(document.activeElement).toBe(forgetBtn);
    expect(m.forgetConfirm).not.toHaveBeenCalled();
  });

  it('clicking the scrim closes it; clicking inside does not', async () => {
    const { w } = await open();
    await dlg(w).trigger('click');
    expect(w.find('[role=dialog]').exists()).toBe(true);
    await w.find('.scrim').trigger('click');
    expect(w.find('[role=dialog]').exists()).toBe(false);
  });

  it('"Keep it" closes without forgetting', async () => {
    const { w } = await open();
    await btn(w, 'Keep it').trigger('click');
    expect(w.find('[role=dialog]').exists()).toBe(false);
    expect(m.forgetConfirm).not.toHaveBeenCalled();
  });

  it('traps Tab inside the dialog', async () => {
    const { w } = await open();
    const keep = btn(w, 'Keep it').element as HTMLElement;
    const forget = btn(w, 'Forget permanently').element as HTMLElement;
    forget.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(keep);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(back);
    expect(document.activeElement).toBe(forget);
    // focus that wandered out of the dialog is pulled back in
    (w.find('[data-search]').element as HTMLElement).focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(dlg(w).element.contains(document.activeElement)).toBe(true);
  });

  it('"/" does nothing while the dialog is open', async () => {
    const { w } = await open();
    const before = document.activeElement;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(before);
    expect(w.find('[role=dialog]').exists()).toBe(true);
  });

  it('names a captured message in the heading', async () => {
    location.hash = '#/memories/m1';
    m.forgetPreview.mockResolvedValue(preview({ kind: 'message', erases: { memories: [], messages: [msg('m1', { text: 'a secret thing' })] }, notes: [] }));
    const { w } = await open();
    expect(dlg(w).find('h2').text()).toBe('Forget this message?');
    expect(dlg(w).text()).toContain('a secret thing');
  });
});
