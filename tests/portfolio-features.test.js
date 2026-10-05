import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { openStore } from '../server/store.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('Studio K ID, favorites, live drops and behavior tracking stay integrated', async (t) => {
  const listener = createServer();
  await new Promise((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen));
  const port = listener.address().port;
  await new Promise((resolveClose) => listener.close(resolveClose));

  const dir = mkdtempSync(join(tmpdir(), 'studio-k-portfolio-features-'));
  const origin = `http://127.0.0.1:${port}`;
  const userId = '222222222222222222';
  const sessionRaw = 'studio-k-portfolio-test-session';

  const seed = openStore(dir);
  seed.set(`portfolio-session:${sha256(sessionRaw)}`, {
    user: {
      id: userId,
      username: 'kiki-test',
      name: 'Kiki Test',
      avatar: ''
    },
    member: {
      inGuild: true,
      name: 'Kiki Test',
      avatar: '',
      roles: []
    },
    created: Date.now(),
    expires: Date.now() + 60 * 60 * 1000
  });
  seed.set('portfolio:items', [
    {
      id: 'look-neon',
      name: 'Look Neon',
      description: 'Projeto de teste',
      category: 'FiveM',
      tags: ['neon'],
      coverUrl: '',
      modelUrl: '',
      featured: true,
      published: true,
      created: seed.now(),
      updated: seed.now()
    }
  ]);
  seed.set('portfolio:products', [
    {
      id: 'produto-neon',
      name: 'Produto Neon',
      description: 'Produto de teste',
      category: 'FiveM',
      tags: ['neon'],
      coverUrl: '',
      modelUrl: '',
      featured: true,
      published: true,
      priceCents: 10000,
      botProductId: '',
      created: seed.now(),
      updated: seed.now()
    }
  ]);
  seed.set('portfolio:drops', [
    {
      id: 'drop-neon',
      title: 'Drop Neon',
      description: 'Promoção integrada',
      productId: 'produto-neon',
      discountPercent: 20,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      channelId: '',
      announceDiscord: false,
      published: true,
      created: seed.now(),
      updated: seed.now()
    }
  ]);
  seed.db.close();

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      STUDIO_DEMO: 'true',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: origin,
      PORTFOLIO_PUBLIC_URL: origin,
      COOKIE_SECURE: 'false',
      DATA_DIR: dir,
      DISCORD_TOKEN: '',
      DISCORD_GUILD_ID: '',
      INTEGRATION_KEY: ''
    },
    stdio: 'pipe'
  });

  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    child.kill();
    await new Promise((resolveExit) => child.exitCode !== null ? resolveExit() : child.once('exit', resolveExit));
    rmSync(dir, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(origin + '/healthz');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(50);
  }
  assert.ok(ready, output);

  const cookie = `studio_web_session=${sessionRaw}`;
  const request = (path, options = {}) => fetch(origin + '/api/portfolio' + path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  const publicStateResponse = await request('/public-state', { headers: { Cookie: cookie } });
  assert.equal(publicStateResponse.status, 200);
  const state = await publicStateResponse.json();
  assert.equal(state.me.authenticated, true);
  assert.equal(state.me.profile.studioId, 'SK-00001');
  assert.equal('level' in state.me.profile, false);
  assert.equal('xp' in state.me.profile, false);
  assert.deepEqual(state.me.favorites, { items: [], products: [] });
  assert.equal(state.drops.length, 1);
  assert.equal(state.drops[0].status, 'active');
  assert.equal(state.drops[0].discountPercent, 20);

  const favoriteResponse = await request('/me/favorites/items/look-neon', {
    method: 'PUT',
    body: JSON.stringify({ favorite: true }),
    headers: { Cookie: cookie, Origin: origin }
  });
  assert.equal(favoriteResponse.status, 200);
  const favorite = await favoriteResponse.json();
  assert.equal(favorite.favorite, true);
  assert.deepEqual(favorite.favorites.items, ['look-neon']);
  assert.equal(favorite.profile.studioId, 'SK-00001');
  assert.equal(favorite.profile.stats.favorites, 1);

  const profileResponse = await request('/me/profile', { headers: { Cookie: cookie } });
  assert.equal(profileResponse.status, 200);
  const profile = await profileResponse.json();
  assert.equal(profile.profile.studioId, 'SK-00001');
  assert.deepEqual(profile.favorites.items, ['look-neon']);

  const eventResponse = await request('/analytics/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'session-studio-k-test',
      event: 'product_view',
      itemKind: 'product',
      itemId: 'produto-neon',
      path: '/products/produto-neon'
    }),
    headers: { Cookie: cookie, Origin: origin }
  });
  assert.equal(eventResponse.status, 204);

  const inspect = openStore(dir);
  const events = inspect.all(
    'SELECT event,item_kind,item_id,user_id FROM portfolio_events WHERE user_id=? ORDER BY id',
    userId
  );
  assert.deepEqual(events.map((row) => row.event), ['favorite_add', 'product_view']);
  assert.equal(events[0].item_kind, 'portfolio');
  assert.equal(events[0].item_id, 'look-neon');
  assert.equal(events[1].item_kind, 'product');
  assert.equal(events[1].item_id, 'produto-neon');
  inspect.db.close();
});
