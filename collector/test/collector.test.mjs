import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, APPS } from '../worker.js';
import { makeDb } from './d1-shim.mjs';

const VID = 'abcd1234-efgh-5678';
const ok = (app) => `https://${app}.misanmorrison.com`;
const post = (body, origin, env, raw) => handle(new Request('https://c.example/e', {
  method: 'POST',
  headers: { 'content-type': 'text/plain', ...(origin ? { origin } : {}) },
  body: raw ?? JSON.stringify(body),
}), env);
const get = (path, key, env) => handle(new Request('https://c.example' + path, {
  headers: key ? { authorization: 'Bearer ' + key } : {},
}), env);
const fresh = () => ({ DB: makeDb(), ADMIN_KEY: 'sekret', EXTRA_ORIGINS: '' });
const rows = (env) => env.DB.raw.prepare('SELECT * FROM events').all();

test('stores a valid event with server-side timestamp and no extras', async () => {
  const env = fresh();
  const r = await post({ app: 'landed', type: 'unlock', vid: VID }, ok('landed'), env);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), ok('landed'));
  const [row] = rows(env);
  assert.equal(row.app, 'landed'); assert.equal(row.type, 'unlock'); assert.equal(row.vid, VID);
  assert.equal(row.day, row.ts.slice(0, 10));
  assert.deepEqual(Object.keys(row).sort(), ['app', 'day', 'feature', 'id', 'ts', 'type', 'vid']);
});

test('every one of the 10 allow-listed apps is accepted from its own domain', async () => {
  assert.equal(APPS.length, 10);
  const env = fresh();
  for (const app of APPS) assert.equal((await post({ app, type: 'open', vid: VID }, ok(app), env)).status, 204, app);
  assert.equal(rows(env).length, 10);
});

test('rejects unknown app, type and malformed vid', async () => {
  const env = fresh();
  assert.equal((await post({ app: 'nope', type: 'open', vid: VID }, ok('nope'), env)).status, 400);
  assert.equal((await post({ app: 'landed', type: 'hack', vid: VID }, ok('landed'), env)).status, 400);
  assert.equal((await post({ app: 'landed', type: 'open', vid: 'short' }, ok('landed'), env)).status, 400);
  assert.equal((await post({ app: 'landed', type: 'open', vid: 'x'.repeat(65) }, ok('landed'), env)).status, 400);
  assert.equal((await post({ app: 'landed', type: 'open', vid: 'has space here!' }, ok('landed'), env)).status, 400);
  assert.equal(rows(env).length, 0);
});

test('origin must match the app it claims: no missing, foreign or cross-app origin', async () => {
  const env = fresh();
  const ev = { app: 'landed', type: 'open', vid: VID };
  assert.equal((await post(ev, null, env)).status, 403);
  assert.equal((await post(ev, 'https://evil.example', env)).status, 403);
  assert.equal((await post(ev, ok('chair'), env)).status, 403);
  assert.equal((await post(ev, 'http://landed.misanmorrison.com', env)).status, 403);
  assert.equal((await post(ev, 'https://landed.misanmorrison.com.evil.example', env)).status, 403);
  assert.equal(rows(env).length, 0);
});

test('EXTRA_ORIGINS allows a local test origin only when configured', async () => {
  const env = { ...fresh(), EXTRA_ORIGINS: 'http://localhost:9999' };
  assert.equal((await post({ app: 'landed', type: 'open', vid: VID }, 'http://localhost:9999', env)).status, 204);
  assert.equal((await post({ app: 'landed', type: 'open', vid: VID }, 'http://localhost:9999', fresh())).status, 403);
});

test('rejects bad json and oversized bodies', async () => {
  const env = fresh();
  assert.equal((await post(null, ok('landed'), env, '{not json')).status, 400);
  assert.equal((await post(null, ok('landed'), env, JSON.stringify({ app: 'landed', type: 'use', vid: VID, feature: 'x'.repeat(2000) }))).status, 413);
});

test('feature is only kept for "use", cleaned and truncated', async () => {
  const env = fresh();
  await post({ app: 'landed', type: 'use', vid: VID, feature: '  <b>Pricing\n  Proposal</b>  ' }, ok('landed'), env);
  await post({ app: 'landed', type: 'use', vid: VID, feature: 'y'.repeat(100) }, ok('landed'), env);
  await post({ app: 'landed', type: 'open', vid: VID, feature: 'ignored' }, ok('landed'), env);
  const r = rows(env);
  assert.equal(r[0].feature, 'bPricing Proposal/b');
  assert.equal(r[1].feature.length, 40);
  assert.equal(r[2].feature, null);
});

