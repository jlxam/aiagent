import { spawn } from 'child_process';
import path from 'path';

const viteBin = path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');
const vitePort = process.env.VITE_PORT || '5173';
const children = [];

const backend = spawn(process.execPath, ['server.js'], {
  stdio: 'inherit',
  env: { ...process.env }
});
children.push(backend);

const frontend = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', vitePort], {
  stdio: 'inherit',
  env: { ...process.env }
});
children.push(frontend);

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  setTimeout(() => process.exit(code), 250);
}

for (const child of children) {
  child.on('exit', code => {
    if (!shuttingDown && code !== 0) shutdown(code || 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
