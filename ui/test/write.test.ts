import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPaused, setPaused } from '../../dist/control/pause.js';
import { openDb } from '../../dist/storage/db.js';
import type { Detail, ExportDone, ForgetDone, ForgetPreview, PauseState, PinDone } from '../server/types.js';
import { addClaim, addEvent, count, post, start, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  setPaused(false);
  await h?.close();
  h = undefined;
});

const detail = async (id: string) => h!.req(`/api/memories/${id}`);
const pinnedOf = async (id: string): Promise<boolean> => {
  const d = (await detail(id)).json<Detail>();
  return d.kind === 'memory' && d.memory.pinned;
};

describe('pin and unpin', () => {
  it('pins then unpins a memory, visible in the detail', async () => {
    let id = '';
    h = await start({ seed: (db) => (id = addClaim(db)) });
    expect(await pinnedOf(id)).toBe(false);
    const a = await post(h, `/api/memories/${id}/pin`);
    expect(a.status).toBe(200);
    expect(a.json<PinDone>()).toEqual({ id, pinned: true });
    expect(await pinnedOf(id)).toBe(true);
    const b = await post(h, `/api/memories/${id}/unpin`);
    expect(b.json<PinDone>()).toEqual({ id, pinned: false });
    expect(await pinnedOf(id)).toBe(false);
  });

  it('a message id is 400, an unknown id is 404', async () => {
    let ev = '';
    h = await start({ seed: (db) => (ev = addEvent(db)) });
    const r = await post(h, `/api/memories/${ev}/pin`);
    expect(r.status).toBe(400);
    expect(r.json<{ error: { code: string; message: string } }>().error).toEqual({ code: 'bad_request', message: 'only memories can be pinned' });
    expect((await post(h, `/api/memories/${ev}/unpin`)).status).toBe(400);
    expect((await post(h, '/api/memories/nope/pin')).status).toBe(404);
    expect((await post(h, '/api/memories/nope/unpin')).status).toBe(404);
  });
});

