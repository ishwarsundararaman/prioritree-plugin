// Diagnostic preload only. Preserve writes, exit handling, launch commands and execPath.
// This is inherited by the actual engine; it does not launch or replace the engine.
if (process.argv.includes('--engine') && process.env.PRIORITREE_CHECK_ENGINE_LOG_DIR) {
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = process.env.PRIORITREE_CHECK_ENGINE_LOG_DIR;
  fs.mkdirSync(directory, { recursive: true });
  const logfile = path.join(directory, `engine-${process.pid}.log`);
  let bytes = 0;
  function record(value) {
    const data = Buffer.from(String(value));
    if (bytes >= 1024 * 1024) return;
    const bounded = data.subarray(0, 1024 * 1024 - bytes);
    try { fs.appendFileSync(logfile, bounded); bytes += bounded.length; } catch { /* Logging must not change product behavior. */ }
  }
  record(JSON.stringify({ owner: 'public-ci/platform-checks', pid: process.pid, parentPid: process.ppid,
    createdAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), executable: process.execPath,
    workingDirectory: process.cwd(), args: process.argv.slice(1), purpose: 'Capture the actual released engine diagnostics',
    stopCommand: `Same-origin POST http://127.0.0.1:${process.env.PRIORITREE_MAP_PORT}/api/desk/stop`,
    electron: process.versions.electron, node: process.versions.node }) + '\n');
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    stream.write = function (...args) { record(args[0]); return write.apply(this, args); };
  }
  process.on('uncaughtExceptionMonitor', (error) => record(`${error.stack || error}\n`));
  process.on('exit', (code) => record(`Engine exit ${code}\n`));
}
