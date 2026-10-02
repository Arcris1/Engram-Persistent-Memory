import { describe, expect, it } from 'vitest';
import { parseHash, toHash, type Route } from '../../web/src/router';

describe('router', () => {
  const routes: Route[] = [{ view: 'overview' }, { view: 'memories', id: null }, { view: 'memories', id: '01ABC/odd id' }, { view: 'health' }];
  it('round-trips every route', () => {
    for (const r of routes) expect(parseHash(toHash(r))).toEqual(r);
  });
  it('unknown or empty hash is the overview', () => {
    for (const h of ['', '#', '#/', '#/nope', '#/nope/1']) expect(parseHash(h)).toEqual({ view: 'overview' });
  });
  it('reads a memory id', () => {
    expect(parseHash('#/memories/abc')).toEqual({ view: 'memories', id: 'abc' });
    expect(parseHash('#/memories/%E0%A4%A')).toEqual({ view: 'memories', id: null });
  });
});
