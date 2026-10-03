import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../server/store.js';
test('website OAuth uses an independent backend origin and keeps legacy OAuth', async t => {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-k-origin-'));
  const store = openStore(dataDir);
  const settings = store.settings();
  settings.verification.oauthEnabled = true;
  settings.verification.roleIds = ['123456789012345678'];
  store.set('settings', settings);
  store.db.close();
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), STUDIO_DEMO: 'false',
      PUBLIC_URL: 'https://legacy.example', PORTFOLIO_BACKEND_URL: origin,
      PORTFOLIO_PUBLIC_URL: 'https://studiokatelier.infinityfreeapp.com', DATA_DIR: dataDir,
      DISCORD_TOKEN: '', DISCORD_GUILD_ID: '', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'test-placeholder', COOKIE_SECURE: 'false' }, stdio: 'ignore'
  });
  t.after(async () => {
    child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    await delay(50);
  }
  const start = await fetch(origin + '/api/portfolio/oauth/start?next=/control', { redirect: 'manual' });
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('location'), origin + '/api/portfolio/oauth/bridge?next=%2Fcontrol');
  const bridge = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const target = new URL(bridge.headers.get('location'));
  assert.equal(target.origin, 'https://discord.com');
  assert.equal(target.searchParams.get('redirect_uri'), origin + '/api/oauth/discord/callback');
  assert.equal(target.searchParams.get('scope'), 'identify');
  assert.match(bridge.headers.get('set-cookie'), /HttpOnly/);
  assert.match(bridge.headers.get('set-cookie'), /Path=\/api\/oauth\/discord/);
  const legacy = await fetch(origin + '/api/oauth/discord/start', { redirect: 'manual' });
  assert.equal(new URL(legacy.headers.get('location')).searchParams.get('redirect_uri'), 'https://legacy.example/api/oauth/discord/callback');
});
