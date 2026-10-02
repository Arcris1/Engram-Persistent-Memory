import { ref, type Ref } from 'vue';

export type Route = { view: 'overview' } | { view: 'memories'; id: string | null } | { view: 'health' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'memories') {
    let id: string | null = null;
    if (parts[1]) {
      try {
        id = decodeURIComponent(parts[1]);
      } catch {
        id = null;
      }
    }
    return { view: 'memories', id };
  }
  if (parts[0] === 'health') return { view: 'health' };
  return { view: 'overview' };
}

export function toHash(r: Route): string {
  if (r.view === 'memories') return r.id ? `#/memories/${encodeURIComponent(r.id)}` : '#/memories';
  if (r.view === 'health') return '#/health';
  return '#/';
}

const route: Ref<Route> = ref(parseHash(typeof location === 'undefined' ? '' : location.hash));
let listening = false;

function sync(): void {
  route.value = parseHash(location.hash);
}

export function useRoute(): { route: Ref<Route>; go(r: Route, replace?: boolean): void } {
  if (!listening) {
    window.addEventListener('hashchange', sync);
    listening = true;
  }
  sync();
  return {
    route,
    /** `replace` swaps the current history entry instead of adding one (keyboard moves, automatic selection). */
    go(r: Route, replace = false): void {
      const h = toHash(r);
      if (location.hash === h) return sync();
      if (replace) history.replaceState(null, '', location.pathname + location.search + h);
      else location.hash = h;
      sync();
    },
  };
}

