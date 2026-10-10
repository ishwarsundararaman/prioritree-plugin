// Test the harness's safety boundaries, not a reimplementation of the product.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contained, ELECTRON_VERSION, extractZip, prepareElectronRuntime } from './check-support.mjs';
import { descendants, executableOnPath, executableTextPaths, sameProcess } from './processes.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const { name, text = 'installed bundle', mode = 0o100644, badCrc = false } of entries) {
    const filename = Buffer.from(name), data = Buffer.from(text), checksum = crc32(data) ^ (badCrc ? 1 : 0);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum >>> 0, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(checksum >>> 0, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE((mode << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'prioritree-harness-test-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('extracts a valid release ZIP with verified bytes', () => temporary(async (directory) => {
  await extractZip(zip([{ name: 'server/work-map.mjs', text: 'real released bytes' }]), directory);
  assert.equal(await readFile(join(directory, 'server/work-map.mjs'), 'utf8'), 'real released bytes');
}));

for (const name of ['../outside', '/outside', 'C:/outside', 'server\\outside']) test(`rejects ZIP path ${name}`, () => temporary(async (directory) => {
  await assert.rejects(extractZip(zip([{ name }]), directory), /Unsafe ZIP path/);
}));

test('rejects ZIP symlinks', () => temporary(async (directory) => {
  await assert.rejects(extractZip(zip([{ name: 'server/link', mode: 0o120777 }]), directory), /symlink/);
}));

test('rejects case-colliding paths on every OS', () => temporary(async (directory) => {
  await assert.rejects(extractZip(zip([{ name: 'server/A' }, { name: 'server/a' }]), directory), /Duplicate ZIP path/);
}));

test('rejects corrupt release payloads instead of silently testing different bytes', () => temporary(async (directory) => {
  await assert.rejects(extractZip(zip([{ name: 'manifest.json', badCrc: true }]), directory), /checksum mismatch/);
}));

test('path containment rejects the root itself and outside paths', () => {
  const root = join(tmpdir(), 'proof-root');
  assert.throws(() => contained(root, root), /escapes/);
  assert.throws(() => contained(root, join(root, '../outside')), /escapes/);
  assert.equal(contained(root, join(root, 'store/file')), join(root, 'store/file'));
});

test('PID reuse or an executable change cannot authorize termination', () => {
  const owned = { pid: 100, parentPid: 1, createdAt: '2026-10-10T00:00:00Z', executable: 'task-node' };
  assert(sameProcess(owned, { ...owned }));
  assert(!sameProcess(owned, { ...owned, createdAt: '2026-10-10T00:00:01Z' }));
  assert(!sameProcess(owned, { ...owned, executable: 'other-task' }));
  const child = { pid: 101, parentPid: 100, createdAt: owned.createdAt, executable: 'source-node' };
  const unrelated = { pid: 11972, parentPid: 1, createdAt: owned.createdAt, executable: 'founder-engine' };
  assert.deepEqual(descendants([owned, child, unrelated], [owned]), [owned, child]);
  assert.deepEqual(descendants([{ ...owned, createdAt: 'reused' }, child, unrelated], [owned]), []);
});

test('repairs an Electron package whose postinstall was skipped, then probes the binary', () => temporary(async (directory) => {
  const packageRoot = join(directory, 'node_modules/electron');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: ELECTRON_VERSION }));
  await writeFile(join(packageRoot, 'install.js'), '// Electron postinstall fixture');
  const calls = [];
  const run = async (command, args, cwd, env) => {
    calls.push({ command, args, cwd, env });
    if (args[0] === join(packageRoot, 'install.js')) {
      await mkdir(join(packageRoot, 'dist'));
      await writeFile(join(packageRoot, 'path.txt'), 'electron-test');
      await writeFile(join(packageRoot, 'dist/electron-test'), 'test executable');
      return { stdout: '' };
    }
    return { stdout: JSON.stringify({ electron: ELECTRON_VERSION, node: '22.23.2', executable: command }) };
  };
  const installed = await prepareElectronRuntime(packageRoot, {}, directory, run);
  assert.equal(realpathSync.native(installed.executable), realpathSync.native(join(packageRoot, 'dist/electron-test')));
  assert.equal(realpathSync.native(calls[0].command), realpathSync.native(process.execPath));
  assert.equal(realpathSync.native(calls[0].args[0]), realpathSync.native(join(packageRoot, 'install.js')));
  assert.equal(realpathSync.native(calls[1].command), realpathSync.native(installed.executable));
  assert.equal(calls[1].env.ELECTRON_RUN_AS_NODE, '1');
  // A reuse must still prove the executable's identity; package.json is insufficient.
  calls.length = 0;
  await prepareElectronRuntime(packageRoot, {}, directory, run);
  assert.equal(calls.length, 1);
  await assert.rejects(prepareElectronRuntime(packageRoot, {}, directory, async () => ({ stdout: JSON.stringify({ node: '22.23.2' }) })), /Electron runtime/);
}));

test('macOS executable text paths preserve spaces and exclude other lsof file descriptors', () => {
  const output = 'p123\nftxt\nn/selected runtime/bin/node\nftxt\nn/usr/lib/libSystem.B.dylib\nfcwd\nn/working directory\nf1\nn/tmp/output\n';
  assert.deepEqual(executableTextPaths(output), ['/selected runtime/bin/node', '/usr/lib/libSystem.B.dylib']);
});

test('a bare executable resolves through the child PATH, including directories with spaces', () => temporary(async (directory) => {
  const bin = join(directory, 'selected runtime');
  await mkdir(bin);
  const command = process.platform === 'win32' ? 'node.exe' : 'node';
  const executable = join(bin, command);
  await writeFile(executable, 'PATH resolution fixture', { mode: 0o755 });
  assert.equal(realpathSync.native(await executableOnPath(command, { PATH: bin }, directory)), realpathSync.native(executable));
  await assert.rejects(executableOnPath(command, { PATH: join(directory, 'missing') }, directory), /Cannot resolve executable/);
}));
