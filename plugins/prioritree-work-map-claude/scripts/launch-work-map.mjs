// Portable stdio bootstrap. Keep stdout exclusively for the MCP server.
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function selectNodeRuntime(hostKind, env = process.env, bootstrap = process.execPath) {
  if (hostKind === 'codex' && env.CODEX_MCP_NODE_PATH) {
    try {
      const candidate = await realpath(env.CODEX_MCP_NODE_PATH);
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* A missing host hint falls back to the Node that started us. */ }
  }
  return realpath(bootstrap);
}

export async function launchWorkMap(args = process.argv.slice(2)) {
  const hostKind = args[0] === 'codex' || args[0] === 'claude' ? args.shift() : 'claude';
  const entry = fileURLToPath(new URL('../server/work-map.mjs', import.meta.url));
  const runtime = await selectNodeRuntime(hostKind);
  if (runtime === await realpath(process.execPath)) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 20 || (major === 20 && minor < 19)) throw new Error('Install Node.js 20.19 or newer and restart your host.');
    // The engine sees the actual packaged server entry, just as with the old
    // shell launchers. Import in place so EOF and signals reach the MCP process.
    process.argv = [process.execPath, entry, ...args];
    await import(pathToFileURL(entry).href);
    return;
  }
  // Node 20 has no portable execve. Inherit stdio and forward shutdown to the
  // selected host runtime, then wait for its exit before retiring the bootstrap.
  const child = spawn(runtime, [entry, ...args], { stdio: 'inherit', windowsHide: true });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('exit', (code, signal) => {
        process.exitCode = code ?? 128 + (osConstants.signals[signal] || 1);
        done();
      });
    });
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await launchWorkMap().catch((error) => { console.error(`PrioriTree could not start: ${error.message}`); process.exitCode = 1; });
}
