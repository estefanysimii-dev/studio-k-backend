import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readdirSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const key = process.env.SETUP_KEY || '';
if (key.length < 16) throw new Error('SETUP_KEY existente precisa ter pelo menos 16 caracteres.');
const keyHash = createHash('sha256').update(key).digest();
const data = resolve(process.env.DATA_DIR || '/app/data');
const started = Date.now(), deadline = started + 30 * 60 * 1000;
let active = false, attempts = 0, windowStart = started;
const children = new Set();

function validateData() {
  if (!lstatSync(data).isDirectory() || lstatSync(data).isSymbolicLink()) throw new Error('DATA_DIR precisa ser uma pasta real restaurada.');
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('O volume contem links ou arquivos especiais; exportacao bloqueada.');
      if (entry.isDirectory()) walk(join(directory, entry.name));
    }
  }
  walk(data);
  const db = join(data, 'studio-k.sqlite'), encryption = join(data, 'encryption.key');
  if (!lstatSync(db).isFile() || lstatSync(db).size < 100) throw new Error('Banco original ausente ou vazio.');
  if (!lstatSync(encryption).isFile() || readFileSync(encryption).length !== 32) throw new Error('Chave original ausente ou invalida.');
  const header = Buffer.alloc(16), fd = openSync(db, 'r');
  try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
  if (header.toString('binary') !== 'SQLite format 3\0') throw new Error('Cabecalho SQLite invalido.');
}
validateData();

const form = '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio K - Exportacao privada</title><h1>Exportar dados originais Studio K</h1><p>Exportacao temporaria, disponivel por 30 minutos. Informe a SETUP_KEY existente. O aplicativo e o bot nao sao iniciados.</p><form method="post" action="/download" autocomplete="off"><label>Chave privada <input type="password" name="key" required autocomplete="off" maxlength="2048"></label><button type="submit">Baixar backup completo</button></form></html>';
function reply(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (Date.now() >= deadline) return reply(res, 410, 'Exportador expirado.');
  if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(req.method === 'HEAD' ? '' : '{"ok":true,"mode":"read-only-export"}');
  }
  if (req.url === '/' && ['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(req.method === 'HEAD' ? '' : form);
  }
  if (req.url !== '/download' || req.method !== 'POST') return reply(res, 404, 'Nao encontrado.');
  if (Date.now() - windowStart >= 60 * 1000) { attempts = 0; windowStart = Date.now(); }
  if (++attempts > 10) { res.setHeader('Retry-After', '60'); return reply(res, 429, 'Aguarde um minuto.'); }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return reply(res, 415, 'Use o formulario.');
  if (Number(req.headers['content-length'] || 0) > 4096) return reply(res, 413, 'Formulario muito grande.');
  let body = Buffer.alloc(0);
  try {
    for await (const chunk of req) {
      if (body.length + chunk.length > 4096) { reply(res, 413, 'Formulario muito grande.'); return; }
      body = Buffer.concat([body, chunk]);
    }
  } catch { if (!res.destroyed) reply(res, 400, 'Solicitacao interrompida.'); return; }
  const submitted = new URLSearchParams(body.toString('utf8')).get('key') || '';
  const submittedHash = createHash('sha256').update(submitted).digest();
  if (!timingSafeEqual(keyHash, submittedHash)) return reply(res, 401, 'Chave invalida.');
  if (Date.now() >= deadline) return reply(res, 410, 'Exportador expirado.');
  if (active) return reply(res, 409, 'Uma exportacao ja esta em andamento.');
  try { validateData(); } catch { return reply(res, 503, 'O volume nao passou na verificacao.'); }
  active = true;
  const child = spawn('tar', ['-czf', '-', '-C', data, '.'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let finished = false;
  const finish = () => { if (!finished) { finished = true; active = false; children.delete(child); } };
  child.stderr.on('data', () => {});
  child.once('error', () => { finish(); if (!res.headersSent) reply(res, 503, 'Nao foi possivel iniciar tar.'); else res.destroy(); });
  child.once('spawn', () => {
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="studio-k-data-export.tar.gz"' });
    child.stdout.pipe(res, { end: false });
  });
  child.once('close', code => {
    finish();
    if (code === 0) res.end(); else if (!res.destroyed) res.destroy();
  });
  res.once('close', () => { if (!finished) child.kill('SIGTERM'); });
});
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
const stop = () => { for (const child of children) child.kill('SIGTERM'); server.close(); server.closeIdleConnections(); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
setTimeout(stop, Math.max(1, deadline - Date.now())).unref();
server.listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0', () => {
  console.log(JSON.stringify({ rescue: 'ready', port: server.address().port, expiresAt: new Date(deadline).toISOString() }));
});