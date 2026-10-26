import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyData } from './verify-data.mjs';

function hashFile(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const handle = openSync(path, 'r');
  let bytes = 0;
  try {
    let length;
    while ((length = readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length));
      bytes += length;
    }
  } finally { closeSync(handle); }
  return { bytes, sha256: hash.digest('hex') };
}

function fingerprint(directory, prefix = '') {
  const rows = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(prefix, entry.name);
    const path = join(directory, name);
    if (entry.isDirectory()) rows.push(...fingerprint(directory, name));
    else if (entry.isFile() && !lstatSync(path).isSymbolicLink()) {
      rows.push({ path: name.replaceAll('\\', '/'), ...hashFile(path) });
    } else throw new Error(`Arquivo especial/link nao permitido: ${name}`);
  }
  return rows;
}

try {
  if (!process.argv.includes('--offline-confirmed')) {
    throw new Error('Pare todos os processos que escrevem em data e confirme com --offline-confirmed. O script nao para servicos.');
  }
  const [sourceArgument, archiveArgument] = process.argv.slice(2).filter(value => value !== '--offline-confirmed');
  if (!sourceArgument || !archiveArgument) throw new Error('Uso: node deploy/backup-offline.mjs PASTA_DATA ARQUIVO.tar.gz --offline-confirmed');
  const source = resolve(sourceArgument);
  const archive = resolve(archiveArgument);
  if (!archive.endsWith('.tar.gz')) throw new Error('Use a extensao .tar.gz.');
  const destinationRelative = relative(source, archive);
  if (!destinationRelative || (!destinationRelative.startsWith('..') && !isAbsolute(destinationRelative))) {
    throw new Error('O arquivo de backup deve ficar fora da pasta data.');
  }
  if (existsSync(archive) || existsSync(`${archive}.sha256`) || existsSync(`${archive}.incomplete`)) {
    throw new Error('O destino ja existe; escolha um nome novo. Nenhum arquivo sera sobrescrito.');
  }
  process.umask(0o077);
  verifyData(source);
  const before = fingerprint(source);
  mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(archive), '.studio-k-snapshot-'));
  chmodSync(staging, 0o700);
  cpSync(source, join(staging, 'data'), { recursive: true, errorOnExist: true, force: false });
  const copied = fingerprint(join(staging, 'data'));
  const after = fingerprint(source);
  if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(before) !== JSON.stringify(copied)) {
    throw new Error('Os dados mudaram durante a copia. Backup nao concluido; mantenha o bot parado e repita com nome novo.');
  }
  const verification = verifyData(join(staging, 'data'));
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), offlineConfirmed: true, files: copied, integrity: verification.integrity, checkedCiphertexts: verification.checkedCiphertexts }, null, 2), { flag: 'wx', mode: 0o600 });
  const result = spawnSync('tar', ['-czf', `${archive}.incomplete`, '-C', staging, 'data', 'manifest.json'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('tar falhou; nenhum backup final foi anunciado.');
  if (JSON.stringify(before) !== JSON.stringify(fingerprint(source))) throw new Error('A origem mudou; o arquivo .incomplete nao deve ser restaurado.');
  renameSync(`${archive}.incomplete`, archive);
  chmodSync(archive, 0o600);
  const checksum = hashFile(archive).sha256;
  writeFileSync(`${archive}.sha256`, `${checksum}  ${archive.split(/[\\/]/).pop()}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ok: true, archive, checksum, fileCount: copied.length, sourceUnmodified: true, privateStagingPreserved: staging }));
} catch (error) {
  console.error(`BACKUP BLOQUEADO: ${error.message}`);
  process.exitCode = 1;
}
