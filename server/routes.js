// Express router exposing the agent chat endpoint to the React frontend.
import { Router, raw } from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { runAgentLoop } from './agentService.js';
import { getSession, getMode, getDailyStats, createTask, updateTask, completeTask, listSessions, recoverInterruptedTasks } from './db.js';

const router = Router();

// Ollama can stall for minutes while loading a 9 B model on a 16 GB box. The
// UI polls these endpoints, so they must fail fast instead of hanging the
// sidebar's engine status.
const ollamaSignal = () => (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined);

// Ollama lists one entry per tag, so the same model name can appear more than
// once. Consumers key by name (the UI renders <option key={name}>), so the
// duplicates have to be collapsed before the list leaves the API.
const uniqueModelNames = data => [...new Set((Array.isArray(data?.models) ? data.models : []).map(m => m?.name).filter(Boolean))];

router.get('/media/diagnostics', async (_req, res) => {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);
    const command = async name => {
      try {
        const r = await run(process.platform === 'win32' ? 'where.exe' : 'which', [name], { timeout: 5000, maxBuffer: 64 * 1024 });
        return { available: true, path: String(r.stdout || '').trim().split(/\r?\n/)[0] || name };
      } catch (error) {
        return { available: false, error: error?.message || String(error) };
      }
    };
    const [ffmpeg, ffprobe] = await Promise.all([command('ffmpeg'), command('ffprobe')]);
    const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const tags = await fetch(`${base}/api/tags`, { signal: ollamaSignal() });
    const data = await tags.json().catch(() => ({}));
    const models = uniqueModelNames(data);
    res.json({ success: true, provider: 'ollama-local', ffmpeg, ffprobe, models, visionModels: models.filter(name => /(vision|vl|llava|moondream|minicpm-v|gemma3)/i.test(name)) });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/health', async (_req, res) => {
  try {
    const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const r = await fetch(`${base}/api/tags`, { signal: ollamaSignal() });
    if (!r.ok) throw new Error(`Ollama responded with status: ${r.status}`);
    const data = await r.json();
    const models = uniqueModelNames(data);
    const modelInfo = {};
    await Promise.all(models.map(async name => {
      try {
        const sr = await fetch(`${base}/api/show`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }), signal: ollamaSignal()
        });
        const sd = await sr.json().catch(() => ({}));
        modelInfo[name] = {
          capabilities: Array.isArray(sd.capabilities) ? sd.capabilities : [],
          parameterSize: sd.details?.parameter_size || null,
          quantization: sd.details?.quantization_level || null,
          family: sd.details?.family || null
        };
      } catch { modelInfo[name] = { capabilities: [], parameterSize: null, quantization: null, family: null }; }
    }));
    const visionModels = models.filter(name => /(vision|vl|llava|moondream|minicpm-v|gemma3)/i.test(name));
    const codingModels = models.filter(name => /^qwen3(?::|$)/i.test(name) || /coder/i.test(name));
    res.json({
      success: true,
      service: 'Agent21 local agent API',
      serverTime: new Date().toISOString(),
      provider: 'ollama-local',
      // The sidebar reads `store` to report where history is persisted; without
      // it the UI falls back to "file fallback" even while MySQL is connected.
      store: getMode(),
      models,
      modelInfo,
      routing: {
        text: codingModels.find(m => /^qwen3(?::|$)/i.test(m)) || codingModels[0] || null,
        vision: models.find(m => /^qwen3-vl(?::|$)/i.test(m)) || visionModels[0] || null,
        fallbackVision: models.find(m => /^llama3\.2-vision(?::|$)/i.test(m)) || null
      }
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      provider: 'ollama-local',
      error: `Ollama unreachable: ${error.message}`,
      models: [],
      modelInfo: {},
      routing: { text: null, vision: null, fallbackVision: null }
    });
  }
});

