#!/usr/bin/env node
/**
 * Regression checks for the local media pipeline and Ollama timeouts.
 *
 *   node scripts/check-media.mjs
 *
 * Every scenario runs in its own child process so PATH / timeout env vars can
 * differ per case. On Windows the script compiles a tiny fake ffmpeg/ffprobe
 * into %TEMP%\agent-media-stub, which lets it exercise the fps sampling pass,
 * the seek fallback, failure and timeout paths without a real FFmpeg install.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const STUB_DIR = path.join(os.tmpdir(), 'agent-media-stub');
const CMD_DIR = path.join(os.tmpdir(), 'agent-media-cmdstub');
const SYSTEM_DIRS = isWin
  ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')]
  : ['/usr/bin', '/bin'];

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(64)]);
const MP4_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(64, 1)]);
const WEBM_BYTES = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 2)]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 3)]);
const AVI_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('AVI LIST'), Buffer.alloc(32, 4)]);

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

function fixture(sessionId, id, fileName, bytes, kind, mimeType) {
  const dir = path.join(ROOT, '.data', 'attachments', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}-${fileName}`), bytes);
  return { id, name: fileName, kind, mimeType, size: bytes.length };
}

function setPath(mode) {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === 'PATH') delete process.env[key];
  }
  if (mode === 'stub') process.env.PATH = [STUB_DIR, ...SYSTEM_DIRS].join(path.delimiter);
  else if (mode === 'cmd') process.env.PATH = [CMD_DIR, ...SYSTEM_DIRS].join(path.delimiter);
  else process.env.PATH = SYSTEM_DIRS.join(path.delimiter);
  // 'system' and 'cmd' model a machine where PATH is the only place FFmpeg can
  // come from. Turn off the app's install-location probe (WinGet/Scoop/choco/
  // Program Files) so a real local FFmpeg install cannot mask the scenario.
  if (mode !== 'stub') process.env.AGENT_FFMPEG_DISCOVERY = 'off';
}

async function service() {
  return import(pathToFileURL(path.join(ROOT, 'server', 'agentService.js')).href);
}

function startFakeOllama(delayMs) {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'stub', message: { role: 'assistant', content: 'pong' }, done: true }));
    }, delayMs);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const SCENARIOS = {
  // --- timeout configuration ------------------------------------------------
  async timeouts() {
    const svc = await service();
    assert(svc.parseTimeoutMs('300000', 1) === 300000, 'parseTimeoutMs reads 300000');
    assert(svc.parseTimeoutMs('0', 1) === Infinity, 'parseTimeoutMs maps 0 -> no limit (Infinity)');
    assert(svc.parseTimeoutMs('-1', 1) === Infinity, 'parseTimeoutMs maps negative -> no limit');
    assert(svc.parseTimeoutMs('', 42) === 42, 'parseTimeoutMs empty value falls back');
    assert(svc.parseTimeoutMs('abc', 42) === 42, 'parseTimeoutMs non-numeric falls back');
    assert(svc.parseTimeoutMs(undefined, 42) === 42, 'parseTimeoutMs undefined falls back');
    for (const file of ['.env', '.env.example']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const get = key => Number((new RegExp(`^${key}=(.*)$`, 'm').exec(text) || [])[1]);
      assert(get('OLLAMA_TIMEOUT_MS') >= 300000, `${file}: OLLAMA_TIMEOUT_MS >= 300 s`);
      assert(get('OLLAMA_VISION_TIMEOUT_MS') >= 300000, `${file}: OLLAMA_VISION_TIMEOUT_MS >= 300 s`);
      assert(get('AGENT_TOTAL_TIMEOUT_MS') >= 600000, `${file}: AGENT_TOTAL_TIMEOUT_MS >= 600 s`);
    }
  },

  async 'ollama-timeout-fires'() {
    const server = await startFakeOllama(5000);
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const svc = await service();
    const started = Date.now();
    let error = null;
    try {
      await svc.callOllamaChat('stub', [{ role: 'user', content: 'hi' }], [], false, 1500);
    } catch (e) { error = e; }
    const elapsed = Date.now() - started;
    server.close(); server.closeAllConnections?.();
    assert(error?.code === 'OLLAMA_TIMEOUT', `abort raises OLLAMA_TIMEOUT (got ${error?.code || error?.message})`);
    assert(elapsed < 4500, `aborted at ~1.5 s instead of waiting 5 s (elapsed ${elapsed} ms)`);
  },

  async 'ollama-timeout-disabled'() {
    const server = await startFakeOllama(3000);
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const svc = await service();
    const started = Date.now();
    let error = null;
    let data = null;
    try {
      data = await svc.callOllamaChat('stub', [{ role: 'user', content: 'hi' }], [], false, 0);
    } catch (e) { error = e; }
    const elapsed = Date.now() - started;
    server.close(); server.closeAllConnections?.();
    assert(!error, `timeout 0 disables the abort timer (error: ${error?.message || 'none'})`);
    assert(data?.message?.content === 'pong', 'slow response still arrives');
    assert(elapsed >= 2900, `waited the full ${elapsed} ms without being cut off`);
  },

  // --- media sniffing / normalisation --------------------------------------
  async sniff() {
    const svc = await service();
    const sessionId = `media-check-sniff-${Date.now()}`;
    assert(svc.sniffMediaKind(JPEG_BYTES) === 'image', 'JPEG header -> image');
    assert(svc.sniffMediaKind(PNG_1PX) === 'image', 'PNG header -> image');
    assert(svc.sniffMediaKind(WEBP_BYTES) === 'image', 'WEBP header -> image');
    assert(svc.sniffMediaKind(AVI_BYTES) === 'video', 'AVI header -> video');
    assert(svc.sniffMediaKind(MP4_BYTES) === 'video', 'MP4 ftyp -> video');
    assert(svc.sniffMediaKind(WEBM_BYTES) === 'video', 'Matroska/WebM header -> video');
    assert(svc.sniffMediaKind(Buffer.from('just some plain text notes')) === null, 'text file -> not media');

    const video = await svc.normalizeAttachmentKind(sessionId, { ...fixture(sessionId, 'a1', 'recording.mp4', MP4_BYTES, 'file', 'application/octet-stream') });
    assert(video.kind === 'video', `octet-stream .mp4 re-classified as video (got ${video.kind})`);
    const shot = await svc.normalizeAttachmentKind(sessionId, { ...fixture(sessionId, 'a2', 'shot.png', PNG_1PX, 'file', 'text/plain') });
    assert(shot.kind === 'image', `text/plain PNG re-classified as image (got ${shot.kind})`);
    const mislabeled = await svc.normalizeAttachmentKind(sessionId, { ...fixture(sessionId, 'a3', 'clip.mp4', MP4_BYTES, 'image', 'image/png') });
    assert(mislabeled.kind === 'video', `image-declared MP4 corrected to video (got ${mislabeled.kind})`);
    const txt = await svc.normalizeAttachmentKind(sessionId, { ...fixture(sessionId, 'a4', 'notes.txt', Buffer.from('hello world'.repeat(10)), 'file', 'text/plain') });
    assert(txt.kind === 'file', 'plain text stays a file');
    fs.rmSync(path.join(ROOT, '.data', 'attachments', sessionId), { recursive: true, force: true });
  },

  // --- image path with no FFmpeg at all ------------------------------------
  async 'image-no-ffmpeg'() {
    const svc = await service();
    const sessionId = `media-check-image-${Date.now()}`;
    const attachment = fixture(sessionId, 'img1', 'screenshot.png', PNG_1PX, 'image', 'image/png');
    const result = await svc.prepareImageFrames(sessionId, [attachment]);
    assert(result.images.length === 1, `screenshot produces 1 vision input (got ${result.images.length})`);
    assert(result.notes.length === 0, `no fallback notes for a supported image (got ${result.notes.length})`);
    assert(Buffer.from(result.images[0].base64, 'base64').equals(PNG_1PX), 'base64 round-trips to the original PNG');
    fs.rmSync(path.join(ROOT, '.data', 'attachments', sessionId), { recursive: true, force: true });
  },

  // --- video with FFmpeg missing: graceful metadata fallback ---------------
  async 'video-no-ffmpeg'() {
    const svc = await service();
    const sessionId = `media-check-nofm-${Date.now()}`;
    const attachment = fixture(sessionId, 'vid1', 'bug.mp4', MP4_BYTES, 'file', 'application/octet-stream');
    let error = null;
    let result = null;
    try {
      result = await svc.prepareImageFrames(sessionId, [attachment]);
    } catch (e) { error = e; }
    assert(!error, `prepareImageFrames must not throw without FFmpeg (got ${error?.message})`);
    assert(result && result.images.length === 0, 'no frames produced');
    assert(result?.notes?.length === 1, `one fallback note produced (got ${result?.notes?.length})`);
    assert(/FFmpeg is not installed/.test(result?.notes?.[0] || ''), 'note explains FFmpeg is missing');
    assert(/bytes/.test(result?.notes?.[0] || ''), 'note carries file metadata');
    fs.rmSync(path.join(ROOT, '.data', 'attachments', sessionId), { recursive: true, force: true });
  },

  // --- fps sampling pass (stub ffmpeg) -------------------------------------
  async 'extract-fps'() {
    const svc = await service();
    const sessionId = `media-check-fps-${Date.now()}`;
    const logFile = path.join(STUB_DIR, `args-${Date.now()}.log`);
    process.env.STUB_FFMPEG_LOG = logFile;
    const attachment = fixture(sessionId, 'vid1', 'clip.mp4', MP4_BYTES, 'video', 'video/mp4');
    const videoPath = path.join(ROOT, '.data', 'attachments', sessionId, `vid1-clip.mp4`);
    const frameDir = path.join(ROOT, '.data', 'attachments', sessionId, 'vid1-frames');

    const frames = await svc.extractVideoFrames({ videoPath, frameDir, duration: 12.5, maxFrames: 8, intervalSeconds: 3 });
    assert(frames.length > 0, `fps pass produced ${frames.length} frame(s)`);
    const step = Math.round((12.5 / 8) * 10) / 10;
    assert(Math.abs(frames[1].timestamp - step) < 0.001, `frame 2 timestamp = step ${step}s (got ${frames[1].timestamp})`);
    const log = fs.readFileSync(logFile, 'utf8');
    assert(log.includes(`fps=1/${step}`), `uses one-frame-every-${step}s sampling filter`);
    assert(log.includes('-frames:v 8'), 'bounds output with -frames:v 8');
    assert(log.includes('scale=1280'), 'downscales frames to the configured width');
    assert(log.trim().split(/\r?\n/).length === 1, 'single sequential decode (no seek fallback needed)');

    const { images, notes } = await svc.prepareImageFrames(sessionId, [attachment]);
    assert(images.length === 4, `prepareImageFrames exposes the sampled frames (got ${images.length})`);
    assert(notes.length === 0, `no fallback notes on success (got ${notes.length})`);
    fs.rmSync(path.join(ROOT, '.data', 'attachments', sessionId), { recursive: true, force: true });
    fs.rmSync(logFile, { force: true });
  },

  // --- sequential pass fails -> per-timestamp seek fallback ----------------
  async 'extract-seek-fallback'() {
    const svc = await service();
    const sessionId = `media-check-seek-${Date.now()}`;
    const logFile = path.join(STUB_DIR, `args-seek-${Date.now()}.log`);
    process.env.STUB_FFMPEG_LOG = logFile;
    const videoPath = path.join(ROOT, '.data', 'attachments', sessionId, 'vid-clip.mp4');
    const frameDir = path.join(ROOT, '.data', 'attachments', sessionId, 'vid-frames');
    fs.mkdirSync(path.dirname(videoPath), { recursive: true });
    fs.writeFileSync(videoPath, MP4_BYTES);

    const frames = await svc.extractVideoFrames({ videoPath, frameDir, duration: 12.5, maxFrames: 8, intervalSeconds: 3 });
    assert(frames.length === 8, `seek fallback produced 8 frames (got ${frames.length})`);
    const log = fs.readFileSync(logFile, 'utf8');
    assert(log.includes('fps='), 'sequential pass was attempted first');
    assert((log.match(/-ss /g) || []).length === 8, 'fell back to per-timestamp seeks');
    assert(Math.abs(frames[0].timestamp - 0.125) < 0.001, `first seek at 1% of the clip (got ${frames[0].timestamp}s)`);
    fs.rmSync(path.join(ROOT, '.data', 'attachments', sessionId), { recursive: true, force: true });
    fs.rmSync(logFile, { force: true });
  },

  // --- FFmpeg failure -> typed error + metadata note -----------------------
  async 'extract-fail'() {
    const svc = await service();
    const sessionId = `media-check-fail-${Date.now()}`;
    const videoPath = path.join(ROOT, '.data', 'attachments', sessionId, 'vid-clip.mp4');
    const frameDir = path.join(ROOT, '.data', 'attachments', sessionId, 'vid-frames');
    fs.mkdirSync(path.dirname(videoPath), { recursive: true });
    fs.writeFileSync(videoPath, MP4_BYTES);

    let error = null;
    try {
      await svc.extractVideoFrames({ videoPath, frameDir, duration: 12.5, maxFrames: 8, intervalSeconds: 3 });
    } catch (e) { error = e; }
    assert(error?.code === 'FFMPEG_FAILED', `typed FFMPEG_FAILED error (got ${error?.code})`);
    assert(/simulated decoder failure/.test(error?.message || ''), 'stderr tail is surfaced in the message');

    const attachment = fixture(sessionId, 'vid2', 'clip.mp4', MP4_BYTES, 'video', 'video/mp4');
    const { images, notes } = await svc.prepareImageFrames(sessionId, [attachment]);
    assert(images.length === 0, 'no frames after failure');
    assert(notes.length === 1 && /frame extraction failed/.test(notes[0]), 'failure becomes a metadata note, not a crash');
    fs.rmSync(path.join(ROOT, '.data', 'attachments', sessionId), { recursive: true, force: true });
  },

  // --- FFmpeg hang -> bounded by the extraction timeout --------------------
  async 'extract-timeout'() {
    const svc = await service();
    const sessionId = `media-check-timeout-${Date.now()}`;
    const videoPath = path.join(ROOT, '.data', 'attachments', sessionId, 'vid-clip.mp4');
    const frameDir = path.join(ROOT, '.data', 'attachments', sessionId, 'vid-frames');
    fs.mkdirSync(path.dirname(videoPath), { recursive: true });
    fs.writeFileSync(videoPath, MP4_BYTES);

    const started = Date.now();
    let error = null;
    try {
      await svc.extractVideoFrames({ videoPath, frameDir, duration: 12.5, maxFrames: 4, intervalSeconds: 3 });
    } catch (e) { error = e; }
    const elapsed = Date.now() - started;
    assert(error?.code === 'FFMPEG_TIMEOUT', `typed FFMPEG_TIMEOUT error (got ${error?.code})`);
    assert(/timed out after/.test(error?.message || ''), `message states the budget (${error?.message})`);
    assert(elapsed < 30000, `bounded by the configured budgets (elapsed ${elapsed} ms)`);
    fs.rmSync(path.join(ROOT, '.data', 'attachments', sessionId), { recursive: true, force: true });
  },

  // --- absolute paths typed in the user's message become attachments --------
  async 'message-path'() {
    const svc = await service();
    const sessionId = `media-check-path-${Date.now()}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-msgpath-'));
    const imagePath = path.join(tmp, 'refscrsh.png');
    const videoPath = path.join(tmp, 'vid.mp4');
    const spacedPath = path.join(tmp, 'my shots', 'screen 1.png');
    fs.writeFileSync(imagePath, PNG_1PX);
    fs.writeFileSync(videoPath, MP4_BYTES);
    fs.mkdirSync(path.dirname(spacedPath), { recursive: true });
    fs.writeFileSync(spacedPath, PNG_1PX);

    // The exact image query from the acceptance list (Windows path, no upload).
    const imageQuery = `Image test:${imagePath}\nRead the attached image with Qwen3-VL.\nExtract the exact URL visible in the image.\nPrint ONLY the URL.\nDo not describe the image.\nDo not guess.`;
    const foundImage = await svc.collectMessageAttachments(sessionId, imageQuery);
    assert(foundImage.attachments.length === 1, `image path resolves to 1 attachment (got ${foundImage.attachments.length})`);
    assert(foundImage.attachments[0].kind === 'image', `path attachment sniffed as image (got ${foundImage.attachments[0].kind})`);
    assert(foundImage.attachments[0].sourcePath === imagePath, 'attachment keeps the absolute sourcePath');
    assert(foundImage.missing.length === 0, `no missing-path report for an existing file (${foundImage.missing.length})`);

    // The exact video query from the acceptance list.
    const videoQuery = `Video test:${videoPath}\nRead the attached video with Qwen3-VL.\nInspect all extracted video frames.\nFind the URL visible on screen.\nPrint the exact URL and the timestamp where it appears.\nDo not guess or modify the URL.\nIf no URL is readable, say: NO READABLE URL FOUND.`;
    const foundVideo = await svc.collectMessageAttachments(sessionId, videoQuery);
    assert(foundVideo.attachments.length === 1, `video path resolves to 1 attachment (got ${foundVideo.attachments.length})`);
    assert(foundVideo.attachments[0].kind === 'video', `path attachment sniffed as video (got ${foundVideo.attachments[0].kind})`);
    assert(foundVideo.attachments[0].mimeType === 'video/mp4', `mime detected from bytes (got ${foundVideo.attachments[0].mimeType})`);

    // Quoted path with spaces.
    const quoted = await svc.collectMessageAttachments(sessionId, `Read "${spacedPath}" and print the text.`);
    assert(quoted.attachments.length === 1, `quoted path with spaces resolves (got ${quoted.attachments.length})`);
    assert(quoted.attachments[0].name === 'screen 1.png', `basename kept (got ${quoted.attachments[0].name})`);

    // A missing media path is reported, not silently ignored.
    const missing = await svc.collectMessageAttachments(sessionId, `Image test:${path.join(tmp, 'nope.png')}`);
    assert(missing.attachments.length === 0, 'missing file yields no attachment');
    assert(missing.missing.length === 1, `missing media path is reported (${missing.missing.length})`);

    // A URL ending in .png must not be mistaken for a drive-letter path.
    const url = await svc.collectMessageAttachments(sessionId, 'Extract https://example.com/assets/logo.png from the page.');
    assert(url.attachments.length === 0 && url.missing.length === 0, 'URLs are not treated as local paths');

    // The sourcePath attachment feeds the normal vision pipeline directly.
    const prepared = await svc.prepareImageFrames(sessionId, [foundImage.attachments[0]]);
    assert(prepared.images.length === 1, `sourcePath image reaches the vision pipeline (got ${prepared.images.length})`);
    assert(Buffer.from(prepared.images[0].base64, 'base64').equals(PNG_1PX), 'bytes round-trip from the user path');

    fs.rmSync(tmp, { recursive: true, force: true });
  },

  // --- read-only visual classification for the acceptance queries -----------
  async 'visual-readonly'() {
    const svc = await service();
    const imageQuery = 'Image test:D:\\Antony\\Temp\\refscrsh.png\nRead the attached image with Qwen3-VL.\nExtract the exact URL visible in the image.\nPrint ONLY the URL.\nDo not describe the image.\nDo not guess.';
    const videoQuery = 'Video test:D:\\Antony\\Temp\\vid.mp4\nRead the attached video with Qwen3-VL.\nInspect all extracted video frames.\nFind the URL visible on screen.\nPrint the exact URL and the timestamp where it appears.\nDo not guess or modify the URL.\nIf no URL is readable, say: NO READABLE URL FOUND.';
    assert(svc.isVisualReadOnlyRequest(imageQuery) === true, 'image URL extraction is read-only');
    assert(svc.isVisualReadOnlyRequest(videoQuery) === true, 'video URL extraction is read-only');
    assert(svc.isVisualReadOnlyRequest('Read the attached image and print all visible text.') === true, 'plain OCR stays read-only');
    assert(svc.isVisualReadOnlyRequest('Look at this screenshot and fix the login bug.') === false, 'bug fix from screenshot stays a change task');
    assert(svc.isVisualReadOnlyRequest('Read this screenshot, then update the header text.') === false, 'read + edit stays a change task');
    assert(svc.isVisualReadOnlyRequest('Inspect this recording and add the missing button.') === false, 'read + implement stays a change task');
  },

  // --- ffmpeg visible to `where` but not spawnable -> still handled --------
  async 'extract-missing'() {
    const svc = await service();
    const sessionId = `media-check-broken-${Date.now()}`;
    const attachment = fixture(sessionId, 'vid1', 'clip.mp4', MP4_BYTES, 'video', 'video/mp4');
    let error = null;
    let result = null;
    try { result = await svc.prepareImageFrames(sessionId, [attachment]); } catch (e) { error = e; }
    assert(!error, `broken FFmpeg install must not throw (got ${error?.message})`);
    assert(result?.images?.length === 0, 'no frames');
    assert(/FFmpeg is not installed or not found on PATH/.test(result?.notes?.[0] || ''), 'note points at the PATH problem');
    fs.rmSync(path.join(ROOT, '.data', 'attachments', sessionId), { recursive: true, force: true });
  }
};

// --------------------------------------------------------------------------
// Windows-only fake FFmpeg used by the stub scenarios.
const STUB_CS = `using System;
using System.IO;
using System.Threading;
class Stub {
  static byte[] FakeJpeg(int seed) {
    byte[] b = new byte[64];
    b[0]=0xFF; b[1]=0xD8; b[2]=0xFF; b[3]=0xE0;
    for (int i=4;i<b.Length;i++) b[i]=(byte)((i+seed)%251);
    return b;
  }
  static int Main(string[] args) {
    string exe = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]);
    string log = Environment.GetEnvironmentVariable("STUB_FFMPEG_LOG");
    if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, exe + " " + String.Join(" ", args) + Environment.NewLine);
    if (exe == "ffprobe") {
      Console.WriteLine("{\\"streams\\":[{\\"codec_type\\":\\"video\\",\\"codec_name\\":\\"h264\\",\\"width\\":1280,\\"height\\":720,\\"r_frame_rate\\":\\"30/1\\"}],\\"format\\":{\\"duration\\":\\"12.5\\",\\"size\\":\\"1048576\\"}}");
      return 0;
    }
    string allArgs = String.Join(" ", args);
    if (Environment.GetEnvironmentVariable("STUB_FFMPEG_FAIL") == "1") { Console.Error.WriteLine("stub ffmpeg: simulated decoder failure"); return 1; }
    if (Environment.GetEnvironmentVariable("STUB_FFMPEG_FAIL_FPS") == "1" && allArgs.Contains("fps=")) { Console.Error.WriteLine("stub ffmpeg: sequential fps pass failed"); return 1; }
    if (Environment.GetEnvironmentVariable("STUB_FFMPEG_HANG") == "1") { Thread.Sleep(120000); return 0; }
    string outArg = args.Length > 0 ? args[args.Length - 1] : "";
    string dir = Path.GetDirectoryName(outArg);
    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
    if (outArg.Contains("%03d")) {
      string pattern = Path.GetFileName(outArg);
      string prefix = pattern.Substring(0, pattern.IndexOf("%03d"));
      for (int i = 1; i <= 4; i++) File.WriteAllBytes(Path.Combine(dir, prefix + i.ToString("000") + ".jpg"), FakeJpeg(i));
    } else {
      File.WriteAllBytes(outArg, FakeJpeg(1));
    }
    return 0;
  }
}`;

function ensureStub() {
  if (!isWin) return false;
  fs.mkdirSync(STUB_DIR, { recursive: true });
  const cs = path.join(STUB_DIR, 'stub.cs');
  fs.writeFileSync(cs, STUB_CS);
  for (const exe of ['ffmpeg', 'ffprobe']) {
    const out = path.join(STUB_DIR, `${exe}.exe`);
    if (fs.existsSync(out)) continue;
    const res = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Add-Type -OutputType ConsoleApplication -OutputAssembly '${out}' -TypeDefinition (Get-Content '${cs}' -Raw)`
    ], { encoding: 'utf8', timeout: 120000 });
    if (res.status !== 0 || !fs.existsSync(out)) {
      console.error(`  warn could not build the ${exe} stub: ${(res.stderr || '').trim().slice(0, 300)}`);
      return false;
    }
  }
  return true;
}

function ensureCmdStub() {
  if (!isWin) return false;
  fs.mkdirSync(CMD_DIR, { recursive: true });
  for (const name of ['ffmpeg', 'ffprobe']) {
    fs.writeFileSync(path.join(CMD_DIR, `${name}.cmd`), `@echo off\r\nexit /b 1\r\n`);
  }
  return true;
}

async function main() {
  const scenarioIndex = process.argv.indexOf('--scenario');
  if (scenarioIndex !== -1) {
    const name = process.argv[scenarioIndex + 1];
    setPath(process.env.MEDIA_PATH_MODE || 'system');
    try {
      await SCENARIOS[name]();
    } catch (error) {
      failures += 1;
      console.error(`  FAIL scenario threw: ${error?.stack || error}`);
    }
    process.exit(failures ? 1 : 0);
  }

  const stubReady = ensureStub();
  const cmdStubReady = ensureCmdStub();
  const plan = [
    ['timeouts', 'system'],
    ['ollama-timeout-fires', 'system'],
    ['ollama-timeout-disabled', 'system'],
    ['sniff', 'system'],
    ['image-no-ffmpeg', 'system'],
    ['video-no-ffmpeg', 'system'],
    ['extract-fps', 'stub'],
    ['extract-seek-fallback', 'stub'],
    ['extract-fail', 'stub'],
    ['extract-timeout', 'stub'],
    ['extract-missing', 'cmd'],
    ['message-path', 'system'],
    ['visual-readonly', 'system']
  ];

  console.log('Media pipeline + timeout regression checks\n');
  const failed = [];
  for (const [name, mode] of plan) {
    if (mode === 'stub' && !stubReady) { console.log(`skip ${name} (no stub FFmpeg on this platform)`); continue; }
    if (mode === 'cmd' && !cmdStubReady) { console.log(`skip ${name} (no cmd stub on this platform)`); continue; }
    console.log(`\n[${name}]`);
    const env = { ...process.env, MEDIA_PATH_MODE: mode };
    if (name === 'extract-fail') env.STUB_FFMPEG_FAIL = '1';
    if (name === 'extract-seek-fallback') env.STUB_FFMPEG_FAIL_FPS = '1';
    if (name === 'extract-timeout') { env.STUB_FFMPEG_HANG = '1'; env.AGENT_FFMPEG_TIMEOUT_MS = '1500'; env.AGENT_FFMPEG_SEEK_TIMEOUT_MS = '600'; }
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scenario', name], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 180000
    });
    process.stdout.write(res.stdout || '');
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.status !== 0) failed.push(name);
  }

  console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : '\nAll media/timeout checks passed.');
  process.exit(failed.length ? 1 : 0);
}

main();
