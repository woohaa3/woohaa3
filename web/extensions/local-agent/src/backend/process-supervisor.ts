/** A dedicated parent-pipe guardian: even a killed/reloaded host cannot orphan its agent. */
export const AGENT_PROCESS_SUPERVISOR = String.raw`
const { spawn, execFileSync } = require('node:child_process');
const { command, args } = JSON.parse(process.argv[1]);
const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
const child = spawn(batch ? '"' + command + '"' : command,
  args.map(arg => batch && arg === '' ? '""' : arg), {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    ...(batch ? { shell: true } : {}),
    detached: process.platform !== 'win32'
  });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      else process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
  process.exit(0);
};
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('spawn', () => process.send?.({ type: 'ready' }));
child.on('error', error => {
  process.send?.({ type: 'spawn-error', message: error.message }, () => process.exit(1));
});
child.on('exit', code => process.exit(code ?? 1));
`;
