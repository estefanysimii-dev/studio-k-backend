import { closeSync, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

function regularFile(path) {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`Arquivo regular restaurado obrigatorio ausente: ${path}`);
  }
}

function noLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Links simbolicos nao sao permitidos no backup: ${path}`);
    if (entry.isDirectory()) noLinks(path);
    else if (!entry.isFile()) throw new Error(`Tipo de arquivo nao suportado no backup: ${path}`);
  }
}

export function verifyData(directory) {
  const source = resolve(directory);
  if (!existsSync(source) || !lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) {
    throw new Error('Restaure a pasta data original; a verificacao nao cria um banco vazio.');
  }
  noLinks(source);
  const dbFile = join(source, 'studio-k.sqlite');
  const keyFile = join(source, 'encryption.key');
  regularFile(dbFile);
  regularFile(keyFile);
  const key = readFileSync(keyFile);
  if (key.length !== 32) throw new Error('encryption.key deve ser a chave original de 32 bytes.');
  if (statSync(dbFile).size < 100) throw new Error('Banco restaurado vazio ou invalido.');
  const header = Buffer.alloc(16);
  const handle = openSync(dbFile, 'r');
  try { readSync(handle, header, 0, 16, 0); } finally { closeSync(handle); }
  if (header.toString('binary') !== 'SQLite format 3\0') {
    throw new Error('studio-k.sqlite nao tem cabecalho SQLite valido.');
  }

  // All SQLite reads/recovery happen on a private copy, never on the source.
  // Keep its path for inspection; this script never deletes source or scratch data.
  const scratch = mkdtempSync(join(tmpdir(), 'studio-k-preflight-'));
  for (const name of ['studio-k.sqlite', 'studio-k.sqlite-wal', 'studio-k.sqlite-shm']) {
    const path = join(source, name);
    if (existsSync(path)) { regularFile(path); copyFileSync(path, join(scratch, name)); }
  }
  const db = new DatabaseSync(join(scratch, 'studio-k.sqlite'));
  try {
    db.exec('PRAGMA query_only=ON');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
      throw new Error('SQLite integrity_check falhou na copia restaurada.');
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('SQLite foreign_key_check encontrou referencias invalidas.');
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of ['kv', 'products', 'stock', 'orders', 'tickets', 'sessions']) {
      if (!tables.has(name)) throw new Error(`O banco restaurado nao possui a tabela esperada ${name}.`);
    }
    if (db.prepare('SELECT COUNT(*) AS count FROM kv').get().count === 0) {
      throw new Error('Banco sem configuracoes persistidas; nao iniciar como instalacao nova.');
    }
    let checkedCiphertexts = 0;
    for (const [table, column] of [['stock', 'secret'], ['youtube_accounts', 'refresh_secret'], ['member_recovery', 'refresh_secret']]) {
      if (!tables.has(table)) continue;
      const row = db.prepare(`SELECT ${column} AS cipher FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != '' LIMIT 1`).get();
      if (!row) continue;
      try {
        const encrypted = Buffer.from(row.cipher, 'base64');
        if (encrypted.length < 28) throw new Error('ciphertext invalido');
        const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
        decipher.setAuthTag(encrypted.subarray(12, 28));
        decipher.update(encrypted.subarray(28));
        decipher.final();
        checkedCiphertexts++;
      } catch {
        throw new Error(`A chave nao autentica os dados cifrados de ${table}; restaure a chave original correspondente.`);
      }
    }
    return { ok: true, integrity: 'ok', checkedCiphertexts, sourceUnmodified: true, scratch };
  } finally {
    db.close();
  }
}

function verifyEnvironment() {
  for (const name of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_GUILD_ID', 'SETUP_KEY']) {
    if (!process.env[name]?.trim()) throw new Error(`Variavel obrigatoria ausente: ${name}`);
  }
  if (process.env.STUDIO_DEMO === 'true') throw new Error('Modo demo nao e permitido neste deploy.');
  for (const name of ['PUBLIC_URL', 'PORTFOLIO_BACKEND_URL', 'PORTFOLIO_PUBLIC_URL']) {
    const url = new URL(process.env[name] || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname.endsWith('.invalid')) {
      throw new Error(`Configure uma origem HTTPS real em ${name}.`);
    }
  }
  if (new URL(process.env.PUBLIC_URL).origin !== new URL(process.env.PORTFOLIO_BACKEND_URL).origin) {
    throw new Error('PUBLIC_URL e PORTFOLIO_BACKEND_URL devem apontar para o novo backend neste deploy.');
  }
  if (process.env.STUDIO_DOMAIN !== new URL(process.env.PUBLIC_URL).hostname) {
    throw new Error('STUDIO_DOMAIN deve corresponder ao hostname de PUBLIC_URL.');
  }
  if (process.env.LIBRETRANSLATE_URL?.includes('railway.internal')) {
    throw new Error('LIBRETRANSLATE_URL ainda aponta para a rede privada do Railway.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--require-env')) verifyEnvironment();
    console.log(JSON.stringify(verifyData(process.argv[2] || process.env.DATA_DIR || './data')));
  } catch (error) {
    console.error(`PRECHECK BLOQUEADO: ${error.message}`);
    process.exitCode = 1;
  }
}
