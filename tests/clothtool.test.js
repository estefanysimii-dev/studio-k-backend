import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.js';
import { installClothTool } from '../server/clothtool.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cloth-access-')), store = openStore(dir);
  let now = Date.now();
  const staff = new Set(['staff', 'other']);
  for (const id of ['staff', 'other', 'member']) store.set(`web:${id}`, { user: { id, name: id }, expires: now + 86400000 });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const control = (req, res, next) => {
    const id = req.headers.authorization?.replace('Bearer ', '');
    const web = store.get(`web:${id}`);
    if (!web || !staff.has(id)) return res.status(403).json({ error: 'Staff only' });
    req.portfolioWeb = { ...web, key: `web:${id}` }; next();
  };
  const sameOrigin = (req, res, next) => req.headers.origin === 'https://studio.test' ? next() : res.status(403).end();
  installClothTool(app, { store, control, sameOrigin, canControl: async id => staff.has(id), publicOrigin: 'https://studio.test', clock: () => now });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = 'GET', body, token, origin = 'https://studio.test' } = {}) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const device = async () => (await request('/api/clothtool/device', { method: 'POST', body: { label: 'My PC' } })).json();
  const approve = (code, token = 'staff', origin) => request('/api/portfolio/control/clothtool/approve', { method: 'POST', body: { code }, token, origin });
  const poll = deviceCode => request('/api/clothtool/token', { method: 'POST', body: { deviceCode } });
  const connect = async () => { const d = await device(); assert.equal((await approve(d.userCode)).status, 200); const r = await poll(d.deviceCode); assert.equal(r.status, 200); return { ...d, ...await r.json() }; };
  return { request, store, staff, device, approve, poll, connect, advance: ms => { now += ms; } };
}

test('ClothTool refuses anonymous, non-staff, foreign-origin and invalid-code approval', async t => {
  const f = await fixture(t), d = await f.device();
  assert.equal((await f.approve(d.userCode, '')).status, 403);
  assert.equal((await f.approve(d.userCode, 'member')).status, 403);
  assert.equal((await f.approve(d.userCode, 'staff', 'https://evil.test')).status, 403);
  assert.equal((await f.approve('../secret')).status, 400);
  assert.equal((await f.approve('0000-0000')).status, 400);
  assert.equal((await f.poll(d.deviceCode)).status, 202);
});
test('ClothTool pairs once, stores only hashes and scopes its credential', async t => {
  const f = await fixture(t), d = await f.device();
  assert.equal(d.verificationUri, 'https://studio.test/control?tab=clothtool');
  assert.equal((await f.poll(d.deviceCode)).status, 202);
  assert.equal((await f.poll(d.deviceCode)).status, 429);
  assert.equal((await f.approve(d.userCode)).status, 200);
  assert.equal((await f.approve(d.userCode, 'other')).status, 400);
  f.advance(5000);
  const response = await f.poll(d.deviceCode), session = await response.json();
  assert.equal(response.status, 200); assert.equal(session.user.id, 'staff');
  assert.equal((await f.poll(d.deviceCode)).status, 410);
  assert.equal((await f.request('/api/clothtool/session', { token: session.accessToken })).status, 200);
  assert.equal((await f.request('/api/portfolio/control/clothtool', { token: session.accessToken })).status, 403);
  const row = f.store.one('SELECT * FROM clothtool_sessions');
  assert.notEqual(row.token_hash, session.accessToken);
  const own = await (await f.request('/api/portfolio/control/clothtool', { token: 'staff' })).json();
  assert.equal(own.sessions.length, 1); assert.ok(!JSON.stringify(own).includes(session.accessToken));
  const other = await (await f.request('/api/portfolio/control/clothtool', { token: 'other' })).json();
  assert.equal(other.sessions.length, 0);
});
test('ClothTool denies expired pairing and expired sessions', async t => {
  const f = await fixture(t), d = await f.device();
  f.advance(600001); assert.equal((await f.poll(d.deviceCode)).status, 410);
  assert.equal((await f.approve(d.userCode)).status, 400);
  const session = await f.connect(); f.advance(12 * 3600000 + 1);
  assert.equal((await f.request('/api/clothtool/session', { token: session.accessToken })).status, 401);
});
test('ClothTool rechecks Staff before issuance and during use', async t => {
  const f = await fixture(t), d = await f.device();
  await f.approve(d.userCode); f.staff.delete('staff');
  assert.equal((await f.poll(d.deviceCode)).status, 403);
  f.staff.add('staff'); const session = await f.connect(); f.staff.delete('staff');
  assert.equal((await f.request('/api/clothtool/session', { token: session.accessToken })).status, 403);
  f.staff.add('staff');
  assert.equal((await f.request('/api/clothtool/session', { token: session.accessToken })).status, 401);
});
test('ClothTool revocation is owner-scoped and logout invalidates linked access', async t => {
  const f = await fixture(t), session = await f.connect();
  const { id } = f.store.one('SELECT id FROM clothtool_sessions');
  await f.request(`/api/portfolio/control/clothtool/sessions/${id}`, { method: 'DELETE', token: 'other' });
  assert.equal((await f.request('/api/clothtool/session', { token: session.accessToken })).status, 200);
  await f.request(`/api/portfolio/control/clothtool/sessions/${id}`, { method: 'DELETE', token: 'staff' });
  assert.equal((await f.request('/api/clothtool/session', { token: session.accessToken })).status, 401);
  const next = await f.connect(); f.store.run('DELETE FROM kv WHERE key=?', 'web:staff');
  assert.equal((await f.request('/api/clothtool/session', { token: next.accessToken })).status, 403);
});
test('ClothTool revokes pending authorizations as well as active sessions', async t => {
  const f = await fixture(t), session = await f.connect(), pending = await f.device();
  await f.approve(pending.userCode);
  await f.request('/api/portfolio/control/clothtool/sessions', { method: 'DELETE', token: 'staff' });
  assert.equal((await f.poll(pending.deviceCode)).status, 410);
  assert.equal((await f.request('/api/clothtool/session', { token: session.accessToken })).status, 401);
});

test('ClothTool can disconnect only its own desktop session with its scoped token', async t => {
  const f = await fixture(t), session = await f.connect();
  assert.equal((await f.request('/api/clothtool/session', { method: 'DELETE', token: session.accessToken })).status, 200);
  assert.equal((await f.request('/api/clothtool/session', { token: session.accessToken })).status, 401);
  assert.equal((await f.request('/api/clothtool/session', { method: 'DELETE', token: session.accessToken })).status, 401);
});
