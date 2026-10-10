// AI Local Agent Orchestrator routes.
//
// Lifecycle management (Start/Stop Backend, Start/Stop Frontend) for the
// registered local AI applications. Child processes are spawned with
// child_process.spawn and tracked in an in-memory registry; status lives in
// the ai_orchestrator store (MySQL or file fallback) and is reconciled
// against reality (live child? port actually listening?) on every read.
import { Router } from 'express';
import { spawn, exec } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import util from 'util';
import * as store from './orchestratorStore.js';

const execPromise = util.promisify(exec);

// The port this Express server itself listens on (server.js). A registered
// app whose backend_port matches it IS this orchestrator.
const ORCHESTRATOR_PORT = Number(process.env.PORT) || 3002;

/** processKey -> ChildProcess. Survives only while this server runs. */
const activeProcesses = {};
/** processKeys the user deliberately stopped (so exit → STOPPED, not ERROR). */
const deliberateStops = new Set();

/* ----------------------------- OS helpers ----------------------------- */

/**
 * True if a TCP server is accepting connections on the port. Vite can listen
 * on the IPv6 loopback only ([::1]), so both stacks are probed.
 */
function probePort(port, timeoutMs = 900) {
  const tryHost = host => new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then(([v4, v6]) => v4 || v6);
}

async function waitForPort(port, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probePort(port, 500)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

/** PID of the process LISTENING on the given port (Windows netstat), or null. */
async function findPidListeningOn(port) {
  try {
    const { stdout } = await execPromise('netstat -ano');
    for (const line of stdout.split('\n')) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] || '';
      if (local.endsWith(`:${port}`)) {
        const pid = Number(cols[cols.length - 1]);
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
    }
  } catch { /* netstat unavailable — treat as not found */ }
  return null;
}