test('per-visitor daily cap silently stops storing', async () => {
  const env = fresh();
  for (let i = 0; i < 205; i++) await post({ app: 'landed', type: 'use', vid: VID, feature: 'x' }, ok('landed'), env);
  assert.equal(rows(env).length, 200);
  assert.equal((await post({ app: 'landed', type: 'use', vid: 'another-visitor-1', feature: 'x' }, ok('landed'), env)).status, 204);
  assert.equal(rows(env).length, 201);
});

test('/stats needs the admin key', async () => {
  const env = fresh();
  assert.equal((await get('/stats', null, env)).status, 401);
  assert.equal((await get('/stats', 'wrong', env)).status, 401);
  assert.equal((await get('/stats', 'sekret', env)).status, 200);
  assert.equal((await get('/stats', 'sekret', { ...env, ADMIN_KEY: '' })).status, 401);
  assert.equal((await get('/stats', '', { ...env, ADMIN_KEY: '' })).status, 401);
});

test('/stats 401 is readable cross-origin so the dashboard can say "wrong key"', async () => {
  const env = fresh();
  for (const key of [null, 'wrong']) {
    const r = await get('/stats', key, env);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  }
});

test('/stats aggregates correctly, including returning visitors across days', async () => {
  const env = fresh();
  const ins = env.DB.raw.prepare('INSERT INTO events (ts, day, app, type, feature, vid) VALUES (?,?,?,?,?,?)');
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const add = (app, type, vid, day, feature = null) => ins.run(day + 'T10:00:00.000Z', day, app, type, feature, vid);
  // landed: A unlocks 3 days ago and returns today; B unlocks today only.
  add('landed', 'unlock', 'visitor-aaaaaaaa', daysAgo(3));
  add('landed', 'open', 'visitor-aaaaaaaa', today);
  add('landed', 'use', 'visitor-aaaaaaaa', today, 'Pricing Proposal');
  add('landed', 'use', 'visitor-aaaaaaaa', today, 'Pricing Proposal');
  add('landed', 'use', 'visitor-aaaaaaaa', today, 'Outreach Scripts');
  add('landed', 'unlock', 'visitor-bbbbbbbb', today);
  // chair: one old unlock outside the 30-day window.
  add('chair', 'unlock', 'visitor-cccccccc', daysAgo(45));

  const body = await (await get('/stats?days=30', 'sekret', env)).json();
  assert.equal(body.apps.length, 10);
  const landed = body.apps.find((a) => a.app === 'landed');
  assert.equal(landed.unlocks, 2);
  assert.equal(landed.opens, 1);
  assert.equal(landed.uses, 3);
  assert.equal(landed.visitors, 2);
  assert.equal(landed.returning, 1);
  assert.equal(landed.active7, 2);
  assert.deepEqual(landed.features, [{ feature: 'Pricing Proposal', count: 2 }, { feature: 'Outreach Scripts', count: 1 }]);
  assert.equal(landed.daily.length, 2);
  assert.ok(landed.lastSeen && landed.firstSeen);

  const chair = body.apps.find((a) => a.app === 'chair');
  assert.equal(chair.visitors, 0);                 // outside the window...
  assert.ok(chair.firstSeen);                      // ...but we still know it has ever been seen
  const quiet = body.apps.find((a) => a.app === 'dispatch');
  assert.deepEqual([quiet.unlocks, quiet.visitors, quiet.lastSeen, quiet.firstSeen], [0, 0, null, null]);

  const wide = await (await get('/stats?days=90', 'sekret', env)).json();
  assert.equal(wide.apps.find((a) => a.app === 'chair').visitors, 1);
});

test('/stats clamps the days parameter and handles junk', async () => {
  const env = fresh();
  assert.equal((await (await get('/stats?days=99999', 'sekret', env)).json()).days, 365);
  assert.equal((await (await get('/stats?days=0', 'sekret', env)).json()).days, 30);
  assert.equal((await (await get('/stats?days=abc', 'sekret', env)).json()).days, 30);
});

test('routing: health, 404, method mismatch and preflight', async () => {
  const env = fresh();
  assert.equal((await get('/', null, env)).status, 200);
  assert.equal((await get('/nope', null, env)).status, 404);
  assert.equal((await get('/e', null, env)).status, 404);
  const pre = await handle(new Request('https://c.example/e', { method: 'OPTIONS', headers: { origin: ok('landed') } }), env);
  assert.equal(pre.status, 204);
  const bad = await handle(new Request('https://c.example/e', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env);
  assert.equal(bad.status, 403);
});
