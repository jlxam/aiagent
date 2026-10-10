// Persistent storage for AgentStudio.
// MySQL is the primary store. A JSON fallback is kept for development/offline use.
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.data');
const FILE_STORE_PATH = path.join(DATA_DIR, 'ai_studio_db.json');

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'ai_studio_db',
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 12),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

let pool = null;
let mode = 'connecting';
let fileData = null;

export function getMode() { return mode; }
export function getPool() { return pool; }

async function addColumnIfMissing(table, column, definition) {
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    );
    if (!rows[0]?.n) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
  } catch (e) {
    // A concurrent startup can race the migration. Re-checking the schema is safer than failing startup.
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    ).catch(() => [[{ n: 0 }]]);
    if (!rows[0]?.n) throw e;
  }
}

async function initMysql() {
  const bootstrap = await mysql.createConnection({ host: DB_CONFIG.host, user: DB_CONFIG.user, password: DB_CONFIG.password });
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`ai_studio_db\``);
  await bootstrap.end();

  pool = mysql.createPool(DB_CONFIG);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(64) UNIQUE NOT NULL,
      title VARCHAR(255) NULL,
      workspace_path TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_sessions_updated (updated_at)
    ) ENGINE=InnoDB
  `);
  await addColumnIfMissing('chat_sessions', 'title', 'title VARCHAR(255) NULL');
  await addColumnIfMissing('chat_sessions', 'workspace_path', 'workspace_path TEXT NULL');
  await addColumnIfMissing('chat_sessions', 'updated_at', 'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      task_id VARCHAR(96) NULL,
      role ENUM('user', 'assistant', 'tool') NOT NULL,
      content MEDIUMTEXT,
      attachments_json JSON NULL,
      tool_call_json JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_messages_session_id_id (session_id, id),
      INDEX idx_messages_task (task_id),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await addColumnIfMissing('agent_messages', 'task_id', 'task_id VARCHAR(96) NULL');
  await addColumnIfMissing('agent_messages', 'attachments_json', 'attachments_json JSON NULL');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS execution_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      task_id VARCHAR(96) NULL,
      language VARCHAR(20) NOT NULL,
      code MEDIUMTEXT NOT NULL,
      stdout MEDIUMTEXT,
      stderr MEDIUMTEXT,
      status ENUM('success', 'error') NOT NULL,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_execution_session (session_id, id),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await addColumnIfMissing('execution_logs', 'task_id', 'task_id VARCHAR(96) NULL');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id VARCHAR(96) PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      prompt TEXT NOT NULL,
      model VARCHAR(128) NULL,
      workspace_path TEXT NULL,
      attachments_json JSON NULL,
      position INT NOT NULL DEFAULT 0,
      status ENUM('queued','uploading','running','done','error') NOT NULL DEFAULT 'queued',
      error_text TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      started_at TIMESTAMP NULL,
      completed_at TIMESTAMP NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tasks_session_position (session_id, position, id),
      INDEX idx_tasks_session_updated (session_id, updated_at),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  mode = 'mysql';
  console.log('[DB] MySQL connected — ai_studio_db ready with persistent sessions/tasks.');
}

async function loadFileStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { fileData = JSON.parse(await fs.readFile(FILE_STORE_PATH, 'utf-8')); }
  catch { fileData = { chat_sessions: [], agent_messages: [], execution_logs: [], agent_tasks: [] }; }
  fileData.chat_sessions ||= [];
  fileData.agent_messages ||= [];
  fileData.execution_logs ||= [];
  fileData.agent_tasks ||= [];
}

let persistTimer = null;
let persistPending = false;
async function persistFileStore(immediate = false) {
  persistPending = true;
  if (!immediate) {
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; void persistFileStore(true); }, 250);
    return;
  }
  if (!persistPending) return;
  persistPending = false;
  try {
    await fs.writeFile(FILE_STORE_PATH, JSON.stringify(fileData, null, 2), 'utf-8');
  } catch (e) { console.error('[DB] Failed to persist file store:', e.message); }
}

export async function init() {
  try { await initMysql(); }
  catch (e) {
    mode = 'file';
    await loadFileStore();
    console.log(`[DB] MySQL unavailable (${e.code || e.message}) — using file store at ${FILE_STORE_PATH}`);
  }
}

function truncateTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? clean.slice(0, 77) + '…' : clean || 'New session';
}

export async function ensureSession(sessionId, meta = {}) {
  if (mode === 'mysql') {
    await pool.query(
      `INSERT INTO chat_sessions (session_id, title, workspace_path) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE workspace_path=COALESCE(VALUES(workspace_path), workspace_path)`,
      [sessionId, meta.title ? truncateTitle(meta.title) : null, meta.workspacePath || null]
    );
    return;
  }
  const existing = fileData.chat_sessions.find(s => s.session_id === sessionId);
  if (!existing) fileData.chat_sessions.push({ session_id: sessionId, title: truncateTitle(meta.title), workspace_path: meta.workspacePath || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  else if (meta.workspacePath) existing.workspace_path = meta.workspacePath;
  await persistFileStore();
}

export async function updateSession(sessionId, patch = {}) {
  if (mode === 'mysql') {
    const fields = [], values = [];
    if (patch.title !== undefined) { fields.push('title=?'); values.push(truncateTitle(patch.title)); }
    if (patch.workspacePath !== undefined) { fields.push('workspace_path=?'); values.push(patch.workspacePath || null); }
    if (!fields.length) return;
    values.push(sessionId);
    await pool.query(`UPDATE chat_sessions SET ${fields.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE session_id=?`, values);
    return;
  }
  const s = fileData.chat_sessions.find(x => x.session_id === sessionId);
  if (!s) return;
  if (patch.title !== undefined) s.title = truncateTitle(patch.title);
  if (patch.workspacePath !== undefined) s.workspace_path = patch.workspacePath || null;
  s.updated_at = new Date().toISOString();
  await persistFileStore();
}

export async function insertMessage({ sessionId, role, content, toolCallJson = null, taskId = null, attachments = null }) {
  // Idempotency guard: the same task can be processed concurrently (a second
  // open tab restores in-flight tasks as "queued" after session recovery) and
  // both the stream handler and the complete endpoint persist the final reply.
  // Exact repeats for one task are dropped so history never shows duplicates.
  const isRepeatable = Boolean(taskId) && (role === 'assistant' || role === 'tool');
  if (mode === 'mysql') {
    if (isRepeatable) {
      await pool.query(
        'INSERT INTO agent_messages (session_id, task_id, role, content, attachments_json, tool_call_json) SELECT ?, ?, ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM agent_messages WHERE task_id=? AND role=? AND content <=> ?)',
        [sessionId, taskId, role, content ?? null, attachments ? JSON.stringify(attachments) : null, toolCallJson, taskId, role, content ?? null]
      );
      await pool.query('UPDATE chat_sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?', [sessionId]);
      return;
    }
    await pool.query(
      'INSERT INTO agent_messages (session_id, task_id, role, content, attachments_json, tool_call_json) VALUES (?, ?, ?, ?, ?, ?)',
      [sessionId, taskId, role, content ?? null, attachments ? JSON.stringify(attachments) : null, toolCallJson]
    );
    await pool.query('UPDATE chat_sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?', [sessionId]);
    return;
  }
  if (isRepeatable && fileData.agent_messages.some(m => m.task_id === taskId && m.role === role && m.content === (content ?? null))) return;
  fileData.agent_messages.push({ id: fileData.agent_messages.length + 1, session_id: sessionId, task_id: taskId, role, content: content ?? null, attachments_json: attachments || null, tool_call_json: toolCallJson, created_at: new Date().toISOString() });
  const s = fileData.chat_sessions.find(x => x.session_id === sessionId);
  if (s) s.updated_at = new Date().toISOString();
  await persistFileStore();
}

export async function insertExecution({ sessionId, language, code, stdout, stderr, status, taskId = null }) {
  if (mode === 'mysql') {
    await pool.query('INSERT INTO execution_logs (session_id, task_id, language, code, stdout, stderr, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [sessionId, taskId, language, code, stdout ?? null, stderr ?? null, status]);
    return;
  }
  fileData.execution_logs.push({ id: fileData.execution_logs.length + 1, session_id: sessionId, task_id: taskId, language, code, stdout: stdout ?? null, stderr: stderr ?? null, status, executed_at: new Date().toISOString() });
  await persistFileStore();
}

export async function createTask({ id, sessionId, prompt, model, workspacePath, attachments = [], position = 0 }) {
  await ensureSession(sessionId, { title: prompt, workspacePath });
  if (mode === 'mysql') {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('INSERT INTO agent_tasks (id, session_id, prompt, model, workspace_path, attachments_json, position, status) VALUES (?, ?, ?, ?, ?, ?, ?, \'queued\')', [id, sessionId, prompt, model || null, workspacePath || null, JSON.stringify(attachments || []), position]);
      await conn.query('INSERT INTO agent_messages (session_id, task_id, role, content, attachments_json) VALUES (?, ?, \'user\', ?, ?)', [sessionId, id, prompt, JSON.stringify(attachments || [])]);
      await conn.query('UPDATE chat_sessions SET title=COALESCE(title, ?), workspace_path=COALESCE(?, workspace_path), updated_at=CURRENT_TIMESTAMP WHERE session_id=?', [truncateTitle(prompt), workspacePath || null, sessionId]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
    return;
  }
  fileData.agent_tasks.push({ id, session_id: sessionId, prompt, model: model || null, workspace_path: workspacePath || null, attachments_json: attachments || [], position, status: 'queued', error_text: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  fileData.agent_messages.push({ id: fileData.agent_messages.length + 1, session_id: sessionId, task_id: id, role: 'user', content: prompt, attachments_json: attachments || [], tool_call_json: null, created_at: new Date().toISOString() });
  const s = fileData.chat_sessions.find(x => x.session_id === sessionId);
  if (s) { if (!s.title) s.title = truncateTitle(prompt); if (workspacePath) s.workspace_path = workspacePath; s.updated_at = new Date().toISOString(); }
  await persistFileStore();
}

export async function updateTask(id, patch = {}) {
  const map = { status: 'status', error: 'error_text', model: 'model', workspacePath: 'workspace_path', attachments: 'attachments_json', position: 'position', startedAt: 'started_at', completedAt: 'completed_at' };
  if (mode === 'mysql') {
    const fields = [], values = [];
    for (const [key, column] of Object.entries(map)) {
      if (patch[key] === undefined) continue;
      fields.push(`${column}=?`);
      values.push(key === 'attachments' ? JSON.stringify(patch[key] || []) : (patch[key] === 'startedAt' || patch[key] === 'completedAt' ? (patch[key] ? new Date(patch[key]) : null) : patch[key]));
    }
    if (!fields.length) return;
    values.push(id);
    await pool.query(`UPDATE agent_tasks SET ${fields.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`, values);
    return;
  }
  const t = fileData.agent_tasks.find(x => x.id === id);
  if (!t) return;
  for (const [key, column] of Object.entries(map)) if (patch[key] !== undefined) t[column] = patch[key];
  t.updated_at = new Date().toISOString();
  await persistFileStore();
}

export async function completeTask(id, reply, sessionId = null) {
  let sid = sessionId;
  if (mode === 'mysql') {
    if (!sid) { const [rows] = await pool.query('SELECT session_id FROM agent_tasks WHERE id=? LIMIT 1', [id]); sid = rows[0]?.session_id; }
    if (sid) await insertMessage({ sessionId: sid, taskId: id, role: 'assistant', content: reply });
    await updateTask(id, { status: 'done', completedAt: new Date().toISOString(), error: null });
    return;
  }
  const task = fileData.agent_tasks.find(x => x.id === id);
  sid = sid || task?.session_id;
  if (sid) await insertMessage({ sessionId: sid, taskId: id, role: 'assistant', content: reply });
  await updateTask(id, { status: 'done', completedAt: new Date().toISOString(), error: null });
}

export async function getTasks(sessionId) {
  if (mode === 'mysql') {
    const [rows] = await pool.query('SELECT * FROM agent_tasks WHERE session_id=? ORDER BY position ASC, created_at ASC', [sessionId]);
    return rows.map(r => ({ ...r, attachments_json: typeof r.attachments_json === 'string' ? JSON.parse(r.attachments_json || '[]') : (r.attachments_json || []) }));
  }
  return fileData.agent_tasks.filter(t => t.session_id === sessionId).sort((a,b) => (a.position-b.position) || String(a.created_at).localeCompare(String(b.created_at)));
}

export async function recoverInterruptedTasks(sessionId) {
  if (mode === 'mysql') {
    await pool.query(`UPDATE agent_tasks SET status='queued', error_text=IFNULL(error_text,'Browser/session restarted before task completed.'), started_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE session_id=? AND status IN ('running','uploading')`, [sessionId]);
    return;
  }
  let changed = false;
  for (const t of fileData.agent_tasks.filter(x => x.session_id === sessionId && ['running','uploading'].includes(x.status))) { t.status='queued'; t.error_text=t.error_text || 'Browser/session restarted before task completed.'; changed=true; }
  if (changed) await persistFileStore();
}

export async function getHistory(sessionId, limit = 12) {
  if (mode === 'mysql') {
    const [rows] = await pool.query('SELECT role, content FROM agent_messages WHERE session_id=? ORDER BY id DESC LIMIT ?', [sessionId, Number(limit)]);
    return rows.reverse();
  }
  return fileData.agent_messages.filter(m => m.session_id === sessionId).slice(-limit).map(({role,content}) => ({role,content}));
}

export async function getDailyStats() {
  if (mode === 'mysql') { const [rows] = await pool.query('SELECT COUNT(*) AS n FROM chat_sessions WHERE created_at >= CURDATE()'); return { sessionsToday: Number(rows[0].n) }; }
  const start = new Date(); start.setHours(0,0,0,0); return { sessionsToday: fileData.chat_sessions.filter(s => new Date(s.created_at) >= start).length };
}

export async function listSessions(limit = 50, search = '') {
  if (mode === 'mysql') {
    const q = `%${String(search || '').trim()}%`;
    const [rows] = await pool.query(`SELECT s.session_id, COALESCE(s.title,'New session') AS title, s.workspace_path, s.created_at, s.updated_at, (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id=s.session_id) AS message_count, (SELECT COUNT(*) FROM agent_tasks t WHERE t.session_id=s.session_id AND t.status IN ('queued','running','uploading')) AS pending_tasks FROM chat_sessions s WHERE (?='' OR s.title LIKE ? OR s.workspace_path LIKE ?) ORDER BY s.updated_at DESC LIMIT ?`, [String(search || '').trim(), q, q, Number(limit)]);
    return rows;
  }
  const needle=String(search||'').toLowerCase().trim();
  return fileData.chat_sessions.filter(s => !needle || `${s.title||''} ${s.workspace_path||''}`.toLowerCase().includes(needle)).sort((a,b)=>String(b.updated_at||b.created_at).localeCompare(String(a.updated_at||a.created_at))).slice(0,limit).map(s=>({ ...s, message_count:fileData.agent_messages.filter(m=>m.session_id===s.session_id).length, pending_tasks:fileData.agent_tasks.filter(t=>t.session_id===s.session_id && ['queued','running','uploading'].includes(t.status)).length }));
}

export async function getSession(sessionId) {
  if (mode === 'mysql') {
    const [sessions] = await pool.query('SELECT * FROM chat_sessions WHERE session_id=?', [sessionId]);
    const [messages] = await pool.query('SELECT * FROM agent_messages WHERE session_id=? ORDER BY id', [sessionId]);
    const [executions] = await pool.query('SELECT * FROM execution_logs WHERE session_id=? ORDER BY id', [sessionId]);
    const tasks = await getTasks(sessionId);
    return { session: sessions[0] || null, messages, executions, tasks };
  }
  return { session: fileData.chat_sessions.find(s=>s.session_id===sessionId)||null, messages:fileData.agent_messages.filter(m=>m.session_id===sessionId), executions:fileData.execution_logs.filter(e=>e.session_id===sessionId), tasks:await getTasks(sessionId) };
}