/** Kills a whole process tree (Windows: taskkill /T /F; POSIX: SIGTERM). */
async function killTree(pid) {
  if (process.platform === 'win32') {
    await execPromise(`taskkill /PID ${pid} /T /F`).catch(() => {});
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

function childAlive(child) {
  return !!child && child.exitCode === null && child.signalCode === null;
}

/* --------------------------- Process control --------------------------- */

function spawnService(kind, app, appPath) {
  const port = String(app[`${kind}_port`]);
  // Frontend uses extra vite args (PORT env is ignored by vite); strictPort
  // makes it fail loudly instead of silently drifting to port+1.
  const command = 'npm';
  const args = kind === 'backend'
    ? ['start']
    : ['run', 'dev', '--', '--port', port, '--strictPort'];

  const logDir = path.resolve(appPath, '..', '..', '.logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  let logStream = null;
  try { logStream = fs.createWriteStream(path.join(logDir, `${kind}.log`), { flags: 'a' }); } catch {}
  const child = spawn(command, args, {
    cwd: appPath,
    env: { ...process.env, PORT: port },
    shell: true,
    windowsHide: true,
    stdio: logStream ? ['ignore', logStream, logStream] : 'ignore'
  });

  const key = `${kind}_${app.id}`;
  const col = `${kind}_status`;
  activeProcesses[key] = child;

  child.on('exit', async () => {
    try { logStream?.end(); } catch {}
    if (activeProcesses[key] !== child) return; // superseded by a newer spawn
    delete activeProcesses[key];
    try {
      if (deliberateStops.has(key)) {
        deliberateStops.delete(key);
        await store.updateStatus(app.id, col, 'STOPPED');
      } else {
        // Crashed or exited on its own → surface as ERROR.
        await store.updateStatus(app.id, col, 'ERROR');
      }
    } catch { /* store write is best-effort */ }
  });

  return child;
}

/**
 * Reconciles stored status with reality:
 *  - the orchestrator's own backend is always RUNNING;
 *  - a live tracked child means RUNNING;
 *  - a port that answers → RUNNING (external survivor or recovered ERROR),
 *    unless the listener is the orchestrator process itself (port squatted
 *    by another registered app's config — e.g. Gemma frontend on 3002);
 *  - a previously-RUNNING row whose port stopped answering → STOPPED (died);
 *  - ERROR stays sticky while the port is down.
 */
async function reconcile() {
  const apps = await store.listApplications();
  await Promise.all(apps.map(async app => {
    for (const kind of ['backend', 'frontend']) {
      const col = `${kind}_status`;
      const port = app[`${kind}_port`];
      const key = `${kind}_${app.id}`;
      const isSelf = kind === 'backend' && port === ORCHESTRATOR_PORT;

      let next = app[col];
      if (isSelf) {
        next = 'RUNNING';
      } else if (childAlive(activeProcesses[key])) {
        next = 'RUNNING';
      } else {
        const listening = await probePort(port);
        if (listening) {
          const pid = await findPidListeningOn(port);
          next = pid === process.pid ? 'STOPPED' : 'RUNNING';
        } else {
          next = app[col] === 'RUNNING' ? 'STOPPED' : app[col];
        }
      }
      if (next !== app[col]) {
        await store.updateStatus(app.id, col, next);
        app[col] = next;
      }
    }
  }));
  return apps;
}

/* ------------------------------ Toggles ------------------------------ */

async function toggleService(id, kind) {
  const app = await store.getApplication(id);
  if (!app) return { code: 404, body: { error: 'App not found' } };

  const col = `${kind}_status`;
  const port = app[`${kind}_port`];
  const pathCol = `${kind}_path`;
  const key = `${kind}_${id}`;
  const isSelfBackend = kind === 'backend' && port === ORCHESTRATOR_PORT;

  // ---------- STOP ----------
  if (app[col] === 'RUNNING' || childAlive(activeProcesses[key])) {
    if (isSelfBackend) {
      return {
        code: 409,
        body: { error: 'This backend hosts the orchestrator API itself and cannot be stopped from here.' }
      };
    }
    if (childAlive(activeProcesses[key])) {
      deliberateStops.add(key);
      await killTree(activeProcesses[key].pid);
      await store.updateStatus(id, col, 'STOPPED');
      return { code: 200, body: { message: `${kind} stopped`, status: 'STOPPED' } };
    }
    // RUNNING in the DB but we don't own the process (started outside the
    // orchestrator, or survived a server restart) — adopt and kill it by the
    // port it holds. Never kill our own PID.
    const pid = await findPidListeningOn(port);
    if (pid === process.pid) {
      return { code: 409, body: { error: `Port ${port} is used by the orchestrator itself — refusing to kill.` } };
    }
    if (pid) {
      await killTree(pid);
      await store.updateStatus(id, col, 'STOPPED');
      return { code: 200, body: { message: `${kind} stopped (external process PID ${pid})`, status: 'STOPPED' } };
    }
    await store.updateStatus(id, col, 'STOPPED');
    return { code: 200, body: { message: `${kind} already stopped`, status: 'STOPPED' } };
  }

  // ---------- START ----------
  if (isSelfBackend) {
    await store.updateStatus(id, col, 'RUNNING');
    return { code: 200, body: { message: 'Backend already running (this service hosts the orchestrator).', status: 'RUNNING' } };
  }

  if (await probePort(port)) {
    return { code: 409, body: { error: `Port ${port} is already in use by another process — free it or change the app's port.` } };
  }

  const appPath = path.resolve(app[pathCol]);
  if (!fs.existsSync(appPath)) {
    await store.updateStatus(id, col, 'ERROR');
    return { code: 400, body: { error: `${kind}_path does not exist: ${app[pathCol]}` } };
  }

  const child = spawnService(kind, app, appPath);
  const ready = await waitForPort(port, 15000);
  if (!ready) {
    const key = `${kind}_${id}`;
    const alive = childAlive(child);
    if (alive) {
      deliberateStops.add(key);
      await killTree(child.pid);
    }
    await store.updateStatus(id, col, 'ERROR');
    return {
      code: 500,
      body: { error: `${kind} did not start listening on port ${port}. Check the service log under ${path.join(appPath, '..', '..', '.logs')}.` }
    };
  }
  await store.updateStatus(id, col, 'RUNNING');
  return { code: 200, body: { message: `${kind} started and is listening on port ${port}`, status: 'RUNNING' } };
}

/* ------------------------------- Routes ------------------------------- */

const router = Router();

// Get all registered applications (statuses reconciled against reality).
router.get('/applications', async (req, res) => {
  try {
    res.json(await reconcile());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle Backend Process (Start / Stop)
router.post('/applications/:id/backend/toggle', async (req, res) => {
  try {
    const result = await toggleService(Number(req.params.id), 'backend');
    res.status(result.code).json(result.body);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle Frontend Process (Start / Stop)
router.post('/applications/:id/frontend/toggle', async (req, res) => {
  try {
    const result = await toggleService(Number(req.params.id), 'frontend');
    res.status(result.code).json(result.body);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
