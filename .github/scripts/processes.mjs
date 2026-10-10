// Only inspect and stop processes whose birth identity was captured by this task.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

const execute = promisify(execFile);
export const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function processSnapshot() {
  if (process.platform === 'win32') {
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = "@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;createdAt=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath} }) | ConvertTo-Json -Compress";
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  const { stdout } = await execute('ps', ['-eo', 'pid=,ppid=,lstart=,comm='], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), createdAt: new Date(match[3]).toISOString(), executable: match[4].trim() }] : [];
  });
}

export function sameProcess(first, second) {
  return !!first && !!second && first.pid === second.pid && first.createdAt === second.createdAt && first.executable === second.executable;
}

export function descendants(snapshot, roots) {
  const owned = new Map();
  for (const root of roots) {
    const current = snapshot.find((item) => item.pid === root.pid);
    if (sameProcess(root, current)) owned.set(current.pid, current);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot) if (!owned.has(item.pid) && owned.has(item.parentPid)) {
      owned.set(item.pid, item);
      changed = true;
    }
  }
  return [...owned.values()];
}

export function executableTextPaths(output) {
  let text = false;
  return output.split('\n').flatMap((field) => {
    if (field.startsWith('f')) text = field === 'ftxt';
    return text && field.startsWith('n') ? [field.slice(1)] : [];
  });
}

export async function executableOnPath(command, env = process.env, cwd = process.cwd()) {
  const candidates = isAbsolute(command) ? [command] : command.includes('/') ? [resolve(cwd, command)] : (env.PATH || '').split(delimiter).filter(Boolean).map((entry) => join(entry, command));
  for (const candidate of candidates) try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next PATH entry. */ }
  throw new Error(`Cannot resolve executable ${command} through the child's PATH`);
}

export async function executablePath(identity, { env = process.env, cwd = process.cwd() } = {}) {
  if (process.platform === 'linux') return realpath(`/proc/${identity.pid}/exe`);
  if (process.platform === 'darwin') {
    try {
      // comm can be only "node" on macOS. lsof's txt descriptors contain the
      // loaded executable and libraries; match the command name, preserving spaces.
      const { stdout } = await execute('/usr/sbin/lsof', ['-a', '-p', String(identity.pid), '-d', 'txt', '-Ffn'], { timeout: 10000, maxBuffer: 1024 * 1024 });
      for (const path of executableTextPaths(stdout)) if (basename(path) === basename(identity.executable)) {
        try { await access(path, constants.X_OK); return await realpath(path); } catch { /* Fall back to the child launch environment. */ }
      }
    } catch { /* lsof may be unavailable or denied. ps + the child PATH is supported. */ }
    return executableOnPath(identity.executable, env, cwd);
  }
  return identity.executable;
}

export async function stopCapturedProcesses(identities) {
  // Supported shutdown (stdin EOF / the desk Stop endpoint) happens first in the caller.
  // Force is a bounded recovery action, and never substitutes for a passing Stop check.
  const unique = [...new Map(identities.map((item) => [`${item.pid}:${item.createdAt}`, item])).values()];
  const survivors = (snapshot) => unique.filter((item) => sameProcess(item, snapshot.find((current) => current.pid === item.pid)));
  let live = survivors(await processSnapshot());
  const forcedPids = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const identity of live.reverse()) {
      const current = (await processSnapshot()).find((item) => item.pid === identity.pid);
      if (!sameProcess(identity, current)) continue;
      try { process.kill(identity.pid, signal); forcedPids.push(identity.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await delay(300);
    live = survivors(await processSnapshot());
    if (!live.length) break;
  }
  if (live.length) throw new Error(`Owned process identities still running: ${live.map((item) => item.pid).join(', ')}`);
  return { verifiedExited: true, forcedPids: [...new Set(forcedPids)] };
}
