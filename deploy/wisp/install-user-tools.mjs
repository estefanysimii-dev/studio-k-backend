#!/usr/bin/env node
// Optional, bounded user-space preparation. Nothing runs unless a mode is explicit.
// Never installs system packages, runs maintainer scripts, or starts the app.
// Only --stream-install removes its OWN newly downloaded .deb after signed hash + payload verification.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MiB = 1024 * 1024;
const BASE = '/home/container';
const TOOLS = path.join(BASE, '.studio-host-tools');
const QUOTA = 1024 * MiB;
const RESERVE = 130 * MiB;
const CEILING = 700 * MiB;
const MARGIN = 16 * MiB;
const STREAM_SLACK = 1.05;
const KNOWN_DATA_BYTES = 149507031;
const RESTORED_DATA = path.join(BASE, 'data');
const TARGETS = { all: ['blender', 'imagemagick-7.q16'], blender: ['blender'], imagemagick: ['imagemagick-7.q16'] };
const forbiddenPackages = /^(libc6|libc-bin|libc-dev-bin|libc6-dev|base-files|apt|dpkg|systemd|init-system-helpers|debian-archive-keyring)$/;
const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' };
let stage = null;
let aptEnv = null;
let streamMode = false;
let streamJournal = null;
const generatedDebs = new Map();
let cpuBaseline = null;
const CPU_SHARE = 0.12;
const CPU_BURST_US = 20000;

function cpuUsageMicros() {
  const stat = fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8');
  const value = stat.match(/^usage_usec\s+(\d+)$/m)?.[1];
  if (!value || !Number.isSafeInteger(Number(value))) fail('A readable cgroup v2 CPU counter is required for bounded installation.');
  return Number(value);
}
function cpuWaitMicros(used, elapsed) {
  return Math.max(0, (used - CPU_BURST_US) / CPU_SHARE - elapsed);
}
function nextCpuBalance(balance, used, elapsed) {
  return Math.max(-CPU_BURST_US, balance + used - elapsed * CPU_SHARE);
}
function cpuDebt() {
  if (!cpuBaseline) cpuBaseline = { used: cpuUsageMicros(), at: process.hrtime.bigint(), balance: -CPU_BURST_US };
  const usedNow = cpuUsageMicros(), atNow = process.hrtime.bigint();
  const used = usedNow - cpuBaseline.used;
  const elapsed = Number(atNow - cpuBaseline.at) / 1000;
  if (used < 0) fail('CPU accounting counter moved backwards.');
  const balance = nextCpuBalance(cpuBaseline.balance, used, elapsed);
  cpuBaseline = { used: usedNow, at: atNow, balance };
  return Math.max(0, balance) / CPU_SHARE;
}
async function coolCpu() {
  let debt;
  while ((debt = cpuDebt()) > 0) await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(20, debt / 1000))));
}