describe('forget', () => {
  it('previews a memory (sources stay), leaves the database unchanged, confirm erases it', async () => {
    let id = '';
    let src = '';
    h = await start({
      seed: (db) => {
        src = addEvent(db, { content: 'source text for the forgotten memory' });
        id = addClaim(db, { sources: [src], statement: 'Forget me please' });
      },
    });
    const before = { claims: count(h.db, 'claims'), events: count(h.db, 'events'), marks: count(h.db, 'marks') };
    const p = await post(h, `/api/memories/${id}/forget`, { confirm: false });
    expect(p.status).toBe(200);
    const prev = p.json<ForgetPreview>();
    expect(prev.kind).toBe('memory');
    expect(prev.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(prev.erases.memories.map((m) => m.id)).toEqual([id]);
    expect(prev.erases.memories[0]!.statement).toBe('Forget me please');
    expect(prev.erases.messages).toEqual([]);
    expect(prev.stays.messages.map((m) => m.id)).toEqual([src]);
    expect(prev.notes).toEqual(['The messages this memory was built from stay. Forget them too if the text itself must go.']);
    expect({ claims: count(h.db, 'claims'), events: count(h.db, 'events'), marks: count(h.db, 'marks') }).toEqual(before);
    expect((await detail(id)).status).toBe(200);

    const c = await post(h, `/api/memories/${id}/forget`, { confirm: true, digest: prev.digest });
    expect(c.status).toBe(200);
    expect(c.json<ForgetDone>()).toEqual({ forgotten: true, erased: { memories: 1, messages: 0 } });
    expect((await detail(id)).status).toBe(404);
    expect((await detail(src)).status).toBe(200);
  });

  it('forgetting a message erases its sole-source memory too, with no FTS or embedding rows left', async () => {
    let ev = '';
    let cl = '';
    h = await start({
      seed: (db) => {
        ev = addEvent(db, { content: 'zebracornflakes unique phrase for this test' });
        cl = addClaim(db, { sources: [ev], statement: 'quokkaterrarium sole source memory' });
        db.prepare(`INSERT INTO embeddings (target_kind, target_id, model, content_hash, dim, vec, created_at) VALUES ('event', ?, 'm', 'h', 1, x'00000000', 'now')`).run(ev);
        db.prepare(`INSERT INTO embeddings (target_kind, target_id, model, content_hash, dim, vec, created_at) VALUES ('claim', ?, 'm', 'h', 1, x'00000000', 'now')`).run(cl);
      },
    });
    const prev = (await post(h, `/api/memories/${ev}/forget`, { confirm: false })).json<ForgetPreview>();
    expect(prev.kind).toBe('message');
    expect(prev.erases.messages.map((m) => m.id)).toEqual([ev]);
    expect(prev.erases.memories.map((m) => m.id)).toEqual([cl]);
    const c = (await post(h, `/api/memories/${ev}/forget`, { confirm: true, digest: prev.digest })).json<ForgetDone>();
    expect(c).toEqual({ forgotten: true, erased: { memories: 1, messages: 1 } });
    expect((await detail(ev)).status).toBe(404);
    expect((await detail(cl)).status).toBe(404);
    expect(count(h.db, 'embeddings')).toBe(0);
    expect((h.db.prepare(`SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH 'zebracornflakes'`).get() as { n: number }).n).toBe(0);
    expect((h.db.prepare(`SELECT count(*) AS n FROM claims_fts WHERE claims_fts MATCH 'quokkaterrarium'`).get() as { n: number }).n).toBe(0);
  });

  it('notes mention the same text elsewhere and memories that keep other sources', async () => {
    let ev = '';
    h = await start({
      seed: (db) => {
        ev = addEvent(db, { content: 'shared text', session: 's-a' });
        addEvent(db, { content: 'shared text', session: 's-b' });
        const other = addEvent(db, { content: 'another source' });
        addClaim(db, { sources: [ev, other], statement: 'Keeps another source' });
      },
    });
    const prev = (await post(h, `/api/memories/${ev}/forget`, { confirm: false })).json<ForgetPreview>();
    expect(prev.stays.messages).toHaveLength(1);
    expect(prev.stays.memories.map((m) => m.statement)).toEqual(['Keeps another source']);
    expect(prev.notes).toEqual([
      'The same text also exists in 1 other captured message.',
      '1 memory built from this also cites other messages and will stay.',
    ]);
  });

  it('confirm needs the digest: none is 400, a wrong one 409 changed, a stale one 409 changed', async () => {
    let ev = '';
    h = await start({
      seed: (db) => {
        ev = addEvent(db, { content: 'event with one dependent memory' });
        addClaim(db, { sources: [ev] });
      },
    });
    const url = `/api/memories/${ev}/forget`;
    expect((await post(h, url, { confirm: true })).status).toBe(400);
    expect((await post(h, url, {})).status).toBe(400);
    expect((await post(h, url, { confirm: 'yes' })).status).toBe(400);
    const wrong = await post(h, url, { confirm: true, digest: 'f'.repeat(64) });
    expect(wrong.status).toBe(409);
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe('changed');

    const prev = (await post(h, url, { confirm: false })).json<ForgetPreview>();
    addClaim(h.db, { sources: [ev], statement: 'Added after the preview' });
    const stale = await post(h, url, { confirm: true, digest: prev.digest });
    expect(stale.status).toBe(409);
    expect(count(h.db, 'events')).toBe(1); // nothing was deleted
    const again = (await post(h, url, { confirm: false })).json<ForgetPreview>();
    expect((await post(h, url, { confirm: true, digest: again.digest })).status).toBe(200);
  });

  it('unknown id is 404', async () => {
    h = await start();
    expect((await post(h, '/api/memories/nope/forget', { confirm: false })).status).toBe(404);
  });

  it('answers 503 busy when another connection holds the write lock', async () => {
    let id = '';
    h = await start({ busyTimeoutMs: 50, seed: (db) => (id = addClaim(db)) });
    const other = openDb(h.dbFile);
    other.exec('BEGIN IMMEDIATE');
    try {
      const r = await post(h, `/api/memories/${id}/forget`, { confirm: false });
      expect(r.status).toBe(503);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('busy');
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    expect((await post(h, `/api/memories/${id}/forget`, { confirm: false })).status).toBe(200);
  });
});

describe('pause and resume', () => {
  it('flips the flag file', async () => {
    h = await start();
    expect(isPaused()).toBe(false);
    expect((await post(h, '/api/pause')).json<PauseState>()).toEqual({ paused: true });
    expect(isPaused()).toBe(true);
    expect(fs.existsSync(path.join(h.dir, 'paused'))).toBe(true);
    expect((await post(h, '/api/resume')).json<PauseState>()).toEqual({ paused: false });
    expect(isPaused()).toBe(false);
  });

  it('while paused: pin/unpin and forget confirm are 409 paused; preview, export and health still work; resume lifts it', async () => {
    let id = '';
    h = await start({ seed: (db) => (id = addClaim(db)) });
    await post(h, '/api/pause');
    for (const verb of ['pin', 'unpin']) {
      const r = await post(h, `/api/memories/${id}/${verb}`);
      expect(r.status).toBe(409);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('paused');
    }
    const p = await post(h, `/api/memories/${id}/forget`, { confirm: false });
    expect(p.status).toBe(200);
    const digest = p.json<ForgetPreview>().digest;
    const c = await post(h, `/api/memories/${id}/forget`, { confirm: true, digest });
    expect(c.status).toBe(409);
    expect(c.json<{ error: { code: string } }>().error.code).toBe('paused');
    expect((await detail(id)).status).toBe(200);
    expect((await post(h, '/api/export')).status).toBe(200);
    expect((await h.req('/api/health')).status).toBe(200);
    await post(h, '/api/resume');
    expect((await post(h, `/api/memories/${id}/forget`, { confirm: true, digest })).status).toBe(200);
  });
});

describe('export', () => {
  it('writes inside the data dir with mode 0600 and ignores a client-supplied path', async () => {
    h = await start({ seed: (db) => addClaim(db) });
    const r = await post(h, '/api/export', { path: '/tmp/engram-ui-evil.json' });
    expect(r.status).toBe(200);
    const { path: file } = r.json<ExportDone>();
    expect(path.resolve(file).startsWith(fs.realpathSync(h.dir)) || path.resolve(file).startsWith(h.dir)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).format).toBe('engram-export');
    expect(fs.existsSync('/tmp/engram-ui-evil.json')).toBe(false);
  });
});

describe('request framing', () => {
  it('POST without a JSON Content-Type is 415', async () => {
    h = await start();
    expect((await h.req('/api/pause', { method: 'POST' })).status).toBe(415);
    expect((await h.req('/api/pause', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect(isPaused()).toBe(false);
  });

  it('a body over 64 KB is 413; malformed JSON is 400; a JSON content type with charset is fine', async () => {
    h = await start();
    const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
    expect((await h.req('/api/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status).toBe(413);
    expect((await h.req('/api/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status).toBe(400);
    expect((await h.req('/api/pause', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' })).status).toBe(200);
  });

  it('GET on a POST route is 405 and POST on a GET route is 405', async () => {
    h = await start();
    const g = await h.req('/api/pause');
    expect(g.status).toBe(405);
    expect(g.headers.allow).toBe('POST');
    expect((await post(h, '/api/overview')).status).toBe(405);
    expect((await post(h, '/api/health')).status).toBe(405);
  });

  it('writes need the token like every other endpoint', async () => {
    h = await start();
    const r = await h.req('/api/pause', { method: 'POST', token: null, headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(401);
    expect(isPaused()).toBe(false);
  });
});
