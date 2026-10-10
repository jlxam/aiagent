// Persistence for the AI Local Agent Orchestrator.
//
// Primary store is the ai_orchestrator MySQL database (applications table —
// registered target apps with ports + lifecycle status). It reuses the same
// mysql2 pool as the agent layer when MySQL is available, and transparently
// falls back to a local JSON file store with IDENTICAL semantics otherwise —
// so the whole app runs without MySQL installed and upgrades automatically
// once MySQL is running (zero code changes, just restart the server).
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(WORKSPACE_ROOT, '.data');
const FILE_STORE_PATH = path.join(DATA_DIR, 'ai_orchestrator.json');

const ORCH_DB = 'ai_orchestrator';
const TABLE = 'applications';

let fileData = null;
let mode = 'file'; // 'mysql' | 'file'

export function getMode() {
  return mode;
}

/**
 * Seed rows: the example apps configured with valid local Windows paths 
 * relative to WORKSPACE_ROOT, plus the main AgentStudio entry.
 */
function seedApps() {
  return [
    { 
      name: 'DeepSeek Code Assistant', 
      model_type: 'deepseek', 
      backend_path: path.join(WORKSPACE_ROOT, 'apps', 'deepseek-agent', 'backend'), 
      frontend_path: path.join(WORKSPACE_ROOT, 'apps', 'deepseek-agent', 'frontend'), 
      backend_port: 5001, 
      frontend_port: 3001 
    },
    { 
      name: 'Gemma Chat Bot', 
      model_type: 'gemma', 
      backend_path: path.join(WORKSPACE_ROOT, 'apps', 'gemma-agent', 'backend'), 
      frontend_path: path.join(WORKSPACE_ROOT, 'apps', 'gemma-agent', 'frontend'), 
      backend_port: 5002, 
      frontend_port: 3004 
    },
    { 
      name: 'Llama Reasoning Agent', 
      model_type: 'llama', 
      backend_path: path.join(WORKSPACE_ROOT, 'apps', 'llama-agent', 'backend'), 
      frontend_path: path.join(WORKSPACE_ROOT, 'apps', 'llama-agent', 'frontend'), 
      backend_port: 5003, 
      frontend_port: 3003 
    },
    { 
      name: 'LocalAgent Studio', 
      model_type: 'llama', 
      backend_path: WORKSPACE_ROOT, 
      frontend_path: WORKSPACE_ROOT, 
      backend_port: 3002, 
      frontend_port: 5173 
    }
  ];
}

/* ------------------------- File-store fallback ------------------------- */

async function loadFileStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    fileData = JSON.parse(await fs.readFile(FILE_STORE_PATH, 'utf-8'));
  } catch {
    fileData = { applications: [] };
  }
  if (!Array.isArray(fileData.applications)) fileData.applications = [];
}

async function persistFileStore() {
  try {
    await fs.writeFile(FILE_STORE_PATH, JSON.stringify(fileData, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Orchestrator] Failed to persist file store:', e.message);
  }
}

/* Synchronize the built-in app definitions with the current local layout.
   This also repairs older installs that still have the old Gemma port 3002. */
async function syncSeedApps() {
  const seeds = seedApps();
  const byName = new Map(seeds.map(a => [a.name, a]));
  const pool = db.getPool();
  if (mode === 'mysql' && pool) {
    for (const a of seeds) {
      await pool.query(
        `UPDATE ${ORCH_DB}.${TABLE} SET model_type = ?, backend_path = ?, frontend_path = ?, backend_port = ?, frontend_port = ? WHERE name = ?`,
        [a.model_type, a.backend_path, a.frontend_path, a.backend_port, a.frontend_port, a.name]
      );
    }
    return;
  }
  let changed = false;
  for (const row of fileData.applications) {
    const seed = byName.get(row.name);
    if (!seed) continue;
    for (const key of ['model_type','backend_path','frontend_path','backend_port','frontend_port']) {
      if (row[key] !== seed[key]) { row[key] = seed[key]; changed = true; }
    }
  }
  if (changed) await persistFileStore();
}

/* -------------------------------- Init -------------------------------- */

/** Boots the orchestrator store; never throws (falls back to file store). */
export async function init() {
  const pool = db.getPool();
  if (pool) {
    try {
      const bootstrap = await mysql.createConnection({
        host: process.env.MYSQL_HOST || '127.0.0.1',
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || ''
      });
      await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${ORCH_DB}\``);
      await bootstrap.end();

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${ORCH_DB}.${TABLE} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          model_type ENUM('gemma', 'llama', 'deepseek') NOT NULL DEFAULT 'llama',
          backend_path VARCHAR(500) NOT NULL,
          frontend_path VARCHAR(500) NOT NULL,
          backend_port INT NOT NULL,
          frontend_port INT NOT NULL,
          backend_status ENUM('STOPPED', 'RUNNING', 'ERROR') DEFAULT 'STOPPED',
          frontend_status ENUM('STOPPED', 'RUNNING', 'ERROR') DEFAULT 'STOPPED',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${ORCH_DB}.${TABLE}`);
      if (rows[0].n === 0) {
        for (const a of seedApps()) {
          await pool.query(
            `INSERT INTO ${ORCH_DB}.${TABLE} (name, model_type, backend_path, frontend_path, backend_port, frontend_port) VALUES (?, ?, ?, ?, ?, ?)`,
            [a.name, a.model_type, a.backend_path, a.frontend_path, a.backend_port, a.frontend_port]
          );
        }
      }
      mode = 'mysql';
      await syncSeedApps();
      console.log('[Orchestrator] MySQL store ready — ai_orchestrator.applications.');
      return;
    } catch (e) {
      console.log(`[Orchestrator] MySQL unavailable (${e.code || e.message}) — falling back to file store.`);
    }
  }
  mode = 'file';
  await loadFileStore();
  if (fileData.applications.length === 0) {
    fileData.applications = seedApps().map((a, i) => ({
      id: i + 1,
      ...a,
      backend_status: 'STOPPED',
      frontend_status: 'STOPPED',
      created_at: new Date().toISOString()
    }));
    await persistFileStore();
  }
  await syncSeedApps();
  console.log(`[Orchestrator] File store ready at ${FILE_STORE_PATH}`);
}

/* ------------------------------ Data API ------------------------------ */

export async function listApplications() {
  const pool = db.getPool();
  if (mode === 'mysql' && pool) {
    const [rows] = await pool.query(`SELECT * FROM ${ORCH_DB}.${TABLE} ORDER BY id`);
    return rows;
  }
  return [...fileData.applications];
}

export async function getApplication(id) {
  const apps = await listApplications();
  return apps.find(a => a.id === id) || null;
}

/** column must be one of the two status columns (whitelisted). */
export async function updateStatus(id, column, value) {
  if (!['backend_status', 'frontend_status'].includes(column)) {
    throw new Error(`Invalid status column: ${column}`);
  }
  if (!['STOPPED', 'RUNNING', 'ERROR'].includes(value)) {
    throw new Error(`Invalid status value: ${value}`);
  }
  const pool = db.getPool();
  if (mode === 'mysql' && pool) {
    await pool.query(`UPDATE ${ORCH_DB}.${TABLE} SET ${column} = ? WHERE id = ?`, [value, id]);
    return;
  }
  const app = fileData.applications.find(a => a.id === id);
  if (app) {
    app[column] = value;
    await persistFileStore();
  }
}