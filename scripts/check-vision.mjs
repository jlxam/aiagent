#!/usr/bin/env node
/**
 * Direct local vision smoke test.
 * Usage: node scripts/check-vision.mjs <image-or-video>
 * Uses the same attachment/media pipeline as Agent21, then calls Ollama
 * qwen3-vl:8b (or AGENT_VISION_MODEL) once per image/frame.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/check-vision.mjs <image-or-video>');
  process.exit(2);
}
const absolute = path.resolve(input);
const stat = await fs.stat(absolute).catch(() => null);
if (!stat?.isFile()) {
  console.error(`File not found: ${absolute}`);
  process.exit(2);
}

const svc = await import('../server/agentService.js');
const sessionId = `vision-smoke-${Date.now()}`;
const root = path.join(ROOT, '.data', 'attachments', sessionId);
await fs.mkdir(root, { recursive: true });
const id = 'smoke-attachment';
const name = path.basename(absolute);
const stored = path.join(root, `${id}-${name}`);
await fs.copyFile(absolute, stored);

function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif'
    : ext === '.mp4' ? 'video/mp4' : ext === '.mov' ? 'video/quicktime' : 'application/octet-stream';
}

const attachment = { id, name, mimeType: mimeFor(name), kind: mimeFor(name).startsWith('video/') ? 'video' : mimeFor(name).startsWith('image/') ? 'image' : 'file', size: stat.size };
console.log(`Input: ${absolute}`);
console.log(`Model: ${process.env.AGENT_VISION_MODEL || 'qwen3-vl:8b'}`);

try {
  const normalized = await svc.normalizeAttachmentKind(sessionId, attachment);
  console.log(`Detected: ${normalized.kind} (${normalized.mimeType})`);
  const prepared = await svc.prepareImageFrames(sessionId, [normalized]);
  console.log(`Frames/images prepared: ${prepared.images.length}`);
  if (prepared.notes.length) console.log(`Notes:\n${prepared.notes.join('\n')}`);
  if (!prepared.images.length) throw new Error('No readable image/video frames were produced.');

  const model = process.env.AGENT_VISION_MODEL || 'qwen3-vl:8b';
  const reports = [];
  for (let i = 0; i < prepared.images.length; i++) {
    const item = prepared.images[i];
    const data = await svc.callOllamaChat(model, [{
      role: 'user',
      content: `Analyze this ${normalized.kind === 'video' ? 'video frame' : 'image'} from a software bug report. Read all visible text and UI elements. State only what is visibly supported. Attachment: ${item.attachment.name}`,
      images: [item.base64]
    }], [], false, 600000);
    const text = String(data?.message?.content || '').trim();
    if (!text) throw new Error(`Ollama returned an empty response for ${item.attachment.name}`);
    reports.push(`--- ${item.attachment.name} ---\n${text}`);
  }
  console.log('\nVISION SMOKE TEST: PASS\n');
  console.log(reports.join('\n\n'));
  process.exitCode = 0;
} catch (error) {
  console.error(`\nVISION SMOKE TEST: FAIL\n${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
