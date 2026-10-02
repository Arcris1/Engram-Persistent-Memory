/** Smooth scrolling unless the person asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** True when `el` or an ancestor is a block that scrolls on its own (long message text): arrows belong to it. */
export function inScrollable(el: HTMLElement | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return true;
  }
  return false;
}
