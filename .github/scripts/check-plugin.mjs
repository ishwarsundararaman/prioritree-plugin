// Check the released files using Node built-ins, with no product source or test dependencies.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { contained } from './check-support.mjs';
import { resolveHostLaunch } from './host-launch.mjs';
import { delay, descendants, executablePath, processSnapshot, sameProcess, stopCapturedProcesses } from './processes.mjs';

const execute = promisify(execFile), scriptDirectory = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  root: { type: 'string', default: resolve(scriptDirectory, '../..') },
  layout: { type: 'string', default: 'repository' },
  phase: { type: 'string', default: 'node' },
  electron: { type: 'string' },
  artifacts: { type: 'string', default: join(tmpdir(), 'prioritree-platform-check-artifacts') },
  hosts: { type: 'string' },
  'manifest-only': { type: 'boolean', default: false },
} });
assert(['repository', 'mcpb'].includes(values.layout), 'Use --layout repository or mcpb');
assert(['node', 'electron'].includes(values.phase), 'Use --phase node or electron');
const root = resolve(values.root), artifacts = resolve(values.artifacts);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const saveJson = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
await mkdir(artifacts, { recursive: true });
let manifest;
try { manifest = await readJson(join(root, 'manifest.json')); } catch (error) {
  await saveJson(join(artifacts, 'summary.json'), { passed: false, checks: [{ name: 'root manifest parses', passed: false, error: error.message }] });
  console.error(`FAIL root manifest parses: ${error.message}`);
  process.exit(1); // No helper has started on this path.
}
const summary = { version: manifest.version, platform: process.platform, arch: process.arch, node: process.version, phase: values.phase, root, checks: [], runs: [] };
const controllerBirth = (await processSnapshot()).find((item) => item.pid === process.pid);
assert(controllerBirth?.createdAt && controllerBirth.executable, 'Check controller needs its exact OS identity');
const controller = { ...controllerBirth, owner: 'public-ci/platform-checks', workingDirectory: process.cwd(), purpose: 'Bounded installed-plugin platform check controller', stopCommand: 'SIGINT this controller; its finally blocks retire owned helpers and verify ports', state: 'running' };
await saveJson(join(artifacts, 'controller.json'), controller);
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; });

