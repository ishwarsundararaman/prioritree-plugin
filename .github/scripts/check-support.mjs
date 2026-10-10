import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { descendants, processSnapshot, stopCapturedProcesses } from './processes.mjs';

export const ELECTRON_VERSION = '44.7.0';
const ACTIONLINT_VERSION = '1.7.12';
const json = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

export function contained(root, path) {
  const within = relative(resolve(root), resolve(path));
  assert(within && !isAbsolute(within) && within.split(sep)[0] !== '..', `Path escapes ${root}: ${path}`);
  return resolve(path);
}

export async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'prioritree-public-platform-checks', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(60000) });
  assert(response.ok, `Download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// MCPB is a ZIP. Read its central directory using built-ins, without npm unzip dependencies.
export async function extractZip(bytes, destination) {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  assert(end >= 0, 'Invalid ZIP end-of-central-directory');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'Multi-disk ZIP is unsupported');
  assert.equal(bytes.readUInt16LE(end + 6), 0, 'Multi-disk ZIP is unsupported');
  const count = bytes.readUInt16LE(end + 10), centralEnd = bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12);
  assert(count !== 0xffff && centralEnd <= end, 'Invalid or unsupported ZIP64 directory');
  let cursor = bytes.readUInt32LE(end + 16), total = 0;
  const seen = new Set();
  await mkdir(destination, { recursive: true });
  for (let index = 0; index < count; index++) {
    assert(cursor + 46 <= centralEnd && bytes.readUInt32LE(cursor) === 0x02014b50, 'Invalid ZIP central entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16, offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert(!(flags & 1) && [0, 8].includes(method), `Unsupported ZIP compression/encryption: ${name}`);
    assert(!name.includes('\\') && !name.includes('\0') && !name.includes(':') && !name.startsWith('/') && !name.split('/').includes('..'), `Unsafe ZIP path: ${name}`);
    assert((mode & 0xf000) !== 0xa000, `ZIP symlink is forbidden: ${name}`);
    const target = contained(destination, resolve(destination, name));
    const key = target.toLowerCase();
    assert(!seen.has(key), `Duplicate ZIP path: ${name}`); seen.add(key);
    total += size;
    assert(total <= 128 * 1024 * 1024 && size <= 64 * 1024 * 1024, 'MCPB exceeds bounded extraction budget');
    assert(offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50, `Invalid ZIP local entry: ${name}`);
    const dataOffset = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    assert(dataOffset + compressed <= bytes.length, `Truncated ZIP entry: ${name}`);
    const packed = bytes.subarray(dataOffset, dataOffset + compressed);
    const unpacked = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
    assert.equal(unpacked.length, size, `ZIP size mismatch: ${name}`);
    assert.equal(crc32(unpacked), checksum, `ZIP checksum mismatch: ${name}`);
    if (name.endsWith('/')) await mkdir(target, { recursive: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, unpacked, { flag: 'wx' });
      if (mode & 0o111) await chmod(target, 0o755);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, centralEnd, 'ZIP central directory length mismatch');
}

async function boundedCommand(executable, args, cwd, env, ledger, timeout = 300000) {
  const record = { owner: 'public-ci/platform-checks', pid: null, createdAt: new Date().toISOString(), executable, workingDirectory: cwd, purpose: args.join(' '), stopCommand: 'Await one-shot completion; SIGTERM exact captured descendants on timeout' };
  await json(ledger, record);
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', stdout = '', stderr = '', captured = [];
  const completion = new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  void completion.catch(() => {});
  child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-16000); output = (output + data).slice(-16000); });
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-16000); output = (output + data).slice(-16000); });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void (async () => {
      captured = [...captured, ...descendants(await processSnapshot(), captured)];
      await stopCapturedProcesses(captured);
    })().catch(() => child.kill('SIGTERM'));
  }, timeout);
  try {
    if (child.pid) {
      record.pid = child.pid;
      const snapshot = await processSnapshot(), birth = snapshot.find((item) => item.pid === child.pid);
      if (birth) { captured = descendants(snapshot, [birth]); Object.assign(record, birth); }
      await json(ledger, record);
    }
    const result = await completion;
    assert(!timedOut, `${executable} timed out`);
    assert.equal(result.code, 0, `${executable} exited ${result.code ?? result.signal}: ${output.slice(-3000)}`);
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    await writeFile(ledger + '.log', output);
    captured = [...captured, ...descendants(await processSnapshot(), captured)];
    await stopCapturedProcesses(captured);
    await json(ledger, { ...record, verifiedExited: true });
  }
}

export async function prepareElectronRuntime(packageRoot, env, directory, run = boundedCommand) {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, ELECTRON_VERSION);
  const installedPath = async () => {
    const executable = contained(packageRoot, join(packageRoot, 'dist', (await readFile(join(packageRoot, 'path.txt'), 'utf8')).trim()));
    await access(executable);
    return realpath(executable);
  };
  let executable;
  try { executable = await installedPath(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // npm can skip dependency lifecycle scripts. Invoke Electron's own downloader
    // explicitly rather than treating a successfully installed JS package as a host.
    await run(process.execPath, [join(packageRoot, 'install.js')], packageRoot, env, join(directory, 'install-process-postinstall.json'));
    executable = await installedPath();
  }
  const probe = await run(executable, ['-p', 'JSON.stringify({electron:process.versions.electron,node:process.versions.node,executable:process.execPath})'], directory, { ...env, ELECTRON_RUN_AS_NODE: '1' }, join(directory, 'install-process-runtime-probe.json'), 30000);
  const runtime = JSON.parse(probe.stdout.trim());
  assert.equal(runtime.electron, ELECTRON_VERSION, 'Electron runtime must report the pinned process.versions.electron');
  assert.equal(await realpath(runtime.executable), executable, 'Electron probe ran a different executable');
  return { version: packageJson.version, executable, runtime };
}

export async function installElectron(directory) {
  directory = resolve(directory);
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert(major > 22 || (major === 22 && minor >= 12), 'Installing the pinned Electron package needs Node 22.12 or newer');
  let entries = [];
  try { entries = await (await import('node:fs/promises')).readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let reuse = false;
  if (entries.length) {
    const owner = JSON.parse(await readFile(join(directory, 'task-owner.json'), 'utf8'));
    assert(owner.owner === 'public-ci/platform-checks' && owner.directory === directory, 'Refusing to install into a directory owned by another task');
    try {
      const installed = JSON.parse(await readFile(join(directory, 'electron-install.json'), 'utf8'));
      assert.equal(installed.version, ELECTRON_VERSION); await access(installed.executable);
      reuse = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(directory, { recursive: true });
  await json(join(directory, 'task-owner.json'), { owner: 'public-ci/platform-checks', directory, purpose: `Temporary Electron ${ELECTRON_VERSION} install`, retirement: 'Remove after all Electron probes have exited; no shared npm caches are used' });
  const profile = join(directory, 'install-profile');
  await mkdir(profile, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^ELECTRON_|^electron_config_|^npm_config_(platform|arch|ignore_scripts)$|^NODE_OPTIONS$/i.test(key)) delete env[key];
  Object.assign(env, { HOME: profile, USERPROFILE: profile, APPDATA: join(profile, 'appdata'), LOCALAPPDATA: join(profile, 'localappdata'), ELECTRON_CACHE: join(directory, 'electron-cache'), electron_config_cache: join(directory, 'electron-cache'), npm_config_userconfig: join(profile, 'empty.npmrc'), npm_config_globalconfig: join(profile, 'empty-global.npmrc') });
  const packageRoot = join(directory, 'node_modules/electron');
  if (reuse) {
    const installed = await prepareElectronRuntime(packageRoot, env, directory);
    await json(join(directory, 'electron-install.json'), installed);
    console.log(`PASS reusing verified Electron ${installed.runtime.electron} in ${directory}`);
    return installed.executable;
  }
  const candidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const entry of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (entry && process.platform === 'win32') candidates.push(join(entry, 'node_modules/npm/bin/npm-cli.js'));
    if (entry) try { candidates.push(await realpath(join(entry, process.platform === 'win32' ? 'npm.cmd' : 'npm'))); } catch { /* Not an npm directory. */ }
  }
  let npm;
  for (const candidate of candidates) if (candidate.endsWith('.js')) try { await access(candidate); npm = candidate; break; } catch { /* Try the next runtime layout. */ }
  assert(npm, 'Cannot locate npm-cli.js beside the selected Node runtime or on PATH');
  await boundedCommand(process.execPath, [npm, 'install', '--prefix', directory, '--cache', join(directory, 'npm-cache'), '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts=false', '--foreground-scripts', `electron@${ELECTRON_VERSION}`], directory, env, join(directory, 'install-process.json'));
  const installed = await prepareElectronRuntime(packageRoot, env, directory);
  await json(join(directory, 'electron-install.json'), installed);
  console.log(`PASS Electron ${installed.runtime.electron} installed and executed in ${directory}`);
  return installed.executable;
}

export async function downloadRelease(directory, expectedVersion) {
  const release = JSON.parse((await download('https://api.github.com/repos/ishwarsundararaman/prioritree-plugin/releases/latest')).toString());
  assert.equal(release.tag_name.replace(/^v/, ''), expectedVersion, 'Latest release tag differs from the checked-out manifest');
  const asset = release.assets.find((item) => item.name === 'prioritree.mcpb');
  assert(asset?.browser_download_url, 'Latest public release has no prioritree.mcpb asset');
  const bytes = await download(asset.browser_download_url);
  assert.equal(bytes.length, asset.size, 'Release asset download size mismatch');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (asset.digest) assert.equal(asset.digest, `sha256:${sha256}`, 'GitHub release asset digest mismatch');
  await mkdir(directory, { recursive: true });
  await extractZip(bytes, directory);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, expectedVersion, 'Released MCPB manifest version mismatch');
  await json(join(directory, 'release-receipt.json'), { releaseId: release.id, tag: release.tag_name, assetId: asset.id, url: asset.browser_download_url, bytes: bytes.length, sha256, manifestVersion: manifest.version });
  console.log(`PASS released prioritree.mcpb ${manifest.version}: asset ${asset.id}, SHA256 ${sha256}`);
}

async function lint(directory, workflow) {
  await mkdir(directory, { recursive: true });
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const filename = `actionlint_${ACTIONLINT_VERSION}_${platform}_${architecture}.${platform === 'windows' ? 'zip' : 'tar.gz'}`;
  const base = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}`;
  const bytes = await download(`${base}/${filename}`), checksums = (await download(`${base}/actionlint_${ACTIONLINT_VERSION}_checksums.txt`)).toString();
  const expected = checksums.split('\n').find((line) => line.trim().endsWith(` ${filename}`))?.trim().split(/\s+/)[0];
  assert(expected && createHash('sha256').update(bytes).digest('hex') === expected, 'actionlint archive checksum mismatch');
  if (platform === 'windows') await extractZip(bytes, directory);
  else {
    const archive = join(directory, filename); await writeFile(archive, bytes);
    await boundedCommand('tar', ['-xzf', archive, '-C', directory, 'actionlint'], directory, process.env, join(directory, 'extract-process.json'));
  }
  const executable = join(directory, platform === 'windows' ? 'actionlint.exe' : 'actionlint');
  await boundedCommand(executable, ['-shellcheck=', '-pyflakes=', resolve(workflow)], process.cwd(), process.env, join(directory, 'lint-process.json'), 30000);
  console.log(`PASS actionlint ${ACTIONLINT_VERSION}: ${workflow} (exit 0, no diagnostics)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, argument] = process.argv.slice(2);
  assert(directory, 'Usage: check-support.mjs install-electron DIR | download-release DIR VERSION | lint DIR WORKFLOW');
  if (command === 'install-electron') await installElectron(directory);
  else if (command === 'download-release') await downloadRelease(resolve(directory), argument);
  else if (command === 'lint') await lint(resolve(directory), argument);
  else throw new Error(`Unknown support command: ${command}`);
}
