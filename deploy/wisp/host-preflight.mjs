#!/usr/bin/env node
// Read-only host diagnostics. No network, writes, account tokens, or application startup.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const MiB = 1024 * 1024;
const base = '/home/container';
const cleanEnv = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const textFile = filename => { try { return fs.readFileSync(filename, 'utf8').trim(); } catch { return null; } };
function run(command, args = [], timeout = 15000) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: cleanEnv, timeout, maxBuffer: 2 * MiB });
  return { status: result.status, stdout: String(result.stdout || ''), error: result.error?.code || null };
}
function commandPath(name) {
  const result = run('/bin/sh', ['-c', 'command -v "$1"', 'host-preflight', name], 3000);
  return result.status === 0 ? result.stdout.trim() : null;
}
function bytesUsed(directory) {
  if (!fs.existsSync(directory)) return 0;
  const result = run('du', ['-sk', '--', directory]);
  const kb = Number(result.stdout.match(/^\s*(\d+)/)?.[1]);
  return result.status === 0 && Number.isFinite(kb) ? kb * 1024 : null;
}
function parseOsRelease() {
  const raw = textFile('/etc/os-release') || '';
  const result = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^(ID|VERSION_ID|VERSION_CODENAME|PRETTY_NAME)=(.*)$/);
    if (match) result[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return result;
}
function packageMetadata() {
  if (!commandPath('apt-cache')) return { available: false };
  const result = run('apt-cache', ['-o', 'Dir::Cache::pkgcache=', '-o', 'Dir::Cache::srcpkgcache=', 'show', '--no-all-versions', 'blender', 'blender-data', 'imagemagick-7.q16']);
  const allowed = new Set(['Package', 'Version', 'Architecture', 'Installed-Size', 'Size', 'Depends', 'Filename', 'SHA256']);
  const packages = [];
  for (const block of result.stdout.split(/\n\s*\n/)) {
    const item = {};
    for (const line of block.split('\n')) {
      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (match && allowed.has(match[1])) item[match[1]] = match[2];
    }
    if (item.Package) packages.push(item);
  }
  return { available: packages.length > 0, packages, note: 'Only already cached metadata; no apt update or network was run.' };
}

const commandNames = ['node', 'apt-get', 'apt-cache', 'dpkg-deb', 'dpkg-query', 'gpgv', 'sha256sum', 'du', 'df', 'tar', 'xz', 'curl', 'python3', 'cc', 'ldd', 'cargo', 'rustc', 'blender', 'convert', 'magick'];
const commands = Object.fromEntries(commandNames.map(name => [name, commandPath(name)]));
const installed = run('dpkg-query', ['-W', '-f=${Package}\t${Version}\n', 'libc6', 'libstdc++6', 'libpython3.13', 'python3.13', 'ffmpeg', 'libavcodec61', 'libavdevice61', 'libavformat61', 'libepoxy0', 'libembree4-4', 'libopenimageio2.5', 'libopenvdb10.0t64', 'blender', 'blender-data', 'imagemagick-7.q16']);
let sqlite;
try {
  const module = await import('node:sqlite');
  sqlite = { databaseSync: typeof module.DatabaseSync, backup: typeof module.backup };
} catch (error) { sqlite = { error: error.code || error.name }; }
let disk = null;
try {
  const stat = fs.statfsSync(base, { bigint: true });
  disk = { availableBytes: String(stat.bavail * stat.bsize), filesystemTotalBytes: String(stat.blocks * stat.bsize), note: 'Filesystem totals can describe the host; the panel quota must also be respected.' };
} catch { /* Report unsupported or inaccessible filesystem without writing. */ }
const homeUsedBytes = bytesUsed(base);
const toolsUsedBytes = bytesUsed(path.join(base, '.studio-host-tools'));
let writable = false;
try { fs.accessSync(base, fs.constants.W_OK); writable = true; } catch { /* No write attempt. */ }
const report = {
  kind: 'studio-k-host-preflight', readOnly: true, networkUsed: false,
  os: parseOsRelease(), platform: process.platform, architecture: process.arch,
  node: process.versions.node, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null,
  currentDirectory: process.cwd(), baseDirectory: base, baseWritable: writable, sqlite,
  memory: {
    processRssBytes: process.memoryUsage().rss,
    processConstrainedBytes: process.constrainedMemory?.() ?? null,
    hostTotalBytes: os.totalmem(),
    cgroupV2: { maximum: textFile('/sys/fs/cgroup/memory.max'), high: textFile('/sys/fs/cgroup/memory.high'), current: textFile('/sys/fs/cgroup/memory.current'), swapMaximum: textFile('/sys/fs/cgroup/memory.swap.max'), cpuMaximum: textFile('/sys/fs/cgroup/cpu.max') },
    cgroupV1: { maximum: textFile('/sys/fs/cgroup/memory/memory.limit_in_bytes'), current: textFile('/sys/fs/cgroup/memory/memory.usage_in_bytes') },
  },
  disk: { ...disk, homeUsedBytes, toolsUsedBytes, panelQuotaAssumedBytes: 1024 * MiB, reserveFreeBytes: 130 * MiB, verifiedDataBytes: 149507031, verifiedDataPath: path.join(base, 'data'), allToolsCeilingBytes: 700 * MiB, note: 'Installer credits only the measured restored data directory against its known data allocation; before restoration it reserves the missing bytes additionally.' },
  commands,
  versions: { ldd: commands.ldd ? run(commands.ldd, ['--version'], 3000).stdout.split('\n')[0] : null, python: commands.python3 ? run(commands.python3, ['--version'], 3000).stdout.trim() : null },
  debianKeyringPresent: fs.existsSync('/usr/share/keyrings/debian-archive-keyring.gpg'),
  installedPackages: installed.stdout.trim().split('\n').filter(Boolean),
  cachedCandidates: packageMetadata(),
  notes: ['No process.env values are printed.', 'No database, encryption key, credentials, or application data were opened.', 'No command in this script installs packages or contacts a network service.'],
};
console.log(JSON.stringify(report, null, 2));