async function check(name, fn) {
  try {
    assert(!interrupted, 'Platform checks interrupted; cleaning up');
    const evidence = await fn();
    summary.checks.push({ name, passed: true, evidence });
    console.log(`PASS ${name}${evidence?.message ? `: ${evidence.message}` : ''}`);
    return evidence;
  } catch (error) {
    summary.checks.push({ name, passed: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    return undefined;
  }
}

async function files(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    assert(!entry.isSymbolicLink(), `Unexpected symlink in isolated proof: ${join(directory, entry.name)}`);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function expand(value, pluginRoot) {
  assert.equal(typeof value, 'string', 'Launch paths must be strings');
  const expanded = value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot).replaceAll('${__dirname}', root);
  assert(!expanded.includes('${'), `Unsupported launch placeholder: ${value}`);
  return expanded;
}

async function validateManifests() {
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.equal(manifest.server.type, 'node');
  for (const reference of [manifest.icon, manifest.server.entry_point]) await access(contained(root, resolve(root, reference)));
  assert(manifest.server.mcp_config.args.includes('${__dirname}/' + manifest.server.entry_point), 'MCPB command must reference its server entry');
  const manifests = ['manifest.json'];
  const roots = values.layout === 'repository' ? ['plugins/prioritree-work-map', 'plugins/prioritree-work-map-claude'] : ['.'];
  if (values.layout === 'repository') {
    for (const path of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
      const marketplace = await readJson(join(root, path)); manifests.push(path);
      if (marketplace.metadata?.version) assert.equal(marketplace.metadata.version, manifest.version, path);
      for (const plugin of marketplace.plugins) {
        assert.equal(plugin.version, manifest.version, path);
        await access(contained(root, resolve(root, typeof plugin.source === 'string' ? plugin.source : plugin.source.path)));
      }
    }
  }
  for (const directory of roots) {
    const pluginRoot = resolve(root, directory), serverRoot = directory === '.' ? dirname(resolve(root, manifest.server.entry_point)) : join(pluginRoot, 'server');
    for (const bundle of ['work-map.mjs', 'desk-engine.mjs']) {
      const text = await readFile(join(serverRoot, bundle), 'utf8');
      const version = text.match(/const (?:pluginVersion|DESK_VERSION) = "([^"]+)";/)?.[1];
      assert.equal(version, manifest.version, `${directory}/${bundle} bundle version`);
    }
    const desk = join(serverRoot, 'desk'), html = await readFile(join(desk, 'index.html'), 'utf8');
    const engineText = await readFile(join(serverRoot, 'desk-engine.mjs'), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (/^(?:[a-z]+:|\/\/)/i.test(match[1])) continue;
      if (match[1] === '/manifest.webmanifest') { assert(engineText.includes('path === "/manifest.webmanifest"'), 'Desk manifest route missing'); continue; }
      if (/^\/icons\/desk-(192|512)\.png$/.test(match[1])) { assert(engineText.includes('res.end(deskIcon('), 'Generated desk icon route missing'); continue; }
      await access(contained(desk, resolve(desk, match[1].replace(/^\//, ''))));
    }
    if (directory === '.') continue;
    const pluginPath = join(directory, directory.endsWith('-claude') ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json');
    const plugin = await readJson(join(root, pluginPath)); manifests.push(pluginPath);
    assert.equal(plugin.version, manifest.version, pluginPath);
    for (const reference of [plugin.skills, plugin.mcpServers, plugin.interface?.composerIcon, plugin.interface?.logo].filter(Boolean)) await access(contained(pluginRoot, resolve(pluginRoot, reference)));
    for (const entry of await readdir(pluginRoot)) if (/^\.mcp(?:\.[\w-]+)?\.json$/.test(entry)) {
      const config = await readJson(join(pluginRoot, entry)); manifests.push(join(directory, entry));
      assert(config.mcpServers?.prioritree_work_map, `${entry} has no work-map server`);
      const server = config.mcpServers.prioritree_work_map;
      for (const value of [server.command, ...server.args]) if (/launch-work-map(?:\.(?:cmd|sh|mjs))?$/.test(value)) await access(contained(pluginRoot, resolve(pluginRoot, expand(value, pluginRoot).replaceAll('\\', '/'))));
      if (directory === 'plugins/prioritree-work-map' && /[/\\]launch-work-map$/.test(server.command)) {
        await access(join(pluginRoot, 'scripts/launch-work-map.cmd'));
        const siblings = (await readdir(join(pluginRoot, 'scripts'))).filter((name) => name.startsWith('launch-work-map'));
        assert.deepEqual(siblings.sort(), ['launch-work-map', 'launch-work-map.cmd'], 'Codex must have no other PATHEXT sibling, including .mjs');
      }
      if (server.cwd) await access(contained(root, resolve(pluginRoot, server.cwd)));
    }
    for (const name of ['launch-work-map', 'launch-work-map.sh']) {
      const launcher = join(directory, 'scripts', name);
      try { await access(join(root, launcher)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const { stdout } = await execute('git', ['ls-files', '--stage', '--', launcher.replaceAll('\\', '/')], { cwd: root, timeout: 10000 });
      assert.match(stdout, /^100755 /, `${launcher} must be executable in git, not merely chmod-ed in this checkout`);
      const source = await readFile(join(root, launcher), 'utf8');
      assert(source.startsWith('#!/bin/sh\n') && !source.includes('\r'), `${launcher} needs a usable LF shebang`);
      if (process.platform !== 'win32') assert((await stat(join(root, launcher))).mode & 0o111, `${launcher} is not executable in this checkout`);
    }
  }
  // Lock the test expectation to the installation contract, not to the implementation under test.
  const installation = await readFile(resolve(scriptDirectory, '../../INSTALL.md'), 'utf8');
  for (const line of ['%USERPROFILE%\\.prioritree\\work-visibility', '~/Library/Application Support/PrioriTree/work-visibility', '$XDG_DATA_HOME/PrioriTree/work-visibility', '~/.local/share/PrioriTree/work-visibility']) assert(installation.includes(line), `Review store-location checks after INSTALL.md changes: ${line}`);
  return { manifests, message: `${manifests.length} manifests parse; versions ${manifest.version}, referenced files and git shell modes agree` };
}

async function freePort() {
  for (;;) {
    const listener = createServer();
    await new Promise((done, fail) => { listener.once('error', fail); listener.listen(0, '127.0.0.1', done); });
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    if (![47731, 47732].includes(port)) return port;
  }
}

async function portClosed(port) {
  const connected = await new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', (error) => done(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(1000, () => { socket.destroy(); done(true); });
  });
  if (connected) return false;
  const listener = createServer();
  return new Promise((done) => {
    listener.once('error', () => done(false));
    listener.listen(port, '127.0.0.1', () => listener.close(() => done(true)));
  });
}

async function waitFor(predicate, timeout, description) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert(!interrupted, 'Interrupted; cleaning up');
    assert(Date.now() < deadline, `Timed out after ${timeout / 1000}s: ${description}`);
    await delay(150);
  }
}

async function isolatedProfile(scratch, runDirectory, port, xdgFallback) {
  const home = join(scratch, 'home'), userProfile = join(scratch, 'user profile'), codexHome = join(scratch, 'codex home');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:PRIORITREE_|CODEX_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
  // Windows environment names are case-insensitive; never leave an inherited Path alias.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: userProfile, APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
    CODEX_HOME: codexHome, XDG_DATA_HOME: join(scratch, 'xdg-data'), XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
    XDG_STATE_HOME: join(scratch, 'xdg-state'), XDG_CACHE_HOME: join(scratch, 'xdg-cache'), XDG_RUNTIME_DIR: join(scratch, 'xdg-runtime'),
    TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'), TMPDIR: join(scratch, 'tmp'),
    CODEX_MCP_NODE_PATH: process.execPath, PRIORITREE_CODEX_CLI: join(scratch, 'synthetic-codex.cjs'),
    PRIORITREE_MAP_PORT: String(port), PRIORITREE_DESK_NO_OPEN: '1', PRIORITREE_AUTO_UPDATE_DISABLE: '1',
    PRIORITREE_CHECK_SOURCE_LEDGER: join(runDirectory, 'source-processes.jsonl'), PRIORITREE_CHECK_OWNER: 'public-ci/platform-checks',
    PRIORITREE_CHECK_ENGINE_LOG_DIR: join(runDirectory, 'engine-logs'),
    PATH: [dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot] : ['/usr/bin', '/bin'])].join(delimiter),
  });
  delete env.PRIORITREE_WORK_STORE_DIR;
  if (xdgFallback) delete env.XDG_DATA_HOME;
  if (process.platform === 'win32') { env.HOMEDRIVE = userProfile.slice(0, 2); env.HOMEPATH = userProfile.slice(2); }
  for (const directory of new Set([home, userProfile, codexHome, env.APPDATA, env.LOCALAPPDATA, env.TMP, ...Object.entries(env).filter(([key]) => key.startsWith('XDG_')).map(([, value]) => value)])) await mkdir(directory, { recursive: true });
  await copyFile(join(scriptDirectory, 'synthetic-codex.cjs'), env.PRIORITREE_CODEX_CLI);
  const logger = join(scratch, 'capture-engine.cjs'); await copyFile(join(scriptDirectory, 'capture-engine.cjs'), logger);
  env.NODE_OPTIONS = `--require "${logger.replaceAll('\\', '/')}"`;
  const sessionId = '11111111-2222-4333-8444-555555555555', now = Date.now(), project = { id: 'platform-check-project', name: 'Platform check project' };
  const thread = { id: sessionId, name: 'Platform check session', preview: 'Verify the installed PrioriTree plugin.', projectId: project.id, updatedAt: Math.floor(now / 1000) };
  const items = [{ turnId: 'platform-check-turn', startedAtMs: now, item: { id: 'platform-check-user', type: 'userMessage', content: [{ type: 'text', text: thread.preview }] } }];
  await saveJson(join(codexHome, 'platform-check-session.json'), { project, thread, items });
  const sessions = join(codexHome, 'sessions'); await mkdir(sessions);
  await writeFile(join(sessions, `rollout-platform-check-${sessionId}.jsonl`), [
    { timestamp: new Date(now).toISOString(), type: 'session_meta', payload: { id: sessionId, cwd: scratch, originator: 'platform-checks', source: 'cli' } },
    { timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: thread.preview } },
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  const store = process.platform === 'win32' ? join(userProfile, '.prioritree/work-visibility') : process.platform === 'darwin' ? join(home, 'Library/Application Support/PrioriTree/work-visibility') : join(env.XDG_DATA_HOME || join(home, '.local/share'), 'PrioriTree/work-visibility');
  return { env, store, project, sessionId };
}

function hostPlans() {
  const desktop = { host: 'mcpb', label: 'Claude Desktop MCPB', command: manifest.server.mcp_config.command, args: manifest.server.mcp_config.args.map((value) => expand(value, root)), cwd: root };
  if (values.phase === 'electron') return [{ ...desktop, label: 'Claude Desktop Electron', command: resolve(values.electron || ''), electron: true }];
  const plans = [];
  if (values.layout === 'repository') for (const [label, directory, metadata] of [
    ['Codex plugin', 'plugins/prioritree-work-map', '.codex-plugin/plugin.json'],
    ['Claude Code plugin', 'plugins/prioritree-work-map-claude', '.claude-plugin/plugin.json'],
  ]) plans.push({ host: label.startsWith('Codex') ? 'codex' : 'claude-code', label, pluginRoot: join(root, directory), metadata });
  plans.push(desktop);
  return plans;
}

async function resolvePlan(plan) {
  if (!plan.pluginRoot) return plan;
  const metadata = await readJson(join(plan.pluginRoot, plan.metadata));
  // Hosts load the file referenced by mcpServers. No documented OS-variant selector
  // exists here. Do not silently replace .mcp.json with .mcp.posix.json to get green CI.
  const config = (await readJson(join(plan.pluginRoot, metadata.mcpServers))).mcpServers.prioritree_work_map;
  return { ...plan, configFile: metadata.mcpServers, command: expand(config.command, plan.pluginRoot), args: config.args.map((value) => expand(value, plan.pluginRoot)), cwd: resolve(plan.pluginRoot, config.cwd || '.') };
}

function rpcClient(child, run) {
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  const rejectAll = (error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.once('error', rejectAll);
  child.once('exit', () => rejectAll(new Error(`Host exited before its response; ${run.stderr.slice(-1500)}`)));
  child.stdin.on('error', rejectAll);
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { rejectAll(new Error(`Non-JSON MCP stdout: ${line.slice(0, 300)}`)); return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(`${item.method}: ${JSON.stringify(message.error).slice(0, 1000)}`));
    else item.resolve(message.result);
  });
  const request = (method, params = {}, timeout = 20000) => new Promise((accept, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; ${run.stderr.slice(-1500)}`)); }, timeout);
    pending.set(id, { method, resolve: accept, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { request, call: (name, args = {}) => request('tools/call', { name, arguments: args }),
    initialized: () => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'),
    close: () => { rejectAll(new Error('Probe closing')); lines.close(); } };
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}

async function runProduct(originalPlan, index, xdgFallback = false) {
  const plan = await resolvePlan(originalPlan), label = plan.label + (xdgFallback ? ' (XDG fallback)' : '');
  const runDirectory = join(artifacts, `${index}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
  await mkdir(runDirectory, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'prioritree-platform checks-')), port = await freePort(), url = `http://127.0.0.1:${port}`;
  let profile, command, electronRuntime;
  try {
    profile = await isolatedProfile(scratch, runDirectory, port, xdgFallback);
    if (plan.electron) {
      profile.env.ELECTRON_RUN_AS_NODE = '1';
      const args = ['-p', 'JSON.stringify({electron:process.versions.electron,node:process.versions.node,executable:process.execPath})'];
      await saveJson(join(runDirectory, 'electron-runtime-probe.json'), { owner: 'public-ci/platform-checks', executable: plan.command, args, createdAt: new Date().toISOString(), workingDirectory: scratch, purpose: 'Bounded one-shot proof that the supplied executable is real Electron', stopCommand: 'Await exit; 20-second execFile timeout' });
      const { stdout } = await execute(plan.command, args, { cwd: scratch, env: profile.env, windowsHide: true, timeout: 20000, maxBuffer: 16000 });
      electronRuntime = JSON.parse(stdout);
      assert.match(electronRuntime.electron || '', /^\d+\.\d+\.\d+$/, 'The supplied executable is not a real Electron host');
      await saveJson(join(runDirectory, 'electron-runtime-probe.json'), { ...electronRuntime, verifiedExited: true });
    }
    command = await resolveHostLaunch(plan, profile.env);
  } catch (error) { contained(tmpdir(), scratch); await rm(scratch, { recursive: true, force: true }); throw error; }
  const { env, store, project, sessionId } = profile;
  const run = { label, host: plan.host, declaredCommand: plan.command, resolvedProgram: command.resolvedProgram, owner: 'public-ci/platform-checks', pid: null, createdAt: new Date().toISOString(), executable: command.command, workingDirectory: plan.cwd, purpose: 'Verify installed MCP server, default store, engine readiness and Stop lifecycle', stopCommand: `POST ${url}/api/desk/stop with same-origin Origin; close host stdin; verify exact owned identities and port exit`, args: command.args, configFile: plan.configFile, scratch, store, port, stderr: '', identities: [], engines: [], electronRuntime };
  summary.runs.push(run);
  const ledger = join(runDirectory, 'owner.json');
  await saveJson(ledger, run); // Record the intent before starting any persistent helper.
  let child;
  try { child = spawn(command.command, command.args, { cwd: plan.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments || false }); }
  catch (error) {
    contained(tmpdir(), scratch); await rm(scratch, { recursive: true, force: true });
    run.cleanup = { verifiedExited: true, portReleased: await portClosed(port), notStarted: true };
    run.scratchRemoved = true; await saveJson(ledger, run); throw error;
  }
  run.pid = child.pid ?? null;
  child.once('exit', (code, signal) => { run.exit = { code, signal }; });
  child.once('error', (error) => { run.launchError = error.message; });
  child.stderr.on('data', (data) => { run.stderr = (run.stderr + data).slice(-16000); });
  const rpc = rpcClient(child, run);
  let captured = [], health, supportedStop = false, cleanupPassed = false;
  const capture = async () => {
    const snapshot = await processSnapshot();
    if (!run.birth && child.pid) {
      const birth = snapshot.find((item) => item.pid === child.pid);
      if (birth) { run.birth = birth; run.createdAt = birth.createdAt; run.executable = await executablePath(birth, { env, cwd: plan.cwd }); }
    }
    // A POSIX launcher may exec Node between snapshots. Keep its captured birth/parent
    // boundary, and permit only that expected runtime transition, never PID reuse.
    const currentRoot = snapshot.find((item) => item.pid === run.birth?.pid);
    if (currentRoot && currentRoot.createdAt === run.birth.createdAt && currentRoot.parentPid === run.birth.parentPid && !sameProcess(currentRoot, run.birth)) {
      const executable = await executablePath(currentRoot, { env, cwd: plan.cwd }), expected = await realpath(plan.electron ? plan.command : process.execPath);
      assert(executable === expected, 'Owned launcher changed to an unexpected executable; preserving it');
      run.birth = currentRoot; run.executable = executable;
    }
    for (const filename of ['desk-process-owner.json', 'desk-engine.lock']) {
      let owner;
      try { owner = await readJson(join(store, filename)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const identity = snapshot.find((item) => item.pid === owner.pid);
      if (!identity || run.engines.some((item) => sameProcess(item, identity))) continue;
      const executable = await executablePath(identity, { env, cwd: plan.cwd }), allowed = executable === await realpath(process.execPath) || executable === plan.command || (isAbsolute(executable) && relative(store, executable).split(sep)[0] !== '..' && !isAbsolute(relative(store, executable)));
      assert(allowed && Date.parse(identity.createdAt) >= Date.parse(run.createdAt) - 2000, `Engine ownership is ambiguous; preserving PID ${identity.pid}`);
      const ownerUrl = new URL(owner.url);
      assert.equal(ownerUrl.origin, url, 'Engine owner points at a different port');
      run.engines.push(identity);
    }
    const roots = [...run.birth ? [run.birth] : [], ...run.engines];
    captured = [...new Map([...captured, ...descendants(snapshot, roots)].map((item) => [`${item.pid}:${item.createdAt}`, item])).values()];
    run.identities = captured;
    await saveJson(ledger, run);
    return snapshot;
  };
  const getHealth = async () => {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return undefined;
      const value = await response.json();
      if (value.ok === true && value.version === manifest.version && Number.isSafeInteger(value.pid)) return value;
      run.invalidHealth = value;
    } catch { /* Readiness is bounded separately. */ }
    return undefined;
  };
  const stop = async () => {
    await capture();
    health ||= await getHealth();
    if (health) {
      assert(run.engines.some((item) => item.pid === health.pid) || captured.some((item) => item.pid === health.pid), 'Healthy PID has no captured task-owned identity; preserving it');
      const response = await fetch(`${url}/api/desk/stop`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, 'The desk Stop control must succeed');
      assert.equal((await response.json()).ok, true);
      await waitFor(async () => {
        const snapshot = await processSnapshot();
        return !captured.some((item) => item.pid === health.pid && sameProcess(item, snapshot.find((current) => current.pid === item.pid))) && await portClosed(port);
      }, 10000, 'desk Stop must exit its engine process and release its port');
      supportedStop = true;
    }
  };
  try {
    await capture();
    const protocol = await check(`${label}: MCP handshake, tools, panel and model-free call`, async () => {
      assert(!run.launchError, `Declared launch command failed: ${run.launchError}; config ${plan.configFile || 'manifest.json'} (OS variants are not silently selected)`);
      const initialized = await rpc.request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'prioritree-platform-checks', version: '1' }, capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } });
      assert.equal(initialized.serverInfo.version, manifest.version);
      rpc.initialized();
      const hostSnapshot = await capture();
      run.hostIdentities = descendants(hostSnapshot, [run.birth]);
      const expectedRuntime = await realpath(plan.electron ? plan.command : process.execPath);
      const runtimes = await Promise.all(run.hostIdentities.map((identity) => executablePath(identity, { env, cwd: plan.cwd })));
      const normalize = (path) => process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
      assert(runtimes.some((path) => normalize(path) === normalize(expectedRuntime)), `Host did not use the selected runtime ${expectedRuntime}; observed ${runtimes.join(', ')}`);
      run.selectedRuntime = expectedRuntime;
      const { tools } = await rpc.request('tools/list');
      // try_sample_map is deliberately fixture-only in 1.13.3. Test all declared real tools.
      const expected = manifest.tools.map((tool) => tool.name).filter((name) => name !== 'try_sample_map');
      for (const name of expected) assert(tools.some((tool) => tool.name === name), `Missing tool: ${name}`);
      const panelUri = tools.find((tool) => tool.name === 'open_work_map')?._meta?.ui?.resourceUri;
      assert.equal(panelUri, 'ui://prioritree/work-map');
      const panel = await rpc.request('resources/read', { uri: panelUri });
      const html = panel.contents.find((item) => item.uri === panelUri);
      assert.equal(html?.mimeType, 'text/html;profile=mcp-app');
      assert(html.text.includes('<script') && html.text.includes('PrioriTree'), 'Panel HTML was not served');
      const opened = await rpc.call('open_work_map');
      assert(!opened.isError, `open_work_map: ${JSON.stringify(opened).slice(0, 1500)}`);
      const recent = await rpc.call('list_recent_chats');
      assert(!recent.isError, `list_recent_chats: ${JSON.stringify(recent).slice(0, 1500)}`);
      const snapshot = await readJson(join(store, 'snapshot.json'));
      assert(snapshot.workspace?.conversations.some((item) => item.ref.sessionId === sessionId), 'Real mode did not read the synthetic Codex session');
      const rules = await rpc.call('get_mapping_rules', { projectId: project.id });
      assert(!rules.isError, `get_mapping_rules: ${JSON.stringify(rules).slice(0, 1000)}`);
      return { tools: tools.map((tool) => tool.name), panelBytes: Buffer.byteLength(html.text), modelFreeCall: 'get_mapping_rules', syntheticSession: sessionId, message: `${expected.length} expected real-mode tools; synthetic session scanned; get_mapping_rules succeeded` };
    });
    await check(`${label}: documented default store`, async () => {
      assert(protocol, 'Host protocol failed; default store could not be proved');
      assert.equal(env.PRIORITREE_WORK_STORE_DIR, undefined);
      await access(join(store, 'snapshot.json')); await access(join(store, 'diagnostics.log'));
      const locations = [...new Set((await files(scratch)).filter((path) => path.split(sep).includes('work-visibility')).map((path) => path.slice(0, path.indexOf(`${sep}work-visibility`) + `${sep}work-visibility`.length)))];
      assert.deepEqual(locations, [store], `Unexpected additional store: ${locations.join(', ')}`);
      return { location: relative(scratch, store), message: relative(scratch, store) };
    });
    // Explicit model-free open_desk tests the real host command's engine route. Automatic
    // model refresh is disabled; the store and Codex-source paths remain real mode.
    const readinessStart = Date.now();
    const deskRequest = protocol ? rpc.call('open_desk').catch((error) => ({ isError: true, content: [{ type: 'text', text: error.message }] })) : Promise.resolve(undefined);
    await check(`${label}: engine health and desk page within 60s`, async () => {
      assert(protocol, 'Host did not start; engine cannot be proved');
      const desk = await deskRequest;
      run.deskResult = { isError: !!desk?.isError, structuredContent: desk?.structuredContent, text: desk?.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n').slice(0, 3000) };
      while (!(health = await getHealth()) && Date.now() - readinessStart < 60000) {
        if (desk?.isError) break;
        assert(!interrupted, 'Interrupted; cleaning up'); await delay(200);
      }
      await capture();
      assert(health, `No healthy ${manifest.version} engine within 60s${run.invalidHealth ? `; health=${JSON.stringify(run.invalidHealth)}` : ''}; ${run.deskResult.text || run.stderr.slice(-1500)}`);
      assert(!desk?.isError, run.deskResult.text);
      assert.equal(health.version, manifest.version);
      const page = await fetch(url, { signal: AbortSignal.timeout(5000) });
      assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
      const html = await page.text(); assert.match(html, /PrioriTree/i); assert.match(html, /<script/);
      for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        if (/^(?:[a-z]+:|\/\/)/i.test(match[1])) continue;
        const asset = await fetch(new URL(match[1], url), { signal: AbortSignal.timeout(5000) });
        assert.equal(asset.status, 200, `Desk resource ${match[1]} missing`); assert((await asset.arrayBuffer()).byteLength > 0);
      }
      run.health = health;
      run.engineMode = run.hostIdentities.some((item) => item.pid === health.pid) ? 'in-process' : 'detached';
      if (plan.electron && run.engineMode === 'in-process') assert(/in.process|fallback/i.test(JSON.stringify(run.deskResult) + run.stderr), 'In-process fallback must be explicitly reported');
      return { ...health, mode: run.engineMode, message: `${manifest.version}, PID ${health.pid}, ${run.engineMode}; HTML and scripts served` };
    });
    if (plan.electron) {
      await check(`${label}: scan advances or reports a clear error`, async () => {
        const snapshot = await readJson(join(store, 'snapshot.json'));
        assert(snapshot.build && ((snapshot.build.status !== 'scanning' && snapshot.workspace?.conversations.some((item) => item.ref.sessionId === sessionId)) || (typeof snapshot.build.error === 'string' && snapshot.build.error.trim().length > 10)), `Build stuck scanning without a clear error: ${JSON.stringify(snapshot.build)}`);
        run.build = snapshot.build;
        return { status: snapshot.build.status, error: snapshot.build.error, message: snapshot.build.status };
      });
      await check(`${label}: Electron is never copied into the store as Node`, async () => {
        const size = (await stat(plan.command)).size, hash = await sha256(plan.command), copies = [];
        for (const path of await files(store)) if ((await stat(path)).size === size && await sha256(path) === hash) copies.push(relative(store, path));
        run.electronBinary = { bytes: size, sha256: hash, copies };
        assert(!copies.length, `ELECTRON_RUNTIME_COPIED: the Windows launcher copied process.execPath (Claude.exe/Electron with ELECTRON_RUN_AS_NODE=1) as node.exe. Electron binary SHA256 ${hash} was found at ${copies.join(', ')}; this is the 1.13.3 engine-launch regression`);
        return { bytes: size, sha256: hash, message: 'no size-and-SHA256 match anywhere in the default store' };
      });
    }
    await check(`${label}: desk Stop exits the engine and releases the port`, async () => {
      assert(health, 'Engine never became healthy; Stop behavior could not be proved');
      await stop();
      assert(supportedStop);
      return { port, pid: health.pid, message: `PID ${health.pid} exited; port ${port} closed and bindable` };
    });
  } finally {
    await check(`${label}: all owned processes and ports cleaned up`, async () => {
      let cleanupError;
      try { if (!supportedStop) await stop(); } catch (error) { cleanupError = error.message; }
      try { await capture(); } catch (error) { cleanupError = [cleanupError, error.message].filter(Boolean).join('; '); }
      rpc.close(); child.stdin.end();
      try { await waitFor(() => !!run.exit || !!run.launchError, 5000, 'MCP stdin shutdown'); } catch (error) { cleanupError = [cleanupError, error.message].filter(Boolean).join('; '); }
      const stopped = await stopCapturedProcesses(captured);
      await waitFor(() => portClosed(port), 5000, 'task port release after cleanup');
      const snapshot = await processSnapshot();
      assert(!captured.some((item) => sameProcess(item, snapshot.find((current) => current.pid === item.pid))), 'An owned identity survived cleanup');
      // A short-lived synthetic source may have already exited before a tree snapshot.
      // Audit its receipts against current OS births without ever stopping a reused PID.
      let sources = [];
      try { sources = (await readFile(env.PRIORITREE_CHECK_SOURCE_LEDGER, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert(!sources.some((item) => item.unexpectedMethod || item.forbiddenModelCommand), 'A model or unsupported source operation was attempted; see source-processes.jsonl');
      for (const source of sources.filter((item) => item.pid)) {
        const current = snapshot.find((item) => item.pid === source.pid);
        assert(!current || Math.abs(Date.parse(current.createdAt) - Date.parse(source.createdAt)) > 2000, `Synthetic source PID ${source.pid} is still running`);
      }
      run.cleanup = { ...stopped, portReleased: true, supportedStop, recoveryReason: cleanupError };
      cleanupPassed = true;
      await saveJson(ledger, run);
      return { message: `${captured.length} captured identities and ${sources.length} source receipts exited; port ${port} released` };
    });
    await writeFile(join(runDirectory, 'host-stderr.log'), run.stderr);
    // Keep small diagnostics and ownership evidence on failure, never runtime binaries,
    // dependency trees, widget payloads or personal data (all source here is synthetic).
    for (const path of await files(store)) if (/\.(?:jsonl?|log|txt)$/.test(path) && (await stat(path)).size < 2 * 1024 * 1024) {
      const target = join(runDirectory, 'store', relative(store, path)); await mkdir(dirname(target), { recursive: true }); await copyFile(path, target);
    }
    run.generatedBytes = (await Promise.all((await files(scratch)).map(async (path) => (await stat(path)).size))).reduce((sum, size) => sum + size, 0);
    if (cleanupPassed) { contained(tmpdir(), scratch); await rm(scratch, { recursive: true, force: true }); run.scratchRemoved = true; }
    else run.scratchPreservedReason = 'Process ownership or exit could not be verified';
    await saveJson(ledger, run);
    if (!cleanupPassed) throw new Error(`Cleanup unverified; preserving isolated profile ${scratch}`);
  }
}

try {
  await check('manifests, versions, references and git executable modes', validateManifests);
  if (!values['manifest-only']) {
    if (values.phase === 'electron') {
      assert(values.electron, '--phase electron requires --electron PATH to a real installed Electron binary');
      await access(resolve(values.electron));
    }
    const plans = hostPlans().filter((plan) => !values.hosts || values.hosts.split(',').includes(plan.label));
    assert(plans.length, 'No matching hosts');
    let index = 0;
    const runCheck = async (plan, xdgFallback = false) => {
      const start = summary.checks.length;
      await runProduct(plan, ++index, xdgFallback);
      const failed = summary.checks.slice(start).filter((item) => !item.passed);
      assert(!failed.length, `${failed.length} checks failed in this host run; see the named failures above`);
    };
    for (const plan of plans) {
      assert(!interrupted, 'Interrupted; remaining hosts skipped after cleanup');
      await check(`${plan.label}: lifecycle run`, () => runCheck(plan));
    }
    // Exercise the unselected variants too, but their success cannot hide a broken default.
    if (values.layout === 'repository' && values.phase === 'node' && !values.hosts) for (const [label, directory] of [['Codex POSIX variant', 'prioritree-work-map'], ['Claude Code platform variant', 'prioritree-work-map-claude']]) {
      if (process.platform === 'win32' && label.startsWith('Codex')) continue;
      const pluginRoot = join(root, 'plugins', directory), filename = process.platform === 'win32' ? '.mcp.windows.json' : '.mcp.posix.json';
      let config;
      try { config = (await readJson(join(pluginRoot, filename))).mcpServers.prioritree_work_map; }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; } // New releases need only the referenced .mcp.json.
      const plan = { host: label.startsWith('Codex') ? 'codex' : 'claude-code', label, command: expand(config.command, pluginRoot), args: config.args.map((value) => expand(value, pluginRoot)), cwd: pluginRoot, configFile: filename };
      await check(`${label}: lifecycle run`, () => runCheck(plan));
    }
    if (process.platform === 'linux' && values.phase === 'node') await check('Linux XDG fallback: lifecycle run', () => runCheck(hostPlans().find((plan) => !plan.pluginRoot), true));
  }
} catch (error) {
  summary.checks.push({ name: 'check controller', passed: false, error: error.message });
  console.error(`FAIL check controller: ${error.message}`);
} finally {
  summary.passed = summary.checks.every((item) => item.passed);
  await saveJson(join(artifacts, 'controller.json'), { ...controller, state: 'completed', helpersVerifiedExited: summary.runs.every((run) => run.cleanup?.verifiedExited && run.cleanup?.portReleased) });
  await saveJson(join(artifacts, 'summary.json'), summary);
  const failed = summary.checks.filter((item) => !item.passed);
  console.log(`RESULT ${summary.passed ? 'PASS' : 'FAIL'}: ${summary.checks.length - failed.length} passed, ${failed.length} failed; ${process.platform}/${process.arch}, ${process.version}, bundle ${manifest.version}`);
  console.log(`Diagnostics: ${artifacts}`);
  process.exitCode = summary.passed ? 0 : 1;
}