function fail(message) { throw new Error(message); }
function log(message) { console.log(`[host-tools] ${message}`); }
function availableAptVerifier(canExecute = command => {
  try { fs.accessSync(command, fs.constants.X_OK); return true; } catch { return false; }
}) {
  // Debian trixie APT prefers sqv. Let APT invoke its own verifier with the
  // matching arguments; sqv is not a command-line-compatible gpgv replacement.
  const verifier = ['/usr/bin/sqv', '/usr/bin/gpgv'].find(canExecute);
  if (!verifier) fail('APT signature verification requires the host sqv or gpgv executable; stopped without weakening authentication.');
  return verifier;
}
function parseFields(text) {
  return text.split(/\r?\n\s*\r?\n/).map(block => {
    const item = {};
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (match) item[match[1]] = match[2];
    }
    return item;
  }).filter(item => item.Package);
}
function parseInst(text) {
  if (/^Remv /m.test(text)) fail('APT proposed removing packages; stopped.');
  const result = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^Inst\s+([a-z0-9+.:~-]+)(?:\s+\[[^\]]+\])?\s+\(([^\s)]+)/);
    if (!match) continue;
    const name = match[1].split(':')[0];
    if (forbiddenPackages.test(name)) fail(`APT requires changing a core ABI/system package (${name}); stopped rather than relocating libc or system tools.`);
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(name) || !/^[A-Za-z0-9.+:~_-]+$/.test(match[2])) fail('Unexpected package/version in APT plan.');
    result.push({ name, version: match[2] });
  }
  return result;
}
function sync(command, args, env = cleanEnv, timeout = 60000) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, timeout, maxBuffer: 8 * MiB });
  if (result.status !== 0) fail(`${path.basename(command)} failed (${result.error?.code || result.status}): ${String(result.stderr || '').slice(-4000)}`);
  return result.stdout || '';
}
function du(directory) {
  if (!fs.existsSync(directory)) return 0;
  const output = sync('/usr/bin/du', ['-sk', '--', directory], cleanEnv, 20000);
  const match = output.match(/^\s*(\d+)/);
  if (!match) fail(`Cannot measure ${directory}; no reliable quota check is possible.`);
  return Number(match[1]) * 1024;
}
function projectedDataAllowance() {
  // Account for the verified 142.6 MiB backup BEFORE it exists on the server.
  // Once restored, du(BASE) already counts it; credit only this exact non-linked data directory.
  try {
    if (!fs.lstatSync(RESTORED_DATA).isDirectory() || fs.lstatSync(RESTORED_DATA).isSymbolicLink() || fs.realpathSync(RESTORED_DATA) !== RESTORED_DATA) return KNOWN_DATA_BYTES;
    for (const [name, minimum] of [['studio-k.sqlite', 100], ['encryption.key', 32]]) {
      const stat = fs.lstatSync(path.join(RESTORED_DATA, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minimum) return KNOWN_DATA_BYTES;
    }
    return Math.max(0, KNOWN_DATA_BYTES - Math.min(KNOWN_DATA_BYTES, du(RESTORED_DATA)));
  } catch { return KNOWN_DATA_BYTES; }
}
function budget(additionalBytes = 0) {
  const usedHome = du(BASE);
  const usedTools = du(TOOLS);
  const nonTools = Math.max(0, usedHome - usedTools);
  const futureDataBytes = projectedDataAllowance();
  const allowedTools = Math.min(CEILING, QUOTA - nonTools - RESERVE - futureDataBytes);
  const stat = fs.statfsSync(BASE, { bigint: true });
  const free = Number(stat.bavail * stat.bsize);
  if (allowedTools <= 0 || usedTools + additionalBytes > allowedTools || free < RESERVE + futureDataBytes + additionalBytes) {
    fail(`Budget exceeded: all tools=${usedTools}, requested extra=${additionalBytes}, allowed tools=${Math.max(0, allowedTools)}, home used=${usedHome}, physical free=${free}, future data=${futureDataBytes}. Limits: tools <=700 MiB; keep >=130 MiB free beyond the verified data allocation. Originals are never removed.`);
  }
  return { usedHome, usedTools, nonTools, futureDataBytes, knownDataBytes: KNOWN_DATA_BYTES, physicalFreeBytes: free, allowedTools, reserveBytes: RESERVE, ceilingBytes: CEILING, quotaAssumedBytes: QUOTA };
}
function mkdirNew(directory) { fs.mkdirSync(directory, { mode: 0o700 }); }
function writeNew(filename, text, mode = 0o600) { fs.writeFileSync(filename, text, { flag: 'wx', mode }); }
function shQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function withinStage(candidate) {
  const resolved = path.resolve(candidate);
  if (!stage || (resolved !== stage && !resolved.startsWith(stage + path.sep))) fail('Refused path outside the new staging directory.');
  return resolved;
}
async function checkedRun(command, args, timeout = 10 * 60000, workingDirectory = stage, label = null) {
  log(label || `${path.basename(command)} ${args.join(' ')}`);
  // Stream extraction has an exact signed-size/payload allocation guard in its
  // caller. Read-only field/inspect/verify commands do not need repeated du scans.
  // Keep live disk monitoring for APT metadata and the legacy bulk download.
  const watchDisk = command === '/usr/bin/apt-get' && (args[0] === 'update' || args.includes('--download-only'));
  if (watchDisk) budget();
  await coolCpu();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: aptEnv || cleanEnv, cwd: withinStage(workingDirectory), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', stopReason = null, forceTimer = null, paused = false;
    const append = (previous, data) => (previous + String(data)).slice(-8 * MiB);
    child.stdout.on('data', data => { output = append(output, data); });
    child.stderr.on('data', data => { errors = append(errors, data); });
    const stop = reason => {
      if (stopReason) return;
      stopReason = reason;
      try { process.kill(-child.pid, 'SIGCONT'); } catch { /* Already exited. */ }
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 1500);
      forceTimer.unref();
    };
    // Respect the host limit by pausing only our own child process group. Never
    // change cgroup settings, provider monitoring or account protections.
    const cpuMonitor = setInterval(() => {
      try {
        const mustPause = cpuDebt() > 0;
        if (mustPause !== paused) {
          process.kill(-child.pid, mustPause ? 'SIGSTOP' : 'SIGCONT');
          paused = mustPause;
        }
      } catch (error) { if (error.code !== 'ESRCH') stop(error.message); }
    }, 100);
    const monitor = watchDisk ? setInterval(() => { try { budget(); } catch (error) { stop(error.message); } }, 5000) : null;
    const timer = setTimeout(() => stop('Command time limit reached.'), timeout);
    child.once('error', error => { clearInterval(cpuMonitor); clearInterval(monitor); clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); reject(error); });
    child.once('close', code => {
      clearInterval(monitor); clearTimeout(timer);
      clearInterval(cpuMonitor);
      if (forceTimer) clearTimeout(forceTimer);
      if (stopReason || code !== 0) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group has exited. */ } }
      if (stopReason || code !== 0) reject(new Error(`${stopReason || `${path.basename(command)} exit ${code}`}\n${errors.slice(-4000)}\nOriginal data is untouched. Staging and journal preserved at ${stage}`));
      else { try { if (watchDisk) budget(); resolve(output); } catch (error) { reject(error); } }
    });
  });
}
function checkHost() {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('Only Linux x86_64 is supported.');
  if (process.getuid?.() === 0) fail('Refused root execution. Run as the normal container user.');
  const release = fs.readFileSync('/etc/os-release', 'utf8');
  if (!/^ID=["']?debian["']?$/m.test(release) || !/^VERSION_CODENAME=["']?trixie["']?$/m.test(release)) fail('Requires Debian trixie. Run host-preflight.mjs and review the actual distro first.');
  if (fs.realpathSync(BASE) !== BASE) fail('/home/container must be a real directory, not a symlink.');
  fs.accessSync(BASE, fs.constants.W_OK);
  cpuDebt();
  for (const command of ['/usr/bin/apt-get', '/usr/bin/apt-cache', '/usr/bin/dpkg-deb', '/usr/bin/du', ...(streamMode ? ['/usr/bin/python3'] : [])]) fs.accessSync(command, fs.constants.X_OK);
  const verifier = availableAptVerifier();
  fs.accessSync('/usr/share/keyrings/debian-archive-keyring.gpg', fs.constants.R_OK);
  const ram = process.constrainedMemory?.();
  log(`Host APT signature verifier available: ${verifier}; using APT's native verifier selection and signed metadata policy.`);
  log(`Node ${process.versions.node}; constrained memory=${ram || 'unknown'}; tools ceiling700 MiB; free reserve130 MiB plus verified data allocation; panel quota assumed1 GiB.`);
  return budget();
}
function configureApt(reuseStage = null, resume = false) {
  // Container UIDs may have no passwd entry. Keep APT's native sandbox policy;
  // its privileged UID-switch path only runs as root (which checkHost refuses).
  // https://sources.debian.org/src/apt/3.0.3/apt-pkg/acquire.cc/
  if (fs.existsSync(TOOLS)) {
    const stat = fs.lstatSync(TOOLS);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(TOOLS) !== TOOLS) fail('Existing .studio-host-tools is not a real local directory.');
  } else mkdirNew(TOOLS);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  if (reuseStage) {
    stage = path.resolve(reuseStage);
    if (path.dirname(stage) !== TOOLS || !path.basename(stage).startsWith('run-') || !fs.lstatSync(stage).isDirectory() || fs.lstatSync(stage).isSymbolicLink() || fs.realpathSync(stage) !== stage) fail('Reuse requires a real direct run-* child of .studio-host-tools.');
    for (const name of ['root', 'bin']) {
      const directory = withinStage(path.join(stage, name));
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory || ((!resume || name === 'bin') && fs.readdirSync(directory).length)) fail('Reuse requires empty root/bin; explicit journal resume permits only a partial root with empty bin.');
    }
    if (fs.existsSync(path.join(stage, 'result.json'))) fail('Refused reuse of an installed stage.');
  } else {
    stage = path.join(TOOLS, `run-${runId}`);
    mkdirNew(stage);
  }
  for (const relative of ['apt', 'apt/lists', 'apt/lists/partial', 'apt/archives', 'apt/archives/partial', 'apt/empty-parts', 'apt/empty-trusted', 'root', 'bin', 'tmp']) {
    const directory = withinStage(path.join(stage, relative));
    if (!fs.existsSync(directory)) mkdirNew(directory);
    else if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('Unexpected linked/non-directory APT staging path.');
  }
  const configFile = path.join(stage, `apt/config-${runId}`);
  const sourceFile = path.join(stage, `apt/sources-${runId}.list`);
  const config = [
    `Dir::Etc::main "/dev/null";`,
    `Dir::Etc::parts "${stage}/apt/empty-parts";`,
    `Dir::Etc::sourcelist "${sourceFile}";`,
    `Dir::Etc::sourceparts "${stage}/apt/empty-parts";`,
    `Dir::Etc::trusted "/usr/share/keyrings/debian-archive-keyring.gpg";`,
    `Dir::Etc::trustedparts "${stage}/apt/empty-trusted";`,
    `Dir::State::status "/var/lib/dpkg/status";`,
    `Dir::State::extended_states "${stage}/apt/extended_states";`,
    `Dir::State::lists "${stage}/apt/lists";`,
    `Dir::Cache::archives "${stage}/apt/archives";`,
    `Dir::Cache::pkgcache ""; Dir::Cache::srcpkgcache "";`,
    `Dir::Log "${stage}/apt";`,
    `Dir::Log::Terminal "${stage}/apt/term.log";`,
    `Dir::Log::History "${stage}/apt/history.log";`,
    `APT::Architecture "amd64"; APT::Architectures { "amd64"; };`,
    `APT::Get::AllowUnauthenticated "false";`,
    `APT::Update::Error-Mode "any";`,
    `APT::Install-Recommends "false"; APT::Install-Suggests "false";`,
    `Acquire::AllowInsecureRepositories "false";`,
    `Acquire::AllowDowngradeToInsecureRepositories "false";`,
    `Acquire::Check-Valid-Until "true";`,
    `Acquire::https::Verify-Peer "true"; Acquire::https::Verify-Host "true";`,
    `Acquire::http::Proxy "DIRECT"; Acquire::https::Proxy "DIRECT";`,
    `Acquire::Languages "none"; Acquire::PDiffs "false"; Acquire::GzipIndexes "true";`,
    `Acquire::IndexTargets::deb::DEP-11::DefaultEnabled "false";`,
    `Acquire::IndexTargets::deb::CNF::DefaultEnabled "false";`,
    `Acquire::Retries "1"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";`,
    `Debug::NoLocking "true";`,
  ].join('\n') + '\n';
  writeNew(configFile, config);
  writeNew(sourceFile, [
    'deb [arch=amd64 signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main',
    'deb [arch=amd64 signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie-updates main',
    'deb [arch=amd64 signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://security.debian.org/debian-security trixie-security main',
    '',
  ].join('\n'));
  aptEnv = { ...cleanEnv, APT_CONFIG: configFile };
  log(`${resume ? 'Resuming partial' : reuseStage ? 'Reused empty PLAN' : 'New'} staging: ${stage}; application data remain untouched; CPU target12% of one core.`);
}
function streamEstimate(packages) {
  const order = [...packages].sort((a, b) => b.downloadBytes - a.downloadBytes || a.name.localeCompare(b.name));
  let extracted = 0, peak = 0;
  for (const item of order) {
    const installedWithSlack = Math.ceil(item.installedBytesEstimate * STREAM_SLACK);
    // Only this one archive coexists with the extracted prefix; it is removed after verification.
    peak = Math.max(peak, extracted + item.downloadBytes + installedWithSlack + MARGIN);
    extracted += installedWithSlack;
  }
  return { order, peakExtraBytes: peak, finalExtraBytesWithSlack: extracted + MARGIN };
}
async function createPlan(targets) {
  await checkedRun('/usr/bin/apt-get', ['update']);
  const args = ['--simulate', '--yes', '--no-install-recommends', '--no-remove', 'install', ...targets];
  const simulation = await checkedRun('/usr/bin/apt-get', args, 120000);
  const selected = parseInst(simulation);
  if (!selected.length) fail('APT selected no archives. Existing system installation may already provide these tools; inspect the preflight instead.');
  const metadataText = await checkedRun('/usr/bin/apt-cache', ['show', ...selected.map(item => `${item.name}=${item.version}`)], 120000);
  const metadata = parseFields(metadataText);
  const packages = selected.map(item => {
    const match = metadata.find(record => record.Package === item.name && record.Version === item.version && ['amd64', 'all'].includes(record.Architecture));
    if (!match || !/^\d+$/.test(match['Installed-Size'] || '') || !/^\d+$/.test(match.Size || '') || !/^[a-f0-9]{64}$/i.test(match.SHA256 || '') || !/^pool\//.test(match.Filename || '') || match.Filename.includes('..')) fail(`Missing authenticated size/hash metadata for ${item.name}.`);
    return { name: item.name, version: item.version, architecture: match.Architecture, downloadBytes: Number(match.Size), installedBytesEstimate: Number(match['Installed-Size']) * 1024, sha256: match.SHA256.toLowerCase() };
  });
  const downloadBytes = packages.reduce((total, item) => total + item.downloadBytes, 0);
  const installedBytesEstimate = packages.reduce((total, item) => total + item.installedBytesEstimate, 0);
  const streaming = streamEstimate(packages);
  // Legacy mode retains all archives. Stream mode budgets each package's download + extraction peak.
  const extraBytesRequired = streamMode ? streaming.peakExtraBytes : downloadBytes + Math.ceil(installedBytesEstimate * 1.12) + MARGIN;
  const current = budget();
  const fits = current.usedTools + extraBytesRequired <= current.allowedTools && current.physicalFreeBytes >= RESERVE + current.futureDataBytes + extraBytesRequired;
  const planFile = path.join(stage, fs.existsSync(path.join(stage, 'plan.json')) ? `plan-${Date.now()}-${process.pid}.json` : 'plan.json');
  const plan = { mode: streamMode ? 'stream-download-extract-verify-cache-delete' : 'download-and-extract-only', stage, planFile, targets, packages: streamMode ? streaming.order : packages, downloadBytes, installedBytesEstimate, installedSlackFactor: streamMode ? STREAM_SLACK : 1.12, marginBytes: MARGIN, extraBytesRequired, streamFinalExtraBytesWithSlack: streaming.finalExtraBytesWithSlack, fits, budget: current, limits: { allToolsBytes: CEILING, reserveFreeBytes: RESERVE, verifiedDataBytes: KNOWN_DATA_BYTES, homeQuotaAssumedBytes: QUOTA }, systemPackagesChanged: false, deletesFiles: streamMode, deletionScope: streamMode ? 'Only new per-package .deb cache files registered during this invocation, after signed SHA256 and complete extracted-payload verification.' : 'none' };
  writeNew(planFile, JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify(plan, null, 2));
  return plan;
}
async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) { hash.update(chunk); await coolCpu(); }
  return hash.digest('hex');
}
function extractedPath(candidate, root, realpath = fs.realpathSync) {
  const boundary = path.resolve(root), requested = path.resolve(candidate);
  if (requested !== boundary && !requested.startsWith(boundary + path.sep)) fail('Refused wrapper path outside extracted root.');
  if (realpath(boundary) !== boundary) fail('Extracted root resolves through an unexpected symlink.');
  const resolved = realpath(requested);
  if (resolved !== boundary && !resolved.startsWith(boundary + path.sep)) fail('Refused symlink/alternatives escape outside extracted root.');
  return resolved;
}
function findDirectory(root, suffix, maxDepth = 5) {
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const { directory, depth } = queue.shift();
    if (!fs.existsSync(directory)) continue;
    const safeDirectory = extractedPath(directory, path.join(stage, 'root'));
    if (directory.endsWith(suffix)) return safeDirectory;
    if (depth >= maxDepth) continue;
    for (const entry of fs.readdirSync(safeDirectory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push({ directory: path.join(safeDirectory, entry.name), depth: depth + 1 });
  }
  return null;
}
function createWrappers() {
  const root = path.join(stage, 'root');
  extractedPath(root, root);
  const safe = candidate => extractedPath(candidate, root);
  const libraries = [path.join(root, 'usr/lib/x86_64-linux-gnu'), path.join(root, 'lib/x86_64-linux-gnu'), path.join(root, 'usr/lib')].filter(filename => fs.existsSync(filename)).map(safe).join(':');
  const preamble = `#!/bin/sh\nset -eu\nexport LD_LIBRARY_PATH=${shQuote(libraries)}\n`;
  const wrappers = [];
  let blender = path.join(root, 'usr/bin/blender');
  if (fs.existsSync(blender)) {
    blender = safe(blender);
    const scripts = findDirectory(path.join(root, 'usr/share/blender'), '/scripts');
    const datafiles = findDirectory(path.join(root, 'usr/share/blender'), '/datafiles');
    if (!scripts || !datafiles) fail('Blender scripts/datafiles were not found after extraction; stopped without activating anything.');
    writeNew(path.join(stage, 'bin/blender'), preamble + `export BLENDER_SYSTEM_SCRIPTS=${shQuote(scripts)}\nexport BLENDER_SYSTEM_DATAFILES=${shQuote(datafiles)}\nexec ${shQuote(blender)} "$@"\n`, 0o700);
    wrappers.push('blender');
  }
  const executable = names => {
    const candidate = names.map(name => path.join(root, 'usr/bin', name)).find(filename => fs.existsSync(filename));
    return candidate ? safe(candidate) : null;
  };
  const magick = executable(['magick-im7.q16', 'magick-im6.q16', 'magick']);
  const convert = executable(['convert-im7.q16', 'convert-im6.q16', 'convert']);
  if (magick || convert) {
    const config = ['ImageMagick-7', 'ImageMagick-6'].map(name => path.join(root, 'etc', name)).find(filename => fs.existsSync(filename));
    const coders = findDirectory(path.join(root, 'usr/lib'), '/coders');
    const filters = findDirectory(path.join(root, 'usr/lib'), '/filters');
    let environment = preamble;
    if (config) environment += `export MAGICK_CONFIGURE_PATH=${shQuote(safe(config))}\n`;
    if (coders) environment += `export MAGICK_CODER_MODULE_PATH=${shQuote(coders)}\n`;
    if (filters) environment += `export MAGICK_FILTER_MODULE_PATH=${shQuote(filters)}\n`;
    if (magick) { writeNew(path.join(stage, 'bin/magick'), environment + `exec ${shQuote(magick)} "$@"\n`, 0o700); wrappers.push('magick'); }
    // The existing application invokes convert; do not rely on Debian alternatives/postinst.
    writeNew(path.join(stage, 'bin/convert'), environment + `exec ${shQuote(convert || magick)} "$@"\n`, 0o700);
    wrappers.push('convert');
  }
  if (!wrappers.length) fail('No converter executable was found after extraction.');
  writeNew(path.join(stage, 'env.sh'), `# Optional. Adds only wrapper commands; LD_LIBRARY_PATH is scoped inside each wrapper.\nexport PATH=${shQuote(path.join(stage, 'bin'))}:"$PATH"\n`, 0o600);
  return wrappers;
}
async function install(plan) {
  if (!plan.fits) fail('Plan exceeds the budget; no binary archives were downloaded or extracted. Review plan.json.');
  budget(plan.extraBytesRequired);
  await checkedRun('/usr/bin/apt-get', ['--yes', '--download-only', '--no-install-recommends', '--no-remove', 'install', ...plan.targets]);
  const archives = fs.readdirSync(path.join(stage, 'apt/archives')).filter(name => name.endsWith('.deb')).sort();
  if (archives.length !== plan.packages.length) fail('Downloaded archive count differs from the plan; stopped.');
  const validated = [];
  for (const name of archives) {
    const filename = withinStage(path.join(stage, 'apt/archives', name));
    if (!fs.lstatSync(filename).isFile()) fail('An archive is not a regular file.');
    const fields = parseFields(await checkedRun('/usr/bin/dpkg-deb', ['--field', filename, 'Package', 'Version', 'Architecture', 'Installed-Size'], 60000))[0];
    const expected = plan.packages.find(item => item.name === fields?.Package && item.version === fields?.Version && item.architecture === fields?.Architecture);
    if (!expected || fs.statSync(filename).size !== expected.downloadBytes || await sha256(filename) !== expected.sha256) fail(`Archive metadata/hash mismatch: ${name}.`);
    validated.push({ filename, expected });
  }
  // Every archive is verified against signed APT metadata before any extraction.
  for (const { filename, expected } of validated) {
    budget(Math.ceil(expected.installedBytesEstimate * 1.12) + MARGIN);
    await checkedRun('/usr/bin/dpkg-deb', ['--extract', filename, withinStage(path.join(stage, 'root'))]);
  }
  const wrappers = createWrappers();
  const finalBudget = budget();
  const result = { stage, wrappers, budget: finalBudget, systemModified: false, applicationModified: false, filesDeleted: false, convertersExecuted: false, status: 'Extracted; loader/version checks and representative conversions are still required.', activation: `. ${shQuote(path.join(stage, 'env.sh'))}` };
  writeNew(path.join(stage, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
const PAYLOAD_CHECK = String.raw`
import hashlib, json, os, posixpath, stat, subprocess, sys, tarfile
mode, archive, root, *options = sys.argv[1:]
block = int(options[0]) if options else 4096
if block < 512 or block > 1048576: raise RuntimeError('unexpected-filesystem-block-size')
if mode not in ('inspect', 'verify'): raise RuntimeError('bad-payload-mode')
root = os.path.realpath(root)
seen = set()
payload_links = set()
counts = {'regularFiles': 0, 'directories': 0, 'symlinks': 0, 'fileBytes': 0, 'allocatedBytesEstimate': 0}
def normalized(raw):
    if raw.startswith('/') or '\\' in raw or any(ord(c) < 32 for c in raw): raise RuntimeError('unsafe-payload-path')
    parts = [p for p in raw.split('/') if p not in ('', '.')]
    if '..' in parts: raise RuntimeError('payload-traversal')
    return '/'.join(parts)
def bounded(name):
    target = os.path.join(root, *name.split('/')) if name else root
    parts = name.split('/') if name else []
    for index in range(1, len(parts)):
        ancestor = '/'.join(parts[:index])
        if ancestor in payload_links or os.path.islink(os.path.join(root, *parts[:index])):
            raise RuntimeError('payload-symlink-ancestor')
    if os.path.commonpath([root, os.path.realpath(target)]) != root: raise RuntimeError('payload-symlink-escape')
    return target
def digest(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(262144), b''): h.update(chunk)
    return h.digest()
p = subprocess.Popen(['/usr/bin/dpkg-deb', '--fsys-tarfile', archive], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
payload = None
try:
    payload = tarfile.open(fileobj=p.stdout, mode='r|')
    for member in payload:
        if len(seen) >= 100000: raise RuntimeError('payload-entry-limit')
        name = normalized(member.name)
        if not name:
            if not member.isdir(): raise RuntimeError('empty-payload-filename')
            continue
        if name in seen: raise RuntimeError('duplicate-payload-path')
        if member.issym() and any(previous.startswith(name + '/') for previous in seen): raise RuntimeError('payload-symlink-over-existing-descendant')
        seen.add(name)
        if member.mode & 0o6000: raise RuntimeError('privileged-payload-mode')
        if not (member.isdir() or member.isreg() or member.issym()) or member.islnk(): raise RuntimeError('payload-special-file-or-hardlink')
        target = bounded(name)
        if member.issym():
            link = member.linkname
            if not link or link.startswith('/') or '\\' in link or any(ord(c) < 32 for c in link): raise RuntimeError('unsafe-payload-link')
            linked = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
            if linked == '..' or linked.startswith('../') or linked.startswith('/'): raise RuntimeError('payload-link-traversal')
            bounded(linked)
            payload_links.add(name)
            counts['symlinks'] += 1
            counts['allocatedBytesEstimate'] += block
            if mode == 'verify' and (not os.path.islink(target) or os.readlink(target) != link): raise RuntimeError('extracted-link-mismatch')
        elif member.isdir():
            if os.path.islink(target): raise RuntimeError('payload-directory-over-existing-link')
            counts['directories'] += 1
            counts['allocatedBytesEstimate'] += block
            if mode == 'verify' and not stat.S_ISDIR(os.lstat(target).st_mode): raise RuntimeError('extracted-directory-mismatch')
        else:
            if os.path.islink(target): raise RuntimeError('payload-file-over-existing-link')
            if member.size < 0 or member.size > 1073741824: raise RuntimeError('payload-size-limit')
            counts['regularFiles'] += 1
            counts['fileBytes'] += member.size
            counts['allocatedBytesEstimate'] += ((member.size + block - 1) // block) * block
            if mode == 'verify':
                info = os.lstat(target)
                if not stat.S_ISREG(info.st_mode) or info.st_size != member.size: raise RuntimeError('extracted-file-type-or-size-mismatch')
                source = payload.extractfile(member)
                with source, open(target, 'rb') as restored:
                    if digest(source) != digest(restored): raise RuntimeError('extracted-file-sha256-mismatch')
    # Drain padding so dpkg/xz finish their own integrity checks rather than receiving SIGPIPE.
    padding = 0
    while True:
        chunk = p.stdout.read(65536)
        if not chunk: break
        padding += len(chunk)
        if padding > 1048576: raise RuntimeError('excess-payload-padding')
    payload.close()
    p.stdout.close()
    if p.wait(timeout=10) != 0: raise RuntimeError('dpkg-payload-stream-failed')
    print(json.dumps({'ok': True, 'mode': mode, **counts}))
finally:
    if payload is not None: payload.close()
    if p.poll() is None:
        p.terminate()
        try: p.wait(timeout=3)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
`;
function recordStream(event) {
  if (!streamJournal) fail('Stream journal is not initialized.');
  fs.appendFileSync(streamJournal, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
}
async function verifyDeb(filename, expected) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.downloadBytes || await sha256(filename) !== expected.sha256) fail(`Signed archive size/SHA256 mismatch: ${expected.name}.`);
  const fields = parseFields(await checkedRun('/usr/bin/dpkg-deb', ['--field', filename, 'Package', 'Version', 'Architecture', 'Installed-Size'], 60000))[0];
  if (!fields || fields.Package !== expected.name || fields.Version !== expected.version || fields.Architecture !== expected.architecture || Number(fields['Installed-Size']) * 1024 !== expected.installedBytesEstimate) fail(`Archive control metadata differs from signed plan: ${expected.name}.`);
  return stat;
}
async function checkPayload(filename, mode) {
  const block = String(fs.statfsSync(BASE).bsize);
  const output = await checkedRun('/usr/bin/python3', ['-I', '-c', PAYLOAD_CHECK, mode, filename, withinStage(path.join(stage, 'root')), block], 10 * 60000, stage, `dpkg-deb payload ${mode}: ${path.basename(filename)} (no maintainer scripts)`);
  let result;
  try { result = JSON.parse(output.trim()); } catch { fail('Payload verification did not return valid JSON.'); }
  if (result.ok !== true || result.mode !== mode) fail('Payload verification did not succeed.');
  return result;
}
function generatedDebPathAllowed(filename, record, realpath = fs.realpathSync) {
  if (!record || !filename.endsWith('.deb') || path.dirname(filename) !== record.packageDirectory) return false;
  const boundary = path.resolve(record.cacheRoot);
  if (path.resolve(record.packageDirectory) === boundary || !path.resolve(record.packageDirectory).startsWith(boundary + path.sep)) return false;
  try { return realpath(boundary) === boundary && realpath(filename) === path.resolve(filename); } catch { return false; }
}
async function deleteVerifiedGeneratedDeb(filename) {
  const record = generatedDebs.get(filename);
  if (!record?.payloadVerified || !generatedDebPathAllowed(filename, record)) fail('Refused cleanup outside this invocation\'s new registered .deb cache.');
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== record.dev || stat.ino !== record.ino || stat.size !== record.size || await sha256(filename) !== record.sha256) fail('Generated archive changed; retained without deleting.');
  recordStream({ event: 'verified-cache-delete-intent', package: record.name, file: filename, sha256: record.sha256, bytes: stat.size });
  // This is the ONLY deletion in this script. Never recurse, delete directories, or touch originals.
  fs.unlinkSync(filename);
  generatedDebs.delete(filename);
  recordStream({ event: 'verified-cache-deleted', package: record.name, file: filename, bytes: stat.size });
  return stat.size;
}
function verifiedPrefix(events, packages) {
  if (!events.length || events[0].event !== 'begin') fail('Resume journal must begin with a begin record.');
  const receipts = events[0].previousReceipts || [];
  if (!Array.isArray(receipts) || receipts.length > packages.length) fail('Invalid inherited receipts.');
  for (const [index, receipt] of receipts.entries()) {
    const expected = packages[index];
    if (receipt.package !== expected.name || receipt.version !== expected.version || receipt.archiveSha256 !== expected.sha256 || receipt.payload?.ok !== true || receipt.payload?.mode !== 'verify') fail('Inherited receipt differs from the authenticated package plan.');
  }
  let signed = null, payload = null, intent = null;
  for (const event of events.slice(1)) {
    if (event.event === 'complete') fail('A completed installation cannot be resumed.');
    const expected = packages[receipts.length];
    if (!expected || event.package !== expected.name) fail('Journal is not a contiguous prefix of the package plan.');
    if (event.event === 'signed-archive-verified') {
      if (signed || payload || intent || event.sha256 !== expected.sha256 || event.bytes !== expected.downloadBytes) fail('Invalid signed archive receipt.');
      signed = event;
    } else if (event.event === 'payload-verified') {
      if (!signed || payload || event.ok !== true || event.mode !== 'verify') fail('Missing successful payload verification receipt.');
      for (const field of ['regularFiles', 'directories', 'symlinks', 'fileBytes', 'allocatedBytesEstimate']) if (!Number.isSafeInteger(event[field]) || event[field] < 0) fail('Invalid verified payload counts.');
      payload = event;
    } else if (event.event === 'verified-cache-delete-intent') {
      if (!payload || intent || event.file !== signed.file || event.sha256 !== signed.sha256 || event.bytes !== signed.bytes) fail('Invalid verified cleanup intent.');
      intent = event;
    } else if (event.event === 'verified-cache-deleted') {
      if (!intent || event.file !== signed.file || event.bytes !== signed.bytes) fail('Missing verified cache deletion receipt.');
      receipts.push({ package: expected.name, version: expected.version, archiveSha256: expected.sha256, payload });
      signed = payload = intent = null;
    } else fail('Unknown stream journal event.');
  }
  return receipts;
}
function readStageJson(filename, jsonLines = false) {
  const resolved = withinStage(path.resolve(filename));
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved || stat.size > 4 * MiB) fail('Resume inputs must be regular local stage files smaller than4 MiB.');
  const content = fs.readFileSync(resolved, 'utf8');
  return jsonLines ? content.trim().split('\n').map(line => JSON.parse(line)) : JSON.parse(content);
}
async function resumePlan(planFilename, journalFilename, targets) {
  const plan = readStageJson(planFilename);
  if (plan.mode !== 'stream-download-extract-verify-cache-delete' || plan.stage !== stage || JSON.stringify(plan.targets) !== JSON.stringify(targets) || !Array.isArray(plan.packages) || !plan.packages.length || plan.packages.length > 500) fail('Resume plan does not describe this stage and target selection.');
  const names = new Set();
  for (const item of plan.packages) {
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(item.name) || forbiddenPackages.test(item.name) || names.has(item.name) || !/^[A-Za-z0-9.+:~_-]+$/.test(item.version) || !['amd64', 'all'].includes(item.architecture) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.downloadBytes) || item.downloadBytes <= 0 || !Number.isSafeInteger(item.installedBytesEstimate) || item.installedBytesEstimate <= 0) fail('Invalid resume package metadata.');
    names.add(item.name);
  }
  // Refresh signed repository metadata, then independently bind every old receipt
  // to the exact version/hash still authenticated by APT. No stale-hash fallback.
  await checkedRun('/usr/bin/apt-get', ['update']);
  const metadata = parseFields(await checkedRun('/usr/bin/apt-cache', ['show', ...plan.packages.map(item => `${item.name}=${item.version}`)], 120000));
  for (const item of plan.packages) {
    const record = metadata.find(row => row.Package === item.name && row.Version === item.version && row.Architecture === item.architecture);
    if (!record || record.SHA256?.toLowerCase() !== item.sha256 || Number(record.Size) !== item.downloadBytes || Number(record['Installed-Size']) * 1024 !== item.installedBytesEstimate) fail(`Resume metadata no longer authenticated for ${item.name}; original stage retained.`);
  }
  const receipts = verifiedPrefix(readStageJson(journalFilename, true), plan.packages);
  if (!receipts.length || receipts.length === plan.packages.length) fail('Resume requires a nonempty, incomplete verified prefix.');
  const estimate = streamEstimate(plan.packages.slice(receipts.length));
  const current = budget();
  const extraBytesRequired = estimate.peakExtraBytes;
  const fits = current.usedTools + extraBytesRequired <= current.allowedTools && current.physicalFreeBytes >= RESERVE + current.futureDataBytes + extraBytesRequired;
  log(`Resume: ${receipts.length}/${plan.packages.length} earlier packages already verified; remaining peak extra=${extraBytesRequired}; fits=${fits}.`);
  return { ...plan, fits, extraBytesRequired, previousReceipts: receipts, resumedFrom: withinStage(path.resolve(journalFilename)) };
}
function parseDownloadUris(text, packages) {
  const result = new Map();
  for (const line of text.split('\n')) {
    if (!line.startsWith("'")) continue;
    const match = line.match(/^'([^']+)'\s+(\S+)\s+(\d+)(?:\s+.*)?$/);
    if (!match) fail('Unexpected APT download URI line.');
    const url = new URL(match[1]);
    const filename = decodeURIComponent(url.pathname.split('/').pop());
    const name = filename.split('_')[0], expected = packages.find(item => item.name === name);
    if (url.protocol !== 'https:' || !['deb.debian.org', 'security.debian.org'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !/^[A-Za-z0-9_%.+:~=-]+\.deb$/.test(filename) || !expected || Number(match[3]) !== expected.downloadBytes || result.has(name)) fail('APT URI does not match the authenticated archive/official HTTPS repository.');
    result.set(name, url.href);
  }
  if (result.size !== packages.length) fail('APT did not print exactly one download URI per remaining package.');
  return result;
}
async function downloadSignedArchive(url, filename, expected) {
  log(`Download authenticated archive ${expected.name}: ${expected.downloadBytes} bytes.`);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5 * 60000) });
  if (response.status !== 200 || !response.body) fail(`Official archive download failed for ${expected.name}: HTTP ${response.status}.`);
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) !== expected.downloadBytes) fail('Archive Content-Length differs from signed metadata.');
  let total = 0;
  async function* boundedBody() {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > expected.downloadBytes) fail('Archive exceeds its signed size; partial file retained.');
      await coolCpu();
      yield chunk;
    }
  }
  await pipeline(Readable.from(boundedBody()), fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
  if (total !== expected.downloadBytes) fail('Archive is incomplete; partial file retained.');
}
async function streamInstall(plan) {
  if (!plan.fits) fail('Streaming plan exceeds actual quota/reserve. No binary archives were downloaded; inspect the new plan.');
  budget(plan.extraBytesRequired);
  const session = `${Date.now()}-${process.pid}`;
  const cacheRoot = withinStage(path.join(stage, `stream-cache-${session}`));
  mkdirNew(cacheRoot);
  streamJournal = withinStage(path.join(stage, `stream-journal-${session}.jsonl`));
  writeNew(streamJournal, '');
  recordStream({ event: 'begin', resumedFrom: plan.resumedFrom || null, previousReceipts: plan.previousReceipts || [], cpuShareTarget: CPU_SHARE, policy: 'Largest compressed archive first; signed SHA256 before extraction; complete payload SHA256/type/link verification before deleting only the new generated .deb.' });
  let deletedBytes = 0, deletedArchives = 0;
  const receipts = [...(plan.previousReceipts || [])];
  // Resolve all official archive URLs once. Re-reading the full APT index for
  // every tiny package wastes CPU on this host. APT authenticates the metadata;
  // each fetched byte stream still requires its exact signed SHA256 below.
  const remaining = plan.packages.slice(receipts.length);
  const uris = parseDownloadUris(await checkedRun('/usr/bin/apt-get', ['--print-uris', 'download', ...remaining.map(item => `${item.name}=${item.version}`)], 120000), remaining);
  for (const [index, expected] of plan.packages.entries()) {
    if (index < (plan.previousReceipts?.length || 0)) continue;
    const packageDirectory = withinStage(path.join(cacheRoot, `${String(index).padStart(3, '0')}-${expected.name}`));
    mkdirNew(packageDirectory);
    budget(expected.downloadBytes + Math.ceil(expected.installedBytesEstimate * STREAM_SLACK) + MARGIN);
    await downloadSignedArchive(uris.get(expected.name), withinStage(path.join(packageDirectory, `${expected.name}.deb`)), expected);
    const archives = fs.readdirSync(packageDirectory).filter(name => name.endsWith('.deb'));
    if (archives.length !== 1 || fs.readdirSync(packageDirectory).length !== 1) fail('Expected exactly one new generated .deb in the empty per-package cache.');
    const filename = withinStage(path.join(packageDirectory, archives[0]));
    const identity = await verifyDeb(filename, expected);
    generatedDebs.set(filename, { cacheRoot, packageDirectory, name: expected.name, sha256: expected.sha256, dev: identity.dev, ino: identity.ino, size: identity.size, payloadVerified: false });
    recordStream({ event: 'signed-archive-verified', package: expected.name, file: filename, bytes: identity.size, sha256: expected.sha256 });
    const inspected = await checkPayload(filename, 'inspect');
    budget(Math.max(Math.ceil(expected.installedBytesEstimate * STREAM_SLACK), inspected.allocatedBytesEstimate) + MARGIN);
    await checkedRun('/usr/bin/dpkg-deb', ['--extract', filename, withinStage(path.join(stage, 'root'))]);
    const verified = await checkPayload(filename, 'verify');
    for (const field of ['regularFiles', 'directories', 'symlinks', 'fileBytes', 'allocatedBytesEstimate']) if (verified[field] !== inspected[field]) fail('Extracted payload differs from its inspected archive.');
    generatedDebs.get(filename).payloadVerified = true;
    recordStream({ event: 'payload-verified', package: expected.name, ...verified });
    deletedBytes += await deleteVerifiedGeneratedDeb(filename);
    deletedArchives++;
    receipts.push({ package: expected.name, version: expected.version, archiveSha256: expected.sha256, payload: verified });
    log(`Verified ${index + 1}/${plan.packages.length}: ${expected.name}; its generated .deb cache was removed.`);
    budget();
  }
  const wrappers = createWrappers();
  const result = { stage, wrappers, budget: budget(), streamJournal, resumedFrom: plan.resumedFrom || null, previouslyVerifiedPackages: plan.previousReceipts?.length || 0, cpuShareTarget: CPU_SHARE, deletedGeneratedArchives: deletedArchives, deletedGeneratedBytes: deletedBytes, deletionScope: 'Only new registered .deb cache files with matching inode, signed SHA256, and fully verified extracted payload.', preservedOriginals: true, systemModified: false, applicationModified: false, filesDeleted: true, convertersExecuted: false, status: 'Extracted and payload-verified; loader/version checks and representative conversions still required.', activation: `. ${shQuote(path.join(stage, 'env.sh'))}`, receipts };
  writeNew(path.join(stage, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  recordStream({ event: 'complete', deletedGeneratedArchives: deletedArchives, deletedGeneratedBytes: deletedBytes });
  console.log(JSON.stringify(result, null, 2));
}
function selfTest() {
  const fixtureRoot = path.resolve('/synthetic-extracted-root');
  const linkedCommand = path.join(fixtureRoot, 'usr/bin/convert');
  const insideCommand = path.join(fixtureRoot, 'usr/bin/convert-im7.q16');
  const outsideCommand = path.resolve('/synthetic-system/usr/bin/convert');
  assert.equal(extractedPath(linkedCommand, fixtureRoot, name => name === linkedCommand ? insideCommand : name), insideCommand);
  assert.throws(() => extractedPath(linkedCommand, fixtureRoot, name => name === linkedCommand ? outsideCommand : name), /symlink\/alternatives escape/);
  assert.throws(() => extractedPath(fixtureRoot + '-outside/bin/convert', fixtureRoot, name => name), /outside extracted root/);
  assert.equal(availableAptVerifier(command => command === '/usr/bin/sqv'), '/usr/bin/sqv');
  assert.equal(availableAptVerifier(command => command === '/usr/bin/gpgv'), '/usr/bin/gpgv');
  assert.throws(() => availableAptVerifier(() => false), /signature verification requires/);
  assert.deepEqual(parseInst('Inst blender (4.3.2+dfsg-2 Debian:13/stable [amd64])\nInst libfoo:amd64 [1.0] (1.1 Debian:13/stable [amd64])'), [{ name: 'blender', version: '4.3.2+dfsg-2' }, { name: 'libfoo', version: '1.1' }]);
  assert.throws(() => parseInst('Remv libc6 [2.41]'));
  assert.throws(() => parseInst('Inst libc6 (2.41 Debian:13/stable [amd64])'));
  assert.deepEqual(parseFields('Package: blender\nVersion: 4.3.2\nArchitecture: amd64\n\nPackage: blender-data\nVersion: 4.3.2\n'), [{ Package: 'blender', Version: '4.3.2', Architecture: 'amd64' }, { Package: 'blender-data', Version: '4.3.2' }]);
  assert.equal(shQuote("a'b"), "'a'\\''b'");
  const streaming = streamEstimate([{ name: 'small-archive', downloadBytes: 10, installedBytesEstimate: 2000 }, { name: 'large-archive', downloadBytes: 100, installedBytesEstimate: 1000 }]);
  assert.equal(streaming.order[0].name, 'large-archive');
  assert.equal(streaming.peakExtraBytes, 3160 + MARGIN);
  assert.equal(streaming.finalExtraBytesWithSlack, 3150 + MARGIN);
  const cacheRoot = path.resolve('/synthetic-cache/session-new');
  const packageDirectory = path.join(cacheRoot, '000-package');
  const newDeb = path.join(packageDirectory, 'package.deb');
  const cacheRecord = { cacheRoot, packageDirectory };
  assert.equal(generatedDebPathAllowed(newDeb, cacheRecord, filename => filename), true);
  assert.equal(generatedDebPathAllowed(path.join(packageDirectory, 'original.tar.gz'), cacheRecord, filename => filename), false);
  assert.equal(generatedDebPathAllowed(path.resolve('/synthetic-original/package.deb'), cacheRecord, filename => filename), false);
  assert.equal(generatedDebPathAllowed(newDeb, cacheRecord, filename => filename === newDeb ? outsideCommand : filename), false);
  assert.equal(cpuWaitMicros(20000, 0), 0);
  assert.equal(cpuWaitMicros(140000, 1000000), 0);
  assert.equal(cpuWaitMicros(260000, 1000000), 1000000);
  assert.equal(nextCpuBalance(-20000, 0, 60000000), -20000);
  assert.equal(nextCpuBalance(-20000, 35000, 100000), 3000);
  assert.equal(nextCpuBalance(3000, 0, 100000), -9000);
  const pkg = { name: 'demo', version: '1.0', sha256: 'a'.repeat(64), downloadBytes: 100 };
  const payload = { event: 'payload-verified', package: 'demo', ok: true, mode: 'verify', regularFiles: 1, directories: 1, symlinks: 0, fileBytes: 20, allocatedBytesEstimate: 8192 };
  const journal = [{ event: 'begin' }, { event: 'signed-archive-verified', package: 'demo', file: '/synthetic/demo.deb', sha256: pkg.sha256, bytes: 100 }, payload, { event: 'verified-cache-delete-intent', package: 'demo', file: '/synthetic/demo.deb', sha256: pkg.sha256, bytes: 100 }, { event: 'verified-cache-deleted', package: 'demo', file: '/synthetic/demo.deb', bytes: 100 }];
  assert.equal(verifiedPrefix(journal, [pkg]).length, 1);
  assert.equal(verifiedPrefix(journal.slice(0, -1), [pkg]).length, 0);
  assert.throws(() => verifiedPrefix(journal.filter(event => event.event !== 'payload-verified'), [pkg]), /cleanup intent/);
  assert.throws(() => verifiedPrefix(journal, [{ ...pkg, sha256: 'b'.repeat(64) }]), /signed archive/);
  assert.throws(() => verifiedPrefix([...journal, { event: 'complete' }], [pkg]), /completed installation/);
  assert.equal(verifiedPrefix([{ event: 'begin', previousReceipts: verifiedPrefix(journal, [pkg]) }], [pkg]).length, 1);
  assert.throws(() => verifiedPrefix([{ event: 'begin', previousReceipts: [{ package: 'other' }] }], [pkg]), /authenticated package plan/);
  const uriLine="'https://deb.debian.org/debian/pool/main/d/demo/demo_1.0_amd64.deb' demo_1.0_amd64.deb 100 SHA256:"+pkg.sha256;
  assert.equal(parseDownloadUris(uriLine,[pkg]).get('demo'),'https://deb.debian.org/debian/pool/main/d/demo/demo_1.0_amd64.deb');
  assert.throws(()=>parseDownloadUris(uriLine.replace('https:','http:'),[pkg]),/official HTTPS/);
  assert.throws(()=>parseDownloadUris(uriLine.replace('deb.debian.org','untrusted.invalid'),[pkg]),/official HTTPS/);
  assert.throws(()=>parseDownloadUris(uriLine.replace(' 100 ',' 101 '),[pkg]),/authenticated archive/);
  assert.throws(()=>parseDownloadUris(uriLine+'\n'+uriLine,[pkg]),/authenticated archive/);
  assert.throws(()=>parseDownloadUris('',[pkg]),/exactly one/);
  log('Symlink/cache confinement, official HTTPS URI validation, CPU pacing arithmetic, strict resume receipts, streaming peak estimate, verifier, parser and core-package guards passed; no filesystem writes, network, or subprocesses used.');
}

const [mode, selection = 'all', ...extra] = process.argv.slice(2);
streamMode = ['--stream-plan', '--stream-install', '--stream-resume'].includes(mode);
const resumeMode = mode === '--stream-resume';
const resumeArgsValid = resumeMode && extra.length === 6 && extra[0] === '--stage' && extra[2] === '--plan' && extra[4] === '--journal';
const reuseStage = streamMode && ((extra.length === 2 && extra[0] === '--stage') || resumeArgsValid) ? extra[1] : null;
const extraValid = resumeMode ? resumeArgsValid : !extra.length || Boolean(reuseStage);
try {
  if (mode === '--self-test' && !extra.length) selfTest();
  else if (mode === '--preflight' && !extra.length) await import('./host-preflight.mjs');
  else if (['--plan', '--install', '--stream-plan', '--stream-install', '--stream-resume'].includes(mode) && TARGETS[selection] && extraValid) {
    console.log(JSON.stringify({ action: mode, targets: TARGETS[selection], reuseEmptyPlanStage: reuseStage, writesOnlyUnder: TOOLS, network: 'Explicit plan modes refresh signed Debian metadata. Install modes also download Debian archives.', policy: 'Never change system packages, run maintainer scripts, start the app, activate wrappers, or delete originals. Only --stream-install deletes its new registered .deb cache after complete verification.', limits: { toolsMiB: 700, freeReserveMiB: 130, verifiedDataBytes: KNOWN_DATA_BYTES } }, null, 2));
    log(JSON.stringify(checkHost()));
    configureApt(reuseStage, resumeMode);
    const plan = resumeMode ? await resumePlan(extra[3], extra[5], TARGETS[selection]) : await createPlan(TARGETS[selection]);
    if (mode === '--install') await install(plan);
    else if (mode === '--stream-install' || resumeMode) await streamInstall(plan);
    else log(`Plan only. No converter binaries downloaded. Fits=${plan.fits}. Metadata retained at ${stage}.`);
  } else {
    console.log('Usage: node install-user-tools.mjs --preflight | --self-test | --plan [all|blender|imagemagick] | --install [all|blender|imagemagick] | --stream-plan [all|blender|imagemagick] [--stage /home/container/.studio-host-tools/run-...] | --stream-install [all|blender|imagemagick] [--stage /home/container/.studio-host-tools/run-...]\nDefault/help makes no changes. Plan modes refresh signed metadata only. Stream mode downloads one .deb at a time, verifies signed SHA256 and every extracted payload file, then deletes ONLY that new cache archive. Original data, old installations, metadata, logs and failed current caches are retained. No app startup or automatic activation. Limits:700MiB all tools,130MiB free beyond the verified149507031-byte data allocation.');
  }
} catch (error) {
  console.error(`[host-tools] STOPPED: ${error.message}`);
  if (stage) console.error(`[host-tools] Review retained staging: ${stage}.${streamMode ? ' Only earlier fully verified NEW .deb caches may have been deleted; inspect the stream journal. The failed current cache and originals remain.' : ' No automatic cleanup was performed.'}`);
  process.exitCode = 1;
}
