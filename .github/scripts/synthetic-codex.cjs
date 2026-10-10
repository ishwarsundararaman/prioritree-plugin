// A synthetic, read-only Codex app-server source. No model or installed Codex is used.
// The product server and desk still run in real mode, against an isolated profile.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const home = process.env.CODEX_HOME;
if (!home || !process.env.PRIORITREE_CHECK_SOURCE_LEDGER) throw new Error('Synthetic source needs its isolated profile and ledger');
const source = JSON.parse(fs.readFileSync(path.join(home, 'platform-check-session.json'), 'utf8'));
if (process.argv[2] !== 'app-server') {
  fs.appendFileSync(process.env.PRIORITREE_CHECK_SOURCE_LEDGER, JSON.stringify({ forbiddenModelCommand: process.argv.slice(2) }) + '\n');
  throw new Error('Synthetic Codex accepts only read-only app-server requests, never model execution');
}
fs.appendFileSync(process.env.PRIORITREE_CHECK_SOURCE_LEDGER, JSON.stringify({
  owner: process.env.PRIORITREE_CHECK_OWNER, pid: process.pid, parentPid: process.ppid,
  createdAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  executable: process.execPath, workingDirectory: process.cwd(),
  purpose: 'Serve one synthetic Codex session; read-only app-server protocol, no models',
  stopCommand: 'Close stdin and verify this process exits',
}) + '\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize': result = { userAgent: 'prioritree-platform-check-source/1' }; break;
    case 'project/list': result = { data: [source.project], nextCursor: null }; break;
    case 'thread/list': result = { data: [source.thread], nextCursor: null }; break;
    case 'thread/read': result = { thread: { ...source.thread, historyMode: 'paginated' } }; break;
    case 'thread/items/list': result = { data: source.items, nextCursor: null }; break;
    default:
      fs.appendFileSync(process.env.PRIORITREE_CHECK_SOURCE_LEDGER, JSON.stringify({ unexpectedMethod: request.method }) + '\n');
      process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: `Synthetic source forbids ${request.method}; no model operations are supported` } }) + '\n');
      return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
});
lines.on('close', () => process.exit(0));
process.once('SIGTERM', () => lines.close());
