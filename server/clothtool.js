import { createHash, randomBytes, randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';

const digest = value => createHash('sha256').update(value).digest('hex');
const secretPattern = /^[a-f0-9]{64}$/;
const codePattern = /^[A-F0-9]{8}$/;
const normalizeCode = value => String(value || '').replace(/[-\s]/g, '').toUpperCase();

// Desktop credentials are scoped to this router, never to the website/admin APIs.
export function installClothTool(app, { store, control, sameOrigin, canControl, publicOrigin, clock = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS clothtool_devices (
    device_hash TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL,
    label TEXT NOT NULL, user_id TEXT, parent_key TEXT, last_poll INTEGER NOT NULL DEFAULT 0
  ); CREATE TABLE IF NOT EXISTS clothtool_sessions (
    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL,
    parent_key TEXT NOT NULL, label TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL
  );`);
  const cleanup = () => {
    store.run('DELETE FROM clothtool_devices WHERE expires<=?', clock());
    store.run('DELETE FROM clothtool_sessions WHERE expires<=?', clock());
  };
  const fail = (res, status, error) => res.status(status).json({ error });
  const activeParent = key => {
    const parent = store.get(key);
    return parent && Number(parent.expires) > clock() ? parent : null;
  };
  const issueLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  const approveLimit = rateLimit({ windowMs: 15 * 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false });

  app.post('/api/clothtool/device', issueLimit, (req, res) => {
    cleanup();
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : 'ClothTool Windows';
    if (!label || label.length > 80) return fail(res, 400, 'Nome do dispositivo inválido.');
    if (store.one('SELECT COUNT(*) AS count FROM clothtool_devices').count >= 2000)
      return fail(res, 503, 'Muitas conexões pendentes. Tente novamente mais tarde.');
    const deviceCode = randomBytes(32).toString('hex');
    let code;
    do { code = randomBytes(4).toString('hex').toUpperCase(); }
    while (store.one('SELECT device_hash FROM clothtool_devices WHERE code_hash=?', digest(code)));
    store.run('INSERT INTO clothtool_devices(device_hash,code_hash,expires,label) VALUES(?,?,?,?)',
      digest(deviceCode), digest(code), clock() + 10 * 60000, label);
    res.json({ deviceCode, userCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresIn: 600, interval: 5,
      verificationUri: new URL('/control?tab=clothtool', publicOrigin).toString() });
  });

  app.post('/api/clothtool/token', async (req, res) => {
    const raw = req.body?.deviceCode;
    if (typeof raw !== 'string' || !secretPattern.test(raw)) return fail(res, 400, 'Conexão inválida.');
    const key = digest(raw), device = store.one('SELECT * FROM clothtool_devices WHERE device_hash=?', key);
    if (!device || device.expires <= clock()) return fail(res, 410, 'Código expirado ou já utilizado. Gere outro no aplicativo.');
    if (device.last_poll > clock() - 4500) return fail(res, 429, 'Aguarde cinco segundos antes de consultar novamente.');
    store.run('UPDATE clothtool_devices SET last_poll=? WHERE device_hash=?', clock(), key);
    if (!device.user_id) return res.status(202).json({ status: 'pending' });
    const parent = activeParent(device.parent_key);
    if (!parent || parent.user?.id !== device.user_id || !await canControl(device.user_id)) {
      store.run('DELETE FROM clothtool_devices WHERE device_hash=?', key);
      return fail(res, 403, 'Acesso à Central indisponível ou revogado.');
    }
    // Re-read after the Discord request, so logout/revocation cannot race issuance.
    if (!activeParent(device.parent_key) || !store.one('SELECT device_hash FROM clothtool_devices WHERE device_hash=? AND expires>?', key, clock()))
      return fail(res, 410, 'Conexão expirada ou revogada.');
    const accessToken = randomBytes(32).toString('hex'), id = randomUUID();
    const expires = Math.min(clock() + 12 * 3600000, Number(parent.expires));
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.run('DELETE FROM clothtool_devices WHERE device_hash=?', key);
      store.run('INSERT INTO clothtool_sessions VALUES(?,?,?,?,?,?,?)', id, digest(accessToken), device.user_id, device.parent_key, device.label, clock(), expires);
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    res.json({ accessToken, expiresAt: new Date(expires).toISOString(), user: { id: parent.user.id, name: parent.user.name || parent.user.username || 'Studio K' } });
  });

  app.get('/api/clothtool/session', async (req, res) => {
    const raw = String(req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!raw) return fail(res, 401, 'Conecte o ClothTool pela Central.');
    const session = store.one('SELECT * FROM clothtool_sessions WHERE token_hash=?', digest(raw));
    if (!session || session.expires <= clock()) return fail(res, 401, 'Sessão expirada ou revogada.');
    const parent = activeParent(session.parent_key);
    if (!parent || parent.user?.id !== session.user_id || !await canControl(session.user_id)) {
      store.run('DELETE FROM clothtool_sessions WHERE id=?', session.id);
      return fail(res, 403, 'O acesso à Central de Controle foi revogado ou está indisponível.');
    }
    if (!activeParent(session.parent_key) || !store.one('SELECT id FROM clothtool_sessions WHERE id=? AND expires>?', session.id, clock()))
      return fail(res, 401, 'Sessão expirada ou revogada.');
    res.json({ authorized: true, expiresAt: new Date(session.expires).toISOString(), user: { id: parent.user.id, name: parent.user.name || parent.user.username || 'Studio K' } });
  });

  app.delete('/api/clothtool/session', (req, res) => {
    const raw = String(req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!raw) return fail(res, 401, 'Sessão do ClothTool inválida.');
    const tokenHash = digest(raw), session = store.one('SELECT id FROM clothtool_sessions WHERE token_hash=?', tokenHash);
    if (!session) return fail(res, 401, 'Sessão expirada ou já revogada.');
    store.run('DELETE FROM clothtool_sessions WHERE id=?', session.id);
    res.json({ ok: true });
  });

  const route = '/api/portfolio/control/clothtool';
  app.get(route, control, (req, res) => {
    cleanup();
    const userId = req.portfolioWeb.user.id;
    const sessions = store.all('SELECT id,label,created,expires FROM clothtool_sessions WHERE user_id=? ORDER BY created DESC', userId)
      .map(row => ({ ...row, createdAt: new Date(row.created).toISOString(), expiresAt: new Date(row.expires).toISOString() }));
    res.json({ sessions });
  });
  app.post(`${route}/approve`, control, sameOrigin, approveLimit, (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!codePattern.test(code)) return fail(res, 400, 'Digite os oito caracteres exibidos no ClothTool.');
    const device = store.one('SELECT * FROM clothtool_devices WHERE code_hash=? AND expires>?', digest(code), clock());
    if (!device || device.user_id) return fail(res, 400, 'Código inválido, expirado ou já autorizado.');
    store.run('UPDATE clothtool_devices SET user_id=?,parent_key=? WHERE device_hash=?', req.portfolioWeb.user.id, req.portfolioWeb.key, device.device_hash);
    res.json({ ok: true, label: device.label });
  });
  app.delete(`${route}/sessions/:id`, control, sameOrigin, (req, res) => {
    store.run('DELETE FROM clothtool_sessions WHERE id=? AND user_id=?', req.params.id, req.portfolioWeb.user.id);
    res.json({ ok: true });
  });
  app.delete(`${route}/sessions`, control, sameOrigin, (req, res) => {
    store.run('DELETE FROM clothtool_sessions WHERE user_id=?', req.portfolioWeb.user.id);
    store.run('DELETE FROM clothtool_devices WHERE user_id=?', req.portfolioWeb.user.id);
    res.json({ ok: true });
  });
}
