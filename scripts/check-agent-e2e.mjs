#!/usr/bin/env node
/**
 * End-to-end agent check over real HTTP against the local Ollama runtime.
 *
 *   node scripts/check-agent-e2e.mjs
 *
 * 1. screenshot upload  -> vision model analysis -> coding agent reply
 * 2. video uploaded as application/octet-stream, with no FFmpeg installed
 *    -> media-kind correction + metadata fallback -> agent still finishes
 *
 * It serves server/routes.js on an ephemeral port so the backend already
 * running on :3002 is left untouched. Model work is real, so expect minutes.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
// Bound the coding loop so a chatty model cannot drag the check out forever.
process.env.AGENT_MAX_TOOL_STEPS = process.env.AGENT_MAX_TOOL_STEPS || '2';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypisom'),
  Buffer.alloc(4096, 7)
]);

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const db = await import('../server/db.js');
await db.init();

const app = express();
app.use(express.json({ limit: '10mb' }));
const { default: agentRouter } = await import('../server/routes.js');
app.use('/api/agent', agentRouter);
const listener = await new Promise(resolve => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${listener.address().port}`;

async function upload(sessionId, fileName, mime, bytes) {
  const res = await fetch(`${BASE}/api/agent/upload?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': mime, 'X-Filename': encodeURIComponent(fileName), 'X-Mime-Type': mime },
    body: bytes
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new Error(data.error || `upload failed (HTTP ${res.status})`);
  return data.attachment;
}

async function chatStream(payload) {
  const res = await fetch(`${BASE}/api/agent/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  const events = text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return {
    steps: events.filter(e => e.type === 'step'),
    final: events.find(e => e.type === 'final') || null,
    error: events.find(e => e.type === 'error') || null
  };
}

async function historyMessages(sessionId) {
  const res = await fetch(`${BASE}/api/agent/history/${encodeURIComponent(sessionId)}`);
  const data = await res.json().catch(() => ({}));
  return data.messages || [];
}

function makeWorkspace(tag) {
  const dir = path.join(ROOT, '.data', `e2e-${tag}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>\n<html><body><h1>demo</h1></body></html>\n');
  fs.writeFileSync(path.join(dir, 'README.md'), `# demo workspace for ${tag}\n`);
  return dir;
}

// --------------------------------------------------------------------------
console.log('\n[scenario 1] screenshot -> vision model -> coding agent');
{
  const session = `e2e-vision-${Date.now()}`;
  const workspace = makeWorkspace('vision');
  const started = Date.now();
  const attachment = await upload(session, 'screenshot.png', 'image/png', PNG_1PX);
  assert(attachment.kind === 'image', `upload classifies PNG as image (got ${attachment.kind})`);

  const run = await chatStream({
    sessionId: session,
    message: 'Look at the attached screenshot. Reply with exactly one short sentence about what it shows.',
    model: 'auto',
    workspacePath: workspace,
    attachments: [attachment]
  });
  const elapsed = Date.now() - started;
  assert(!run.error, `stream completed without error (got ${run.error?.error || 'none'})`);
  assert(run.final?.success === true, `agent turn succeeded (final: ${JSON.stringify(run.final?.error || '').slice(0, 200)})`);
  assert(String(run.final?.reply || '').trim().length > 0, `agent replied (${elapsed} ms)`);
  const messages = await historyMessages(session);
  const visualRow = messages.find(m => String(m.tool_call_json || '').includes('local_visual_analysis'));
  assert(!!visualRow, 'vision analysis row persisted (local_visual_analysis)');
  const steps = run.steps.map(s => `${s.label}:${s.detail}:${s.status}`).join(' | ');
  assert(/visual analysis completed/.test(steps), `timeline shows vision analysis (${steps.slice(0, 220)})`);
  console.log(`  info elapsed=${elapsed} ms modelUsed=${run.final?.modelUsed || 'n/a'}`);
  fs.rmSync(workspace, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
console.log('\n[scenario 2] octet-stream video, no FFmpeg -> metadata fallback');
{
  const session = `e2e-video-${Date.now()}`;
  const workspace = makeWorkspace('video');
  const started = Date.now();
  const attachment = await upload(session, 'bug-replay.mp4', 'application/octet-stream', FAKE_MP4);
  assert(attachment.kind === 'file', `browser reported generic kind (got ${attachment.kind}) — agent must correct it`);

  const run = await chatStream({
    sessionId: session,
    message: 'I attached a screen recording. Confirm you received it and tell me what you can read from it.',
    model: 'auto',
    workspacePath: workspace,
    attachments: [attachment]
  });
  const elapsed = Date.now() - started;
  assert(!run.error, `stream completed without error (got ${run.error?.error || 'none'})`);
  assert(run.final?.success === true, `agent turn succeeded (final: ${JSON.stringify(run.final?.error || '').slice(0, 200)})`);
  assert(String(run.final?.reply || '').trim().length > 0, `agent replied (${elapsed} ms)`);

  const messages = await historyMessages(session);
  const userRow = messages.find(m => m.role === 'user');
  // File store keeps attachments_json as an array; MySQL keeps it as a JSON string.
  const rawStored = userRow?.attachments_json;
  const storedList = Array.isArray(rawStored) ? rawStored : JSON.parse(rawStored || '[]');
  const storedKind = storedList[0]?.kind;
  assert(storedKind === 'video', `stored attachment kind corrected from 'file' to video (got ${storedKind})`);
  const fallbackRow = messages.find(m => String(m.tool_call_json || '').includes('local_media_metadata_fallback'));
  assert(!!fallbackRow, 'metadata fallback row persisted (local_media_metadata_fallback)');
  assert(/FFmpeg/.test(String(fallbackRow?.content || '')), 'fallback note explains FFmpeg is missing');
  const failedWithoutFFmpeg = /requires FFmpeg|Video analysis requires/i.test(String(run.final?.error || ''));
  assert(!failedWithoutFFmpeg, 'task did not abort because FFmpeg is missing');
  console.log(`  info elapsed=${elapsed} ms modelUsed=${run.final?.modelUsed || 'n/a'}`);
  fs.rmSync(workspace, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
console.log('\n[scenario 3] absolute path typed in the message (no upload) -> URL extraction');
{
  const session = `e2e-msgpath-${Date.now()}`;
  const workspace = makeWorkspace('msgpath');
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-msgpath-'));
  const shot = path.join(mediaDir, 'screenshot-with-url.png');
  const TARGET_URL = 'https://example.com/demo-path';
  // Colons need double escaping inside -vf, so the drawn text stays colon-free
  // and renders on any FFmpeg build.
  const DRAWN_TEXT = 'www.example.com/demo-path';
  // Render a screenshot that really contains a URL, so the assertion is on OCR.
  const draw = (extra) => spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=760x140',
    '-vf', `drawtext=${extra}text=${DRAWN_TEXT}:fontcolor=black:fontsize=34:x=20:y=50`,
    '-frames:v', '1', '-y', shot
  ], { encoding: 'utf8', timeout: 60000 });
  // Windows ships fonts, so give drawtext an explicit fontfile first and fall
  // back to the platform default when that is unavailable.
  let drawn = draw("fontfile='C\\:/Windows/Fonts/arial.ttf':");
  if (drawn.status !== 0) drawn = draw('');
  if (drawn.status !== 0 || !fs.existsSync(shot)) {
    console.log('skip scenario 3: ffmpeg drawtext could not render a URL fixture');
  } else {
    const started = Date.now();
    const run = await chatStream({
      sessionId: session,
      message: `Image test:${shot}\nRead the attached image with Qwen3-VL.\nExtract the exact URL visible in the image.\nPrint ONLY the URL.\nDo not describe the image.\nDo not guess.`,
      model: 'auto',
      workspacePath: workspace,
      attachments: []
    });
    const elapsed = Date.now() - started;
    const steps = run.steps.map(s => `${s.label}:${s.detail}:${s.status}`).join(' | ');
    assert(!run.error, `stream completed without error (got ${run.error?.error || 'none'})`);
    assert(run.final?.success === true, `agent turn succeeded (${JSON.stringify(run.final?.error || '').slice(0, 200)})`);
    assert(/opened from message path/.test(steps), `message path became an attachment (${steps.slice(0, 240)})`);
    assert(/\bvl\b/i.test(String(run.final?.modelUsed || '')), `vision model answered (got ${run.final?.modelUsed})`);
    const reply = String(run.final?.reply || '').trim();
    assert(reply.includes('example.com/demo-path'), `reply carries the rendered URL (${elapsed} ms) — got: ${JSON.stringify(reply.slice(0, 200))}`);
    assert(!/^---/m.test(reply), 'read-only reply has no frame/image banner');
    console.log(`  info elapsed=${elapsed} ms reply=${JSON.stringify(reply.slice(0, 160))}`);
  }
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
console.log('\n[scenario 4] absolute video path in the message -> frames -> URL + timestamp');
{
  const session = `e2e-msgvideo-${Date.now()}`;
  const workspace = makeWorkspace('msgvideo');
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-msgvideo-'));
  const clip = path.join(mediaDir, 'clip-with-url.mp4');
  const TARGET_URL = 'https://example.com/demo-path';
  const DRAWN_TEXT = 'www.example.com/demo-path';
  const draw = (extra) => spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x240:d=2',
    '-vf', `drawtext=${extra}text=${DRAWN_TEXT}:fontcolor=white:fontsize=32:x=20:y=100`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', clip
  ], { encoding: 'utf8', timeout: 60000 });
  let drawn = draw("fontfile='C\\:/Windows/Fonts/arial.ttf':");
  if (drawn.status !== 0) drawn = draw('');
  if (drawn.status !== 0 || !fs.existsSync(clip)) {
    console.log('skip scenario 4: ffmpeg drawtext could not render a URL fixture');
  } else {
    const started = Date.now();
    const run = await chatStream({
      sessionId: session,
      message: `Video test:${clip}\nRead the attached video with Qwen3-VL.\nInspect all extracted video frames.\nFind the URL visible on screen.\nPrint the exact URL and the timestamp where it appears.\nDo not guess or modify the URL.\nIf no URL is readable, say: NO READABLE URL FOUND.`,
      model: 'auto',
      workspacePath: workspace,
      attachments: []
    });
    const elapsed = Date.now() - started;
    const steps = run.steps.map(s => `${s.label}:${s.detail}:${s.status}`).join(' | ');
    assert(!run.error, `stream completed without error (got ${run.error?.error || 'none'})`);
    assert(run.final?.success === true, `agent turn succeeded (${JSON.stringify(run.final?.error || '').slice(0, 200)})`);
    assert(/opened from message path/.test(steps), `message path became an attachment (${steps.slice(0, 240)})`);
    const reply = String(run.final?.reply || '').trim();
    assert(reply.includes('example.com/demo-path'), `reply carries the rendered URL (${elapsed} ms) — got: ${JSON.stringify(reply.slice(0, 240))}`);
    assert(!/--- FRAME/i.test(reply), 'video answer is merged, not a raw FRAME stack');
    assert(/\d/.test(reply.replace(/example\.com\/demo-path/g, '')), `reply mentions a timestamp (${elapsed} ms)`);
    console.log(`  info elapsed=${elapsed} ms reply=${JSON.stringify(reply.slice(0, 200))}`);
  }
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}

listener.close();
console.log(failures ? `\nFAILED: ${failures} assertion(s)` : '\nEnd-to-end agent checks passed.');
process.exit(failures ? 1 : 0);
