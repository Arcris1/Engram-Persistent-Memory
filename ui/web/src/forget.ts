import type { ForgetDone } from '../../server/types';
import { api, ApiFailure } from './api';
import { useToasts } from './format';
import { failureMessage } from './load';
import { loadShared, shared } from './store';

/**
 * The permanent delete lives outside the dialog component so its result is surfaced even if the person leaves the screen
 * while it is in flight: the toast and the rail count do not depend on anything that unmounts.
 * `alive()` says whether the dialog is still on screen to show a failure itself.
 */
export async function confirmForget(id: string, digest: string, alive: () => boolean): Promise<ForgetDone> {
  const { show } = useToasts();
  try {
    const r = await api.forgetConfirm(id, digest);
    show('Forgotten');
    void loadShared();
    return r;
  } catch (e) {
    if (!alive() && e instanceof ApiFailure && e.code === 'paused') {
      shared.paused = true;
      show('engram is paused. Resume capture to forget.');
    } else if (!alive() && !(e instanceof ApiFailure && (e.code === 'unauthorized' || e.code === 'not_found'))) {
      show(e instanceof ApiFailure && e.code === 'changed' ? 'This changed since you looked, so nothing was forgotten.' : failureMessage(e));
    }
    throw e;
  }
}

/**
 * Locks the page behind a modal: no scrolling, and everything outside the modal is inert (the toasts stay readable).
 * Returns the function that restores it.
 */
export function lockPage(modal: HTMLElement): () => void {
  const html = document.documentElement;
  html.classList.add('dialog-open');
  const marked: HTMLElement[] = [];
  for (let n: HTMLElement = modal; n.parentElement && n !== document.body; n = n.parentElement) {
    for (const sibling of Array.from(n.parentElement.children)) {
      if (sibling === n || !(sibling instanceof HTMLElement) || sibling.hasAttribute('inert') || sibling.classList.contains('toasts') || sibling.tagName === 'SCRIPT') continue;
      sibling.setAttribute('inert', '');
      marked.push(sibling);
    }
  }
  return () => {
    html.classList.remove('dialog-open');
    for (const el of marked) el.removeAttribute('inert');
  };
}
