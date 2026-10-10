import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { resolveHostLaunch, whichInWindows } from './host-launch.mjs';

const shell = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/sh.exe') : '/bin/sh';
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'prioritree host stub with spaces '));
  try { await fn(directory); } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()), 'Only this task-created temp directory may be removed');
    await rm(directory, { recursive: true, force: true });
  }
}

async function stub(directory) {
  for (const name of ['scripts', 'server', 'empty-path']) await mkdir(join(directory, name));
  const declaration = { command: './scripts/launch-work-map', args: [], cwd: '.' };
  await writeFile(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { prioritree_work_map: declaration } }));
  await writeFile(join(directory, 'server/work-map.mjs'), `const deadline=setTimeout(()=>process.exit(2),8000); process.stdin.resume(); process.stdin.once('end',()=>{clearTimeout(deadline); console.log(JSON.stringify({pid:process.pid,runtime:process.execPath,argv:process.argv.slice(1),home:process.env.HOME,codexHome:process.env.CODEX_HOME}));});\n`);
  await writeFile(join(directory, 'scripts/launch-work-map'), '#!/bin/sh\nscript_dir=$(CDPATH= cd -- "${0%/*}" && pwd)\nexec "$CODEX_MCP_NODE_PATH" "$script_dir/../server/work-map.mjs" "$@"\n', { mode: 0o755 });
  await chmod(join(directory, 'scripts/launch-work-map'), 0o755);
  await writeFile(join(directory, 'scripts/launch-work-map.cmd'), '@echo off\r\n"%CODEX_MCP_NODE_PATH%" "%~dp0..\\server\\work-map.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PATH$|PATHEXT$|PRIORITREE_|CODEX_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_)/i.test(key)));
  Object.assign(env, { PATH: join(directory, 'empty-path'), PATHEXT: '.MJS;.EXE;.CMD', SystemRoot: process.env.SystemRoot || join(directory, 'simulated-windows'), HOME: directory, USERPROFILE: directory, APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'localappdata'), CODEX_HOME: join(directory, 'codex'), XDG_DATA_HOME: join(directory, 'xdg-data'), XDG_CONFIG_HOME: join(directory, 'xdg-config'), XDG_CACHE_HOME: join(directory, 'xdg-cache'), CODEX_MCP_NODE_PATH: process.execPath });
  const config = JSON.parse(await readFile(join(directory, '.mcp.json'), 'utf8')).mcpServers.prioritree_work_map;
  return { plan: { host: 'codex', ...config, args: ['--stub', 'argument with spaces'], cwd: directory }, env };
}

async function verify(command, plan, env) {
  const result = spawnSync(command.command, command.args, { cwd: plan.cwd, env, input: '', encoding: 'utf8', timeout: 10000, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments || false });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout.trim());
  assert.equal(await realpath(report.runtime), await realpath(process.execPath));
  assert.deepEqual(report.argv, [join(plan.cwd, 'server/work-map.mjs'), '--stub', 'argument with spaces']);
  assert.equal(report.home, plan.cwd); assert.equal(report.codexHome, join(plan.cwd, 'codex'));
  assert(report.pid > 0, 'The stub reports its exact child identity after EOF');
}

test('Codex Windows lookup rejects the extensionless sh file and chooses .cmd via cwd/PATHEXT', () => temporary(async (directory) => {
  const { plan, env } = await stub(directory);
  // .MJS precedes .CMD deliberately; Codex ships no ambiguous .mjs sibling.
  assert.equal(await whichInWindows(plan.command, env, directory, { pathExt: env.PATHEXT }), join(directory, 'scripts/launch-work-map.cmd'));
  const launch = await resolveHostLaunch(plan, env, { platform: 'win32', pathExt: env.PATHEXT });
  assert.equal(launch.resolvedProgram, join(directory, 'scripts/launch-work-map.cmd'));
  assert.match(launch.command, /cmd\.exe$/i); assert(launch.windowsVerbatimArguments);
}));

test('Codex Windows declared command starts the stub with host Node and no Node on PATH', { skip: process.platform !== 'win32' }, () => temporary(async (directory) => {
  const { plan, env } = await stub(directory);
  const noNode = spawnSync(join(process.env.SystemRoot, 'System32/where.exe'), ['node'], { cwd: directory, env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(noNode.status, 1, 'Fixture must have no PATH Node');
  await verify(await resolveHostLaunch(plan, env, { pathExt: env.PATHEXT }), plan, env);
}));

test('Codex Unix executes the declared shebang script directly with no PATH Node', { skip: !existsSync(shell) }, () => temporary(async (directory) => {
  const { plan, env } = await stub(directory);
  const launch = await resolveHostLaunch(plan, env, { platform: 'linux' });
  assert.equal(launch.command, './scripts/launch-work-map'); assert.deepEqual(launch.args, plan.args);
  // Windows has no kernel shebang support: Git sh reads the actual script to
  // simulate that part only. Linux/macOS execute the unchanged command itself.
  if (process.platform === 'win32') { launch.args = [launch.command, ...launch.args]; launch.command = shell; env.CODEX_MCP_NODE_PATH = process.execPath.replaceAll('\\', '/'); }
  await verify(launch, plan, env);
}));

test('Windows lookup respects PATH casing, PATHEXT order and lookup-failure fallback', () => temporary(async (directory) => {
  const bin = join(directory, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'helper.cmd'), '@echo off'); await writeFile(join(bin, 'helper.bat'), '@echo off');
  assert.equal(await whichInWindows('helper', { Path: bin }, directory, { pathExt: '.BAT;.CMD' }), join(bin, 'helper.bat'));
  assert.equal(await whichInWindows('helper', { Path: bin }, directory, { pathExt: '.CMD;.BAT' }), join(bin, 'helper.cmd'));
  assert.equal(await whichInWindows('missing', { Path: bin }, directory, { pathExt: '.CMD' }), 'missing');
  assert.equal(await whichInWindows('./helper', { Path: bin }, directory, { pathExt: '.CMD' }), './helper', 'Relative commands with a separator do not search PATH');
}));

test('Claude Code keeps a plain node spawn and MCPB uses the selected host runtime', async () => {
  const plan = { command: 'node', args: ['server.mjs'], cwd: tmpdir() };
  const claude = await resolveHostLaunch({ ...plan, host: 'claude-code' }, { PATH: '' }, { platform: 'win32' });
  assert.equal(claude.command, 'node'); assert.deepEqual(claude.args, plan.args); assert(!claude.windowsVerbatimArguments);
  const desktop = await resolveHostLaunch({ ...plan, host: 'mcpb' }, { PATH: '' }, { runtime: '/selected/runtime/node' });
  assert.equal(desktop.command, '/selected/runtime/node');
  const electron = await resolveHostLaunch({ ...plan, host: 'mcpb', command: '/selected/electron', electron: true }, {});
  assert.equal(electron.command, '/selected/electron');
  await assert.rejects(resolveHostLaunch({ ...plan, host: 'mcpb', command: 'other' }, {}), /node MCPB declaration/);
});
