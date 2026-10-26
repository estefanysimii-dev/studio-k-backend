#!/usr/bin/env node
// Offline, tiny, sequential converter fixtures. No backend import, credentials, or app startup.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const BASE = '/home/container';
const FIXTURES_ROOT = path.join(BASE, '.studio-converter-smoke');
const BLENDER_SCRIPT = path.join(BASE, 'app/server/convert3d.py');
const NATIVE = path.join(BASE, 'studio-k-fivem-preview');
const SAMPLE_INTERVAL_MS = 50;
const FIXTURE_CEILING_BYTES = 20 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPrefix(filename, length) {
  const handle = fs.openSync(filename, 'r');
  const buffer = Buffer.alloc(length);
  try {
    const bytes = fs.readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, bytes);
  } finally { fs.closeSync(handle); }
}
function regularFile(filename) {
  try { const stat = fs.lstatSync(filename); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}
function inspectPng(filename) {
  if (!regularFile(filename)) throw new Error('png-file-missing');
  const header = readPrefix(filename, 24);
  const bytes = fs.statSync(filename).size;
  if (header.length < 24 || !header.subarray(0, 8).equals(PNG_MAGIC) || header.toString('ascii', 12, 16) !== 'IHDR') throw new Error('png-header-invalid');
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  if (width !== 32 || height !== 32 || bytes > FIXTURE_CEILING_BYTES) throw new Error('png-fixture-dimensions-or-size-invalid');
  return { valid: true, bytes, width, height };
}
function inspectPsd(filename) {
  if (!regularFile(filename)) throw new Error('psd-file-missing');
  const header = readPrefix(filename, 26);
  const bytes = fs.statSync(filename).size;
  if (header.length < 26 || header.toString('ascii', 0, 4) !== '8BPS' || header.readUInt16BE(4) !== 1) throw new Error('psd-header-invalid');
  if (header.readUInt32BE(14) !== 32 || header.readUInt32BE(18) !== 32 || bytes > FIXTURE_CEILING_BYTES) throw new Error('psd-fixture-dimensions-or-size-invalid');
  return { valid: true, bytes };
}
function inspectGlb(filename) {
  if (!regularFile(filename)) throw new Error('glb-file-missing');
  const header = readPrefix(filename, 20);
  const bytes = fs.statSync(filename).size;
  if (header.length < 20 || header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== bytes || header.toString('ascii', 16, 20) !== 'JSON' || bytes > FIXTURE_CEILING_BYTES) throw new Error('glb-header-invalid');
  return { valid: true, bytes, version: 2 };
}
function inspectElf(filename) {
  if (!regularFile(filename)) throw new Error('native-file-missing');
  const header = readPrefix(filename, 20);
  if (header.length < 20 || !header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) throw new Error('native-not-linux-x86-64-elf');
  return { valid: true, architecture: 'linux-x86_64', bytes: fs.statSync(filename).size };
}
function procMemory(pid, visited = new Set()) {
  if (!pid || visited.has(pid) || visited.size >= 64) return { available: false, rss: 0, hwm: 0 };
  visited.add(pid);
  let result = { available: false, rss: 0, hwm: 0 };
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    const hwm = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
    result = { available: Boolean(rss), rss: Number(rss?.[1] || 0) * 1024, hwm: Number(hwm?.[1] || 0) * 1024 };
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    for (const child of children) {
      const memory = procMemory(child, visited);
      result.available ||= memory.available;
      result.rss += memory.rss;
      result.hwm += memory.hwm;
    }
  } catch { /* A short-lived process may already have exited. */ }
  return result;
}
function fixtureBytes(directory) {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('unexpected-fixture-symlink');
    if (entry.isDirectory()) bytes += fixtureBytes(filename);
    else if (entry.isFile()) bytes += fs.statSync(filename).size;
    else throw new Error('unexpected-fixture-special-file');
  }
  return bytes;
}
async function execute({ name, command, args = [], timeoutMs, env, directory, expectedCode = 0, validate, inspectOutput }) {
  const started = performance.now();
  let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0;
  let timedOut = false, stoppedForFixtureLimit = false, stoppedForMemoryLimit = false, peakRss = 0, peakHwm = 0, samplingAvailable = false;
  return await new Promise(resolve => {
    const child = spawn(command, args, { cwd: directory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let completed = false, stopping = false;
    let forceTimer;
    const sample = () => {
      const memory = procMemory(child.pid);
      samplingAvailable ||= memory.available;
      peakRss = Math.max(peakRss, memory.rss);
      peakHwm = Math.max(peakHwm, memory.hwm);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 1000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const monitor = setInterval(() => {
      sample();
      if (peakRss >= 384 * 1024 * 1024) {
        stoppedForMemoryLimit = true; stopping = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
      try { if (fixtureBytes(directory) > FIXTURE_CEILING_BYTES) { stoppedForFixtureLimit = true; stop(); } }
      catch { stoppedForFixtureLimit = true; stop(); }
    }, SAMPLE_INTERVAL_MS);
    const finish = (code, signal, spawnError = null) => {
      if (completed) return;
      completed = true;
      clearInterval(monitor); clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (stopping) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* No descendants remain. */ } }
      const result = {
        test: name, status: 'fail', elapsedMs: Math.round(performance.now() - started), exitCode: code,
        signal: signal || null, timedOut, stoppedForFixtureLimit, stoppedForMemoryLimit,
        peakSampledRssBytes: samplingAvailable ? peakRss : null,
        peakSampledTreeHighWaterSumBytes: samplingAvailable ? peakHwm : null,
        rssSamplingIntervalMs: SAMPLE_INTERVAL_MS,
        stdoutBytes, stderrBytes,
      };
      if (spawnError) result.reason = spawnError.code || 'process-start-failed';
      else if (timedOut) result.reason = 'timeout';
      else if (stoppedForMemoryLimit) result.reason = 'synthetic-converter-memory-limit';
      else if (stoppedForFixtureLimit) result.reason = 'fixture-space-limit';
      else if (code !== expectedCode) result.reason = 'unexpected-exit-code';
      else {
        try {
          if (inspectOutput && !inspectOutput(stdout, stderr)) throw new Error('expected-usage-output-missing');
          if (validate) result.artifact = validate();
          result.status = 'pass';
        } catch (error) { result.reason = error.message; }
      }
      resolve(result);
    };
    child.stdout.on('data', chunk => { stdoutBytes += chunk.length; stdout = (stdout + chunk.toString()).slice(-16384); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; stderr = (stderr + chunk.toString()).slice(-16384); });
    child.once('spawn', sample);
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  });
}
function skip(test, reason) { return { test, status: 'skip', reason, elapsedMs: 0 }; }

async function main() {
  if (process.argv[2] !== '--run') {
    console.log(JSON.stringify({ status: 'not-run', command: 'node converter-smoke.mjs --run', networkUsed: false, credentialsNeeded: false, note: 'Run after activating the user-space converter wrappers in PATH. Only new synthetic fixtures are written outside data.' }));
    return;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('requires-linux-x86-64');
  if (fs.realpathSync(BASE) !== BASE) throw new Error('unexpected-container-base-symlink');
  if (fs.existsSync(FIXTURES_ROOT)) {
    const stat = fs.lstatSync(FIXTURES_ROOT);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-fixture-root');
  } else fs.mkdirSync(FIXTURES_ROOT, { mode: 0o700 });
  const directory = path.join(FIXTURES_ROOT, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const name of ['tmp', 'config', 'cache', 'runtime', 'blender-config', 'blender-scripts', 'blender-datafiles']) fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  // Pass converter path settings only. Application/OAuth/payment/Discord secrets are excluded.
  for (const name of ['LD_LIBRARY_PATH', 'BLENDER_SYSTEM_RESOURCES', 'BLENDER_SYSTEM_SCRIPTS', 'BLENDER_SYSTEM_DATAFILES', 'BLENDER_SYSTEM_PYTHON', 'MAGICK_CONFIGURE_PATH', 'MAGICK_CODER_MODULE_PATH', 'MAGICK_FILTER_MODULE_PATH', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MAGICK_THREAD_LIMIT: '1',
    MAGICK_MEMORY_LIMIT: '48MiB', MAGICK_MAP_LIMIT: '64MiB', MAGICK_DISK_LIMIT: '32MiB',
    TMPDIR: path.join(directory, 'tmp'), TEMP: path.join(directory, 'tmp'), TMP: path.join(directory, 'tmp'),
    XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_CACHE_HOME: path.join(directory, 'cache'), XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
    BLENDER_USER_CONFIG: path.join(directory, 'blender-config'), BLENDER_USER_SCRIPTS: path.join(directory, 'blender-scripts'), BLENDER_USER_DATAFILES: path.join(directory, 'blender-datafiles'),
    MAGICK_TMPDIR: path.join(directory, 'tmp'), MAGICK_TEMPORARY_PATH: path.join(directory, 'tmp'),
  });
  const triangle = path.join(directory, 'triangle.obj');
  const glb = path.join(directory, 'triangle.glb');
  const png = path.join(directory, 'fixture-source.png');
  const psd = path.join(directory, 'fixture-source.psd');
  const preview = path.join(directory, 'fixture-preview.png');
  fs.writeFileSync(triangle, 'o SmokeTriangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', { flag: 'wx', mode: 0o600 });
  const tests = [];
  if (!regularFile(BLENDER_SCRIPT)) tests.push(skip('blender-obj-to-glb', 'backend-conversion-script-missing'));
  else tests.push(await execute({ name: 'blender-obj-to-glb', command: 'blender', args: ['--background', '--threads', '1', '--factory-startup', '--disable-autoexec', '--python', BLENDER_SCRIPT, '--', triangle, glb, 'obj'], timeoutMs: 90000, env, directory, validate: () => inspectGlb(glb) }));

  const sourcePng = await execute({ name: 'imagemagick-create-png', command: 'convert', args: ['-size', '32x32', 'xc:#663399', png], timeoutMs: 30000, env, directory, validate: () => inspectPng(png) });
  tests.push(sourcePng);
  if (sourcePng.status === 'pass') {
    const sourcePsd = await execute({ name: 'imagemagick-create-psd', command: 'convert', args: [png, '-type', 'TrueColor', psd], timeoutMs: 30000, env, directory, validate: () => inspectPsd(psd) });
    tests.push(sourcePsd);
    if (sourcePsd.status === 'pass') tests.push(await execute({ name: 'imagemagick-backend-psd-to-png', command: 'convert', args: [`${psd}[0]`, '-background', 'none', '-flatten', '-resize', '2400x2400>', '-strip', preview], timeoutMs: 30000, env, directory, validate: () => inspectPng(preview) }));
    else tests.push(skip('imagemagick-backend-psd-to-png', 'synthetic-psd-not-created'));
  } else {
    tests.push(skip('imagemagick-create-psd', 'synthetic-png-not-created'));
    tests.push(skip('imagemagick-backend-psd-to-png', 'synthetic-png-not-created'));
  }

  try {
    const elf = inspectElf(NATIVE);
    const native = await execute({ name: 'fivem-native-elf-and-usage', command: NATIVE, args: [], timeoutMs: 10000, env, directory, expectedCode: 1, inspectOutput: (stdout, stderr) => /\b(?:uso|usage)\s*:/i.test(stdout + '\n' + stderr) });
    native.elf = elf;
    native.note = 'ELF loading and usage only; no original YDD/YTD conversion was attempted.';
    tests.push(native);
  } catch (error) { tests.push({ test: 'fivem-native-elf-and-usage', status: 'fail', reason: error.message, elapsedMs: 0 }); }
  const report = {
    kind: 'studio-k-converter-smoke', status: tests.every(test => test.status === 'pass') ? 'pass' : 'incomplete',
    timestamp: new Date().toISOString(), node: process.versions.node, architecture: process.arch,
    fixturesDirectory: directory, syntheticFixtureBytes: fixtureBytes(directory), tests,
    privacy: { networkUsed: false, backendImported: false, applicationStarted: false, originalDataOpened: false, credentialsPassedToConverters: false, rawProcessOutputPrinted: false },
    limitations: ['Tiny fixtures confirm basic loader/codecs/export only, not large production models or PSD memory capacity.', 'RSS is sampled for the process tree; very short peaks may be missed. Observed high-water values are also sampled from /proc.', 'Synthetic fixtures and this JSON report are retained; nothing is deleted automatically.'],
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report));
  if (report.status !== 'pass') process.exitCode = 1;
}

main().catch(error => {
  console.log(JSON.stringify({ kind: 'studio-k-converter-smoke', status: 'error', reason: error.code || error.message, networkUsed: false, applicationStarted: false, originalDataOpened: false }));
  process.exitCode = 1;
});