// POST /api/agent/upload — upload one binary attachment without base64/JSON overhead.
// The browser sends the file body directly; the returned id is then attached to a queued task.
router.post('/upload', raw({ type: () => true, limit: '250mb' }), async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId is required.' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!body.length) return res.status(400).json({ success: false, error: 'Uploaded file is empty.' });

    const encodedName = String(req.get('X-Filename') || 'attachment.bin');
    let fileName = encodedName;
    try { fileName = decodeURIComponent(encodedName); } catch {}
    fileName = path.basename(fileName).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180) || 'attachment.bin';
    const mimeType = String(req.get('X-Mime-Type') || req.get('Content-Type') || 'application/octet-stream').split(';')[0].toLowerCase();
    const ext = path.extname(fileName).toLowerCase();
    const kind = mimeType.startsWith('image/') ? 'image'
      : mimeType.startsWith('video/') ? 'video'
      : ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar'].includes(ext) ? 'archive'
      : 'file';

    const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const dir = path.join(process.cwd(), '.data', 'attachments', sessionId);
    await fs.mkdir(dir, { recursive: true });
    const storedName = `${id}-${fileName}`;
    const storedPath = path.join(dir, storedName);
    await fs.writeFile(storedPath, body);

    res.json({
      success: true,
      attachment: { id, name: fileName, mimeType, size: body.length, kind, storedName }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

// POST /api/agent/chat/stream — same agent turn, streamed as NDJSON so the
// UI can show a live Thinking / List / Read / Write / Search / Run timeline.
// Each line is one JSON event:
//   {"type":"step","kind":"thinking|list|read|write|search|run","label":"...","detail":"...","status":"running|done|error"}
//   {"type":"final", ...same fields as /api/agent/chat ...}
//   {"type":"error","error":"..."}
router.post('/chat/stream', async (req, res) => {
  const { sessionId, message, model, workspacePath, attachments = [], taskId } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string' || (message != null && typeof message !== 'string')) {
    return res.status(400).json({ success: false, error: 'sessionId is required.' });
  }
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = obj => {
    try { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); } catch { /* client gone */ }
  };
  // Heartbeats keep proxies/clients from timing out during long model calls.
  const heartbeat = setInterval(() => send({ type: 'ping' }), 5000);
  console.log(`[Agent/stream] ${model || 'default'} | workspace=${workspacePath || '(default)'} | ${String(message || '').slice(0, 140)}`);
  try {
    const result = await runAgentLoop(sessionId, message, model, workspacePath, ev => {
      if (ev && ev.type === 'step') send(ev);
    }, attachments, taskId);
    send({ type: 'final', success: true, ...result });
  } catch (error) {
    if (taskId) await updateTask(taskId, { status: 'error', error: error.message || String(error) }).catch(() => {});
    send({ type: 'error', success: false, error: error.message || String(error) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// POST /api/agent/chat — run one agent turn (tool loop included).
router.post('/chat', async (req, res) => {
  try {
    const { sessionId, message, model, workspacePath, attachments = [], taskId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ success: false, error: 'sessionId is required.' });
    }
    if (message != null && typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'message must be a string when provided.' });
    }
    console.log(`[Agent] ${model || 'default'} | workspace=${workspacePath || '(default)'} | ${String(message || '').slice(0, 140)}`);
    const result = await runAgentLoop(sessionId, message, model, workspacePath, undefined, attachments, taskId);
    res.json({ success: true, ...result });
  } catch (error) {
    if (taskId) await updateTask(taskId, { status: 'error', error: error.message || String(error) }).catch(() => {});
    res.status(500).json({ success: false, error: error.message });
  }
});


// Persist the queue immediately so browser reloads do not erase tasks.
router.post('/tasks', async (req, res) => {
  try {
    const { id, sessionId, prompt, model, workspacePath, attachments = [], position = 0 } = req.body || {};
    if (!id || !sessionId || !prompt) return res.status(400).json({ success: false, error: 'id, sessionId and prompt are required.' });
    await createTask({ id, sessionId, prompt, model, workspacePath, attachments, position });
    res.json({ success: true, id });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});


router.post('/tasks/:taskId/complete', async (req, res) => {
  try { await completeTask(req.params.taskId, String(req.body?.reply || ''), req.body?.sessionId || null); res.json({ success: true }); }
  catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.patch('/tasks/:taskId', async (req, res) => {
  try { await updateTask(req.params.taskId, req.body || {}); res.json({ success: true }); }
  catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/sessions', async (req, res) => {
  try { res.json({ success: true, sessions: await listSessions(Number(req.query.limit || 60), String(req.query.search || '')) }); }
  catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// GET /api/agent/stats — lightweight usage counters for the sidebar.
router.get('/stats', async (req, res) => {
  try {
    res.json({ success: true, ...(await getDailyStats()) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/agent/history/:sessionId — transcript + execution logs.
router.get('/history/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await recoverInterruptedTasks(sessionId);
    const data = await getSession(sessionId);
    res.json({ success: true, store: getMode(), ...data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
