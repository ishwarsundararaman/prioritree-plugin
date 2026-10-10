// Emulate the host before spawning the declared server; do not substitute a variant.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const environmentValue = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

async function windowsBinary(path) {
  // which 8 uses GetBinaryType for an extensionless candidate, not X_OK. A sh
  // script must be rejected even when Node's Windows access(X_OK) accepts it.
  // https://github.com/harryfei/which-rs/blob/8.0.0/src/checker.rs#L13-L28
  // https://github.com/harryfei/which-rs/blob/8.0.0/src/sys.rs (is_valid_executable)
  const file = await open(path);
  try {
    const magic = Buffer.alloc(2);
    if ((await file.read(magic, 0, 2, 0)).bytesRead !== 2 || magic.toString() !== 'MZ') return false;
  } finally { await file.close(); }
  assert.equal(process.platform, 'win32', 'A Windows binary needs native GetBinaryType validation');
  const code = 'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class WhichBinary { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, EntryPoint="GetBinaryTypeW")] public static extern bool Check(string path, out uint kind); }\'; $kind=[uint32]0; if ([WhichBinary]::Check($env:PRIORITREE_WHICH_BINARY,[ref]$kind)) { "yes" } else { "no" }';
  const { stdout } = await execute(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], { env: { ...process.env, PRIORITREE_WHICH_BINARY: path }, windowsHide: true, timeout: 10000, maxBuffer: 16000 });
  return stdout.trim() === 'yes';
}

async function candidateFile(path) {
  // which corrects casing, including PATHEXT .CMD versus a lowercase .cmd file.
  try {
    const name = (await readdir(dirname(path))).find((entry) => entry.toLowerCase() === basename(path).toLowerCase());
    if (!name) return undefined;
    const candidate = join(dirname(path), name);
    return (await stat(candidate)).isFile() ? candidate : undefined;
  } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined; throw error; }
}

export async function whichInWindows(program, env, cwd, { pathExt = environmentValue(process.env, 'PATHEXT') || '', binaryCheck = windowsBinary } = {}) {
  // Codex resolve() calls which_in(program, env PATH, cwd), falling back to the
  // original program on lookup failure. PATHEXT is read from the host process.
  // https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/rmcp-client/src/program_resolver.rs#L41-L65
  // which 8: relative paths with separators use cwd; bare names use PATH. Try
  // the exact file, then append PATHEXT unless it already has an executable ext.
  // https://github.com/harryfei/which-rs/blob/8.0.0/src/finder.rs#L73-L87
  // https://github.com/harryfei/which-rs/blob/8.0.0/src/finder.rs#L186-L225
  const extensions = pathExt.split(';').filter((extension) => extension.startsWith('.'));
  const nativeProgram = program.replaceAll('\\', sep);
  const paths = /[/\\]/.test(program) ? [resolve(cwd, nativeProgram)] : (environmentValue(env, 'PATH') || '').split(';').filter(Boolean).map((directory) => resolve(cwd, directory, nativeProgram));
  for (const path of paths) {
    const suffixes = extensions.some((extension) => extension.toLowerCase() === extname(path).toLowerCase()) ? [''] : ['', ...extensions];
    for (const suffix of suffixes) {
      const candidate = await candidateFile(path + suffix);
      if (candidate && (extname(candidate) || await binaryCheck(candidate))) return candidate;
    }
  }
  return program;
}

export async function resolveHostLaunch(plan, env, { platform = process.platform, runtime = process.execPath, pathExt } = {}) {
  let command = plan.command;
  if (plan.host === 'mcpb') {
    // A node MCPB uses the host-supplied Node/Electron runtime, independent of PATH.
    // https://github.com/anthropics/mcpb/blob/main/MANIFEST.md#server-configuration
    if (!plan.electron) { assert.equal(command, 'node', 'Expected a node MCPB declaration'); command = runtime; }
  } else if (plan.host === 'codex') {
    if (platform === 'win32') command = await whichInWindows(command, env, plan.cwd, { pathExt });
    // Unix resolve returns program unchanged: direct exec uses the kernel shebang.
    // https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/rmcp-client/src/program_resolver.rs#L23-L29
    if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
      // Rust Command runs the resolved batch file through cmd.exe. Node spawn
      // requires this explicit adapter; do not apply it to Claude Code commands.
      // Codex's explicit batch execution test: program_resolver.rs#L111-L127 at the same ref.
      assert(![command, ...plan.args].some((value) => /["\r\n%&|<>^]/.test(value)), 'Unsafe Windows launch argument');
      return { command: join(environmentValue(env, 'SYSTEMROOT') || process.env.SystemRoot, 'System32/cmd.exe'), args: ['/d', '/s', '/c', `""${command}" ${plan.args.map((value) => `"${value}"`).join(' ')}"`], windowsVerbatimArguments: true, resolvedProgram: command };
    }
  } else {
    assert.equal(plan.host, 'claude-code', 'Unknown host resolution contract');
    // Claude Code declares an executable and argv. Keep a plain spawn of node;
    // no Codex PATHEXT lookup or implicit batch wrapping is applied here.
    // https://code.claude.com/docs/en/plugins-reference#mcp-servers
    // https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server
  }
  return { command, args: plan.args, resolvedProgram: command };
}
