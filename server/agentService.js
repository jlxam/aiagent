// LocalAgent orchestration: one shared tool protocol for local Ollama models.
import { exec, execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import os from 'os';
import * as db from './db.js';

// Load local .env before reading provider configuration. ESM imports are evaluated before server.js top-level code.
try {
  const envPath = path.join(process.cwd(), '.env');
  const envText = readFileSync(envPath, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
} catch {}

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.AGENT_MODEL || 'auto';
const MAX_TOOL_STEPS = Number(process.env.AGENT_MAX_TOOL_STEPS || 6);
// Timeouts are milliseconds. A value <= 0 disables the timer entirely, so a
// heavy vision/video call can run as long as the model actually needs.
function parseTimeoutMs(value, fallback) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n <= 0 ? Number.POSITIVE_INFINITY : n;
}

// Model-call budgets are deliberately generous: a CPU-only machine can need
// minutes to answer a prompt that carries decoded video frames.
const MODEL_CALL_TIMEOUT = parseTimeoutMs(process.env.AGENT_MODEL_TIMEOUT_MS, 300_000);
const OLLAMA_TIMEOUT_MS = parseTimeoutMs(process.env.OLLAMA_TIMEOUT_MS, MODEL_CALL_TIMEOUT);
// Vision/video calls get their own, much larger budget — 10 minutes by
// default, far beyond the old 120 s cap. Set OLLAMA_VISION_TIMEOUT_MS=0 to
// remove the limit altogether.
const VISION_TIMEOUT_MS = parseTimeoutMs(process.env.OLLAMA_VISION_TIMEOUT_MS || process.env.AGENT_VISION_TIMEOUT_MS, 600_000);
const AGENT_TOTAL_TIMEOUT_MS = parseTimeoutMs(process.env.AGENT_TOTAL_TIMEOUT_MS, 900_000);
const FALLBACK_MODEL = process.env.AGENT_FALLBACK_MODEL || 'llama3.2:latest';
const TEXT_MODEL = process.env.AGENT_TEXT_MODEL || 'qwen3:8b';
const VISION_MODEL = process.env.AGENT_VISION_MODEL || 'qwen3-vl:8b';
const VISION_FALLBACK_MODEL = process.env.AGENT_VISION_FALLBACK_MODEL || 'llama3.2-vision:latest';
const VISION_FRAME_COUNT = Math.max(4, Math.min(8, Number(process.env.AGENT_VISION_FRAME_COUNT || 8)));
const VISION_MAX_IMAGE_WIDTH = Math.max(640, Math.min(1600, Number(process.env.AGENT_VISION_MAX_IMAGE_WIDTH || 1280)));
// Video decoding budgets: one sequential fps pass first, then fast seeks.
const FFMPEG_FRAME_TIMEOUT_MS = parseTimeoutMs(process.env.AGENT_FFMPEG_TIMEOUT_MS, 90_000);
const FFMPEG_SEEK_TIMEOUT_MS = parseTimeoutMs(process.env.AGENT_FFMPEG_SEEK_TIMEOUT_MS, Math.min(FFMPEG_FRAME_TIMEOUT_MS, 20_000));
// Sampling step used when ffprobe cannot report the clip duration.
const VISION_FRAME_INTERVAL = Math.max(1, Number(process.env.AGENT_VISION_FRAME_INTERVAL || 3));
const ATTACHMENT_ROOT = path.join(process.cwd(), '.data', 'attachments');
const MAX_READ_BYTES = 160_000;
const MAX_OUTPUT = 20_000;

function clip(value, max = MAX_OUTPUT) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) + '\n…[truncated]' : text;
}

function safePath(workspace, relativePath = '.') {
  const target = path.resolve(workspace, relativePath || '.');
  const prefix = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;
  // Windows filesystems are case-insensitive and models often echo paths with
  // different drive/folder casing — compare lowercased on win32 so a casing
  // mismatch does not abort the task as "outside the workspace".
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (fold(target) !== fold(workspace) && !fold(target).startsWith(fold(prefix))) {
    throw new Error(`Path must stay inside the active project workspace (got: ${relativePath})`);
  }
  return target;
}

// ---- File Safety & Sandbox Rule (see "File Safety & Sandbox Rule" in
// agent-system-prompt.md). All agent-generated files must live inside
// <workspace>/.sandbox/ — never in the project root or src/. Writing a NEW
// file into a protected location is redirected to .sandbox/<basename> unless
// the caller declares allowProject (the user explicitly asked to create that
// file in the main project). Editing an already existing file is allowed so
// explicit main-project tasks keep working. Set AGENT_SANDBOX_ENFORCE=off to
// disable the redirect entirely.
const SANDBOX_DIRNAME = '.sandbox';

function sandboxEnforcementEnabled() {
  const raw = String(process.env.AGENT_SANDBOX_ENFORCE ?? '1').trim().toLowerCase();
  return !['0', 'off', 'false', 'no', 'disabled'].includes(raw);
}

function sandboxDir(workspace) {
  return path.join(path.resolve(workspace), SANDBOX_DIRNAME);
}

// Creates the sandbox dir and drops a self-ignoring .gitignore inside it, so
// agent artifacts can never be committed — even in workspaces that have no
// .gitignore of their own (every switched workspace gets its own .sandbox/).
async function ensureSandboxDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  const marker = path.join(dir, '.gitignore');
  const hasMarker = await fs.stat(marker).then((s) => s.isFile()).catch(() => false);
  if (!hasMarker) await fs.writeFile(marker, '*\n', 'utf8').catch(() => {});
  return dir;
}

async function sanitizeFilePath(userPath, workspaceRoot, options = {}) {
  const { allowProject = false } = options;
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, String(userPath || ''));
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rootPrefix = fold(root).endsWith(path.sep) ? fold(root) : fold(root) + path.sep;
  // Outside the workspace: return as-is — safePath() still rejects it.
  if (fold(absolutePath) !== fold(root) && !fold(absolutePath).startsWith(rootPrefix)) return absolutePath;
  if (!sandboxEnforcementEnabled() || allowProject) return absolutePath;
  const rel = path.relative(root, absolutePath);
  if (!rel || rel.startsWith('..')) return absolutePath;
  const segments = rel.split(path.sep);
  // Protected: anything directly in the project root, plus everything under src/.
  const isProtected = segments.length === 1 || segments[0].toLowerCase() === 'src';
  if (!isProtected) return absolutePath;
  // Existing file => explicit edit of a real project file; allow it.
  const exists = await fs.stat(absolutePath).then((s) => s.isFile()).catch(() => false);
  if (exists) return absolutePath;
  const base = path.basename(absolutePath);
  if (!base) return absolutePath;
  return path.join(sandboxDir(root), base);
}

async function listFiles(workspace, relativePath = '.', depth = 2) {
  const root = safePath(workspace, relativePath);
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat) throw new Error(`Path not found: ${relativePath || '.'}`);
  // Models sometimes pass a file path to list_files. fs.readdir(file) throws
  // ENOTDIR/scandir and used to terminate the entire task. Treat a file path
  // as a one-item listing instead so the agent can recover and continue.
  if (rootStat.isFile()) return { files: [relativePath || path.basename(root)] };
  if (!rootStat.isDirectory()) throw new Error(`Path is not a directory: ${relativePath || '.'}`);
  const result = [];
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vite', 'coverage']);
  async function walk(dir, level, prefix) {
    if (level > depth || result.length >= 500) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue;
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      result.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), level + 1, rel);
      if (result.length >= 500) break;
    }
  }
  await walk(root, 0, '');
  return { files: result };
}

async function searchFiles(workspace, query, relativePath = '.') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) throw new Error('A search query is required.');
  const root = safePath(workspace, relativePath);
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat) throw new Error(`Path not found: ${relativePath || '.'}`);
  if (rootStat.isFile()) {
    const name = path.basename(root);
    if (/\.(tsx?|jsx?|json|css|scss|html|md|sql|env)$/i.test(name)) {
      try {
        const text = await fs.readFile(root, 'utf8');
        const index = text.toLowerCase().indexOf(needle);
        return { query, matches: index >= 0 ? [{ path: relativePath || name, line: text.slice(0, index).split(/\r?\n/).length }] : [] };
      } catch {}
    }
    return { query, matches: [] };
  }
  if (!rootStat.isDirectory()) throw new Error(`Path is not a directory: ${relativePath || '.'}`);
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vite', 'coverage']);
  const matches = [];
  async function walk(dir, prefix) {
    if (matches.length >= 80) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue;
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (/\.(tsx?|jsx?|json|css|scss|html|md|sql|env)$/i.test(entry.name)) {
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_READ_BYTES) continue;
          const text = await fs.readFile(full, 'utf8');
          const index = text.toLowerCase().indexOf(needle);
          if (index >= 0) {
            const line = text.slice(0, index).split(/\r?\n/).length;
            matches.push({ path: rel, line });
          }
        } catch {}
      }
      if (matches.length >= 80) return;
    }
  }
  await walk(root, '');
  return { query, matches };
}

async function readFile(workspace, relativePath) {
  if (!relativePath) throw new Error('A file path is required.');
  const full = safePath(workspace, relativePath);
  const stat = await fs.stat(full);
  if (!stat.isFile()) throw new Error(`${relativePath} is not a file.`);
  if (stat.size > MAX_READ_BYTES) throw new Error(`${relativePath} is too large to read (${stat.size} bytes).`);
  return { path: relativePath, content: await fs.readFile(full, 'utf8') };
}

async function writeFile(workspace, relativePath, content, options = {}) {
  if (!relativePath) throw new Error('A file path is required.');
  const sanitized = await sanitizeFilePath(relativePath, workspace, options);
  const full = safePath(workspace, sanitized);
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const redirected = fold(path.resolve(full)) !== fold(path.resolve(workspace, String(relativePath)));
  if (redirected) await ensureSandboxDir(path.dirname(full));
  else await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, String(content), 'utf8');
  const result = {
    path: redirected ? path.relative(workspace, full) : relativePath,
    bytes: Buffer.byteLength(String(content), 'utf8'),
    status: 'success'
  };
  if (redirected) {
    result.sandboxRedirect = true;
    result.note = `File Safety Rule: new files in src/ or the project root are redirected to ${SANDBOX_DIRNAME}/. Wrote to ${result.path} instead of ${relativePath}. Only pass allow_project=true when the user explicitly asked to create this file in the main project.`;
  }
  return result;
}

async function executeCode(workspace, language, code) {
  const lang = String(language || '').toLowerCase();
  const ext = ['python', 'python3', 'py'].includes(lang) ? 'py' : ['javascript', 'js', 'node'].includes(lang) ? 'js' : null;
  if (!ext) return { stdout: '', stderr: `Unsupported language: ${language}`, status: 'error' };
  // Standalone/generated scripts stay inside the sandbox, never in the root.
  const scriptDir = sandboxDir(workspace);
  await ensureSandboxDir(scriptDir);
  const file = path.join(scriptDir, `.localagent-exec-${Date.now()}.${ext}`);
  await fs.writeFile(file, code, 'utf8');
  try {
    const executable = ext === 'py' ? 'python' : 'node';
    const { stdout, stderr } = await execPromise(`"${executable}" "${file}"`, { cwd: workspace, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    return { stdout: clip(stdout), stderr: clip(stderr), status: 'success' };
  } catch (error) {
    return { stdout: clip(error.stdout), stderr: clip(error.stderr || error.message), status: 'error' };
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

async function runCommand(workspace, command) {
  if (!command) throw new Error('A shell command is required.');
  try {
    const { stdout, stderr } = await execPromise(command, { cwd: workspace, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: clip(stdout, 30_000), stderr: clip(stderr, 30_000), status: 'success' };
  } catch (error) {
    return { stdout: clip(error.stdout, 30_000), stderr: clip(error.stderr || error.message, 30_000), status: 'error' };
  }
}

async function inspectProject(workspace) {
  const result = { workspace, files: [], keyFiles: {} };
  result.files = (await listFiles(workspace, '.', 2)).files.slice(0, 220);
  for (const file of ['package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'README.md']) {
    try {
      result.keyFiles[file] = (await readFile(workspace, file)).content.slice(0, 24000);
    } catch {}
  }
  return result;
}


function attachmentRoot(sessionId) {
  const safe = String(sessionId || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return path.join(ATTACHMENT_ROOT, safe);
}

async function resolveAttachment(sessionId, attachment) {
  if (!attachment) throw new Error('Attachment is required.');

  // Absolute file paths the USER typed in their own message (for example
  // D:\Antony\Temp\refscrsh.png) are registered with `sourcePath` and are read
  // in place — no upload copy exists. This is the only way a path outside the
  // session attachment directory is accepted, and `sourcePath` is only ever
  // set from the user's message text, never from model tool arguments.
  const sourcePath = String(attachment.sourcePath || '').trim();
  if (sourcePath) {
    const stat = await fs.stat(sourcePath).catch(() => null);
    if (stat?.isFile()) return sourcePath;
    throw new Error(`Referenced file is no longer available: ${sourcePath}`);
  }

  const dir = attachmentRoot(sessionId);
  const entries = await fs.readdir(dir).catch(() => []);
  const requestedId = String(attachment.id || '').trim();
  const requestedName = path.basename(String(attachment.name || '')).trim().toLowerCase();
  const requestedStored = path.basename(String(attachment.storedName || '')).trim().toLowerCase();

  // Primary contract: the upload id prefixes the stored file.
  let entry = requestedId
    ? entries.find(name => name.startsWith(`${requestedId}-`))
    : null;

  // Recovery for older queued tasks/model tool calls that passed the filename
  // instead of the generated attachment id. This is intentionally limited to
  // the current session's attachment directory.
  if (!entry && (requestedName || requestedStored)) {
    entry = entries.find(name => {
      const lower = name.toLowerCase();
      return (requestedName && lower.endsWith(`-${requestedName}`))
        || (requestedStored && lower === requestedStored);
    });
  }

  // A few local-agent models echo an absolute Windows path from the user's
  // prompt (for example D:\\Antony\\Temp\\screenshot.png) instead of the
  // uploaded id. Only accept it when the basename exactly matches one of the
  // known uploaded attachment names; never let the model use this as an
  // arbitrary filesystem-read primitive.
  if (!entry && requestedId && path.isAbsolute(requestedId) && requestedName) {
    try {
      const localStat = await fs.stat(requestedId);
      if (localStat.isFile() && path.basename(requestedId).toLowerCase() === requestedName) {
        return requestedId;
      }
    } catch {}
  }

  if (!entry) throw new Error(`Attachment not found: ${attachment.name || attachment.id || 'unknown attachment'}`);
  return path.join(dir, entry);
}

// --- user-typed absolute paths -------------------------------------------
// "Image test: D:\Antony\Temp\refscrsh.png" must work without a browser
// upload: any absolute path the user writes in their own message is resolved
// on disk and joined to the turn as an attachment.

const MEDIA_KIND_BY_EXT = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.jfif': 'image', '.gif': 'image',
  '.webp': 'image', '.bmp': 'image', '.tif': 'image', '.tiff': 'image', '.heic': 'image',
  '.avif': 'image',
  '.mp4': 'video', '.m4v': 'video', '.mov': 'video', '.webm': 'video', '.mkv': 'video',
  '.avi': 'video', '.wmv': 'video', '.flv': 'video', '.mpeg': 'video', '.mpg': 'video'
};
const MEDIA_MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.heic': 'image/heic', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg'
};
const ARCHIVE_EXT = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar']);
const MAX_MESSAGE_ATTACHMENT_BYTES = 512 * 1024 * 1024;

function extractFilePathCandidates(message) {
  const text = String(message || '');
  const candidates = new Set();
  // Quoted paths may contain spaces: "D:\My Files\shot.png".
  for (const m of text.matchAll(/["'\x60]([^"'\x60\r\n]+)["'\x60]/g)) candidates.add(m[1]);
  const mediaExt = Object.keys(MEDIA_KIND_BY_EXT).map(ext => ext.slice(1)).join('|');
  // Unquoted Windows path ending in a media extension. The lookbehind keeps
  // URLs (https://…) from being read as a drive-letter path.
  const windowsPath = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^"'\\x60<>|*\\r\\n]*?\\.(?:${mediaExt})(?![A-Za-z0-9_])`, 'gi');
  // Unquoted POSIX absolute path ending in a media extension.
  const posixPath = new RegExp(`(?:^|[\\s(\\[{])((?:/)[^"'\\x60<>|*\\r\\n]*?\\.(?:${mediaExt})(?![A-Za-z0-9_]))`, 'gi');
  for (const m of text.matchAll(windowsPath)) candidates.add(m[0]);
  for (const m of text.matchAll(posixPath)) candidates.add(m[1]);
  return [...candidates];
}

function looksAbsoluteFilePath(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (/^[A-Za-z]:[\\/]/.test(v)) return true; // C:\dir\file
  if (/^\\\\[^\\/]/.test(v)) return true;   // UNC \\server\share
  if (/^\/(?!\/)/.test(v)) return true;      // POSIX absolute
  return false;
}

/**
 * Resolve absolute file paths that appear literally in the user's message.
 * Returns { attachments, missing } where `missing` lists media paths that do
 * not exist (so the turn can say so instead of guessing).
 */
async function collectMessageAttachments(sessionId, message) {
  const attachments = [];
  const missing = [];
  const seen = new Set();

  for (const raw of extractFilePathCandidates(message)) {
    const cleaned = String(raw || '')
      .trim()
      .replace(/^[("'`\[{]+/, '')
      .replace(/[),.;:'"`\]}!]+$/, '');
    if (!looksAbsoluteFilePath(cleaned)) continue;

    let full = '';
    try { full = path.resolve(cleaned); } catch { continue; }
    const key = process.platform === 'win32' ? full.toLowerCase() : full;
    if (seen.has(key)) continue;
    seen.add(key);

    const stat = await fs.stat(full).catch(() => null);
    const ext = path.extname(full).toLowerCase();
    const mediaExtension = Boolean(MEDIA_KIND_BY_EXT[ext]);
    if (!stat?.isFile()) {
      // Only surface missing media paths — that is what the user is asking to
      // read; other path-like strings stay in the message text untouched.
      if (mediaExtension) missing.push(full);
      continue;
    }
    if (stat.size > MAX_MESSAGE_ATTACHMENT_BYTES) {
      if (mediaExtension) missing.push(`${full} (${stat.size} bytes exceeds the ${MAX_MESSAGE_ATTACHMENT_BYTES} byte limit)`);
      continue;
    }

    const head = await readHead(full);
    const sniffed = sniffMediaKind(head);
    const kind = sniffed || MEDIA_KIND_BY_EXT[ext]
      || (ARCHIVE_EXT.has(ext) ? 'archive' : 'file');
    attachments.push({
      id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: path.basename(full),
      storedName: path.basename(full),
      kind,
      mimeType: MEDIA_MIME_BY_EXT[ext] || (kind === 'archive' ? 'application/zip' : 'application/octet-stream'),
      size: stat.size,
      sourcePath: full,
      referencedFrom: 'message'
    });
  }

  return { attachments, missing };
}

function findAttachment(attachments, ref) {
  const value = String(ref ?? '').trim();
  if (!value) return null;
  const lower = path.basename(value).toLowerCase();
  return (attachments || []).find(a =>
    String(a?.id || '').toLowerCase() === value.toLowerCase()
    || String(a?.name || '').toLowerCase() === value.toLowerCase()
    || String(a?.storedName || '').toLowerCase() === value.toLowerCase()
    || path.basename(String(a?.name || '')).toLowerCase() === lower
    || path.basename(String(a?.storedName || '')).toLowerCase() === lower
  ) || null;
}

async function inspectAttachment(sessionId, attachment) {
  const full = await resolveAttachment(sessionId, attachment);
  const stat = await fs.stat(full);
  const mime = String(attachment.mimeType || '').toLowerCase();
  const ext = path.extname(attachment.name || full).toLowerCase();
  const result = {
    id: attachment.id,
    name: attachment.name,
    mimeType: mime,
    size: stat.size,
    kind: attachment.kind,
    path: full
  };

  if (attachment.kind === 'archive' || ['.zip'].includes(ext)) {
    try {
      const py = `import zipfile, json; z=zipfile.ZipFile(r'''${full.replace(/'/g, "''")}'''); print(json.dumps(z.namelist()[:400]))`;
      const { stdout } = await execPromise(`python -c "${py.replace(/"/g, '\\"')}"`, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      result.entries = JSON.parse(stdout.trim() || '[]');
      result.entryCount = result.entries.length;
    } catch (e) {
      result.archiveError = e.message;
    }
  } else if (attachment.kind === 'video' || mime.startsWith('video/')) {
    try {
      const ffprobeBin = await resolveExecutable('ffprobe');
      if (!ffprobeBin) throw new Error('ffprobe unavailable');
      const { stdout } = await execFilePromise(ffprobeBin, ['-v','error','-show_entries','format=duration,size','-show_entries','stream=codec_name,width,height,r_frame_rate','-of','json', full], { timeout: 15000, maxBuffer: 512 * 1024, windowsHide: true });
      result.video = JSON.parse(stdout);
    } catch {
      result.video = { note: 'ffprobe is unavailable; the video file is stored and can still be accessed.' };
    }
  } else if (attachment.kind === 'image' || mime.startsWith('image/')) {
    result.note = 'Image is supplied directly to vision-capable Ollama models.';
  } else {
    result.note = 'Binary/text attachment is stored locally. Use read_attachment for text files.';
  }
  return result;
}


async function extractAttachment(sessionId, attachment, workspace) {
  const full = await resolveAttachment(sessionId, attachment);
  const ext = path.extname(attachment.name || full).toLowerCase();
  if (!(attachment.kind === 'archive' || ext === '.zip')) {
    throw new Error('Only ZIP archives can be extracted automatically.');
  }
  const safeBase = path.basename(attachment.name || 'attachment').replace(/[^\w.-]+/g, '_').replace(/\.zip$/i, '');
  const destination = safePath(workspace, path.join('.agent-imports', `${attachment.id}-${safeBase}`));
  await fs.mkdir(destination, { recursive: true });
  const script = [
    'import os,sys,zipfile',
    'src,dst=sys.argv[1],sys.argv[2]',
    'root=os.path.realpath(dst)',
    'z=zipfile.ZipFile(src)',
    'for n in z.namelist():',
    ' p=os.path.realpath(os.path.join(dst,n))',
    ' if not (p==root or p.startswith(root+os.sep)): raise RuntimeError("Unsafe ZIP path: "+n)',
    'z.extract(n,dst)',
    'print(dst)'
  ].join(';');
  const result = await execFilePromise('python', ['-c', script, full, destination], { timeout: 60_000, maxBuffer: 256 * 1024 });
  return { destination: result.stdout.trim() || destination, status: 'success' };
}

async function readAttachment(sessionId, attachment, innerPath) {
  const full = await resolveAttachment(sessionId, attachment);
  const ext = path.extname(attachment.name || full).toLowerCase();
  if (attachment.kind === 'archive' || ext === '.zip') {
    const safeInner = String(innerPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!safeInner || safeInner.includes('..')) throw new Error('A safe archive entry path is required.');
    const py = [
      'import zipfile,sys',
      `z=zipfile.ZipFile(r'''${full.replace(/'/g, "''")}''')`,
      `p=${JSON.stringify(safeInner)}`,
      'data=z.read(p)',
      'sys.stdout.buffer.write(data[:160000])'
    ].join(';');
    const { stdout } = await execPromise(`python -c "${py.replace(/"/g, '\\"')}"`, { timeout: 15000, maxBuffer: 256 * 1024 });
    return { path: safeInner, content: String(stdout) };
  }
  const stat = await fs.stat(full);
  if (stat.size > MAX_READ_BYTES) throw new Error(`${attachment.name} is too large to read as text.`);
  return { path: attachment.name, content: await fs.readFile(full, 'utf8') };
}

const MEDIA_EXECUTABLE_CACHE = new Map();

function configuredExecutable(command) {
  const key = String(command).toLowerCase();
  if (key === 'ffmpeg') return process.env.FFMPEG_PATH || process.env.AGENT_FFMPEG_PATH || '';
  if (key === 'ffprobe') return process.env.FFPROBE_PATH || process.env.AGENT_FFPROBE_PATH || '';
  return '';
}

// execFile/spawn refuse to run .bat/.cmd on Windows unless a shell is used
// (Node raises EINVAL), so a shim on PATH is not a usable binary for this
// pipeline. It must be treated as "no FFmpeg" instead of a runtime crash.
function isSpawnableCandidate(candidate) {
  if (process.platform !== 'win32') return true;
  return !/\.(cmd|bat)$/i.test(String(candidate).trim());
}

// The install-location probe below (WinGet/Scoop/chocolatey/Program Files) is
// a safety net for shells with a stale PATH. AGENT_FFMPEG_DISCOVERY=off
// restricts resolution to FFMPEG_PATH/FFPROBE_PATH and the process PATH, which
// is also how the media checks simulate a machine without FFmpeg.
function discoveryEnabled() {
  const value = String(process.env.AGENT_FFMPEG_DISCOVERY ?? '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no', 'disabled'].includes(value);
}

async function resolveExecutable(command) {
  const key = String(command).toLowerCase();
  if (MEDIA_EXECUTABLE_CACHE.has(key)) return MEDIA_EXECUTABLE_CACHE.get(key);

  const candidates = [];
  const configured = configuredExecutable(command);
  if (configured) candidates.push(String(configured).trim().replace(/^\"|\"$/g, ''));

  // First trust the process PATH. This is the normal case and also handles
  // custom FFmpeg installations.
  candidates.push(command);

  if (process.platform === 'win32') {
    // When Agent21 is launched from a shortcut/old terminal, its PATH can be
    // stale even though FFmpeg is installed. Probe the current Windows command
    // resolver and a few standard install locations as a safety net.
    try {
      const { stdout } = await execFilePromise('where.exe', [command], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
      for (const item of String(stdout || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean)) candidates.unshift(item);
    } catch {}
    const roots = discoveryEnabled() ? [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
      process.env.USERPROFILE,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') : '',
      'C:\\ProgramData\\chocolatey\\bin',
      'C:\\ffmpeg',
      'C:\\ffmpeg\\bin'
    ].filter(Boolean) : [];
    for (const root of roots) {
      candidates.push(
        path.join(root, 'ffmpeg', 'bin', `${command}.exe`),
        path.join(root, 'bin', `${command}.exe`),
        path.join(root, 'scoop', 'shims', `${command}.exe`),
        path.join(root, 'scoop', 'apps', 'ffmpeg', 'current', 'bin', `${command}.exe`),
        path.join(root, `${command}.exe`)
      );
    }
    // WinGet package folders contain versioned FFmpeg directories. Only scan
    // one level deep so startup remains fast.
    const wingetPackages = discoveryEnabled() && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') : '';
    if (wingetPackages) {
      try {
        for (const pkg of await fs.readdir(wingetPackages, { withFileTypes: true })) {
          if (!pkg.isDirectory() || !/ffmpeg|gyan/i.test(pkg.name)) continue;
          const pkgRoot = path.join(wingetPackages, pkg.name);
          const walk = async (dir, depth = 0) => {
            if (depth > 4 || candidates.length > 80) return;
            const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              if (entry.isFile() && entry.name.toLowerCase() === `${command}.exe`) { candidates.push(full); continue; }
              if (entry.isDirectory()) await walk(full, depth + 1);
            }
          };
          await walk(pkgRoot);
        }
      } catch {}
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate === command) {
      // Let the child process resolve PATH; commandAvailable historically did
      // the same. Keep the concrete path that PATH resolves to, and only when
      // it is something this process can actually spawn.
      try {
        const { stdout } = await execFilePromise(process.platform === 'win32' ? 'where.exe' : 'which', [command], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
        const resolved = String(stdout || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean).find(isSpawnableCandidate);
        if (!resolved) continue;
        MEDIA_EXECUTABLE_CACHE.set(key, resolved);
        return resolved;
      } catch { continue; }
    }
    if (!isSpawnableCandidate(candidate)) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) { MEDIA_EXECUTABLE_CACHE.set(key, candidate); return candidate; }
    } catch {}
  }
  return null;
}

async function commandAvailable(command) {
  return Boolean(await resolveExecutable(command));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

// Trust the stored bytes over the browser-supplied MIME/kind: screen
// recordings frequently upload as application/octet-stream and screenshots as
// text/plain, which would otherwise skip visual processing entirely.
function sniffMediaKind(head) {
  if (!head || head.length < 12) return null;
  const at = (start, end) => head.toString('latin1', start, end);
  // JPEG / PNG / GIF / BMP / TIFF — image containers.
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image';
  if (head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image';
  if (at(0, 3) === 'GIF8') return 'image';
  if (at(0, 2) === 'BM') return 'image';
  if (at(0, 4) === 'II*\x00' || at(0, 4) === 'MM\x00*') return 'image';
  // RIFF containers: WEBP is an image, AVI is a video.
  if (at(0, 4) === 'RIFF') {
    const fourcc = at(8, 12);
    if (fourcc === 'WEBP') return 'image';
    if (fourcc.startsWith('AVI')) return 'video';
    return null;
  }
  // ISO base media (MP4/MOV/M4V/HEIC/AVIF): 'ftyp' at offset 4.
  if (at(4, 8) === 'ftyp') return HEIC_BRANDS.has(at(8, 12).toLowerCase()) ? 'image' : 'video';
  // QuickTime/MP4 files that start with another top-level box.
  if (['moov', 'mdat', 'free', 'skip', 'wide', 'pnot'].includes(at(4, 8))) return 'video';
  // Matroska / WebM.
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video';
  return null;
}

// Formats the Ollama runtime decodes straight from base64 (no conversion).
function isDirectOllamaImage(head) {
  if (!head || head.length < 12) return false;
  const at = (start, end) => head.toString('latin1', start, end);
  return (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    || head.subarray(0, 8).equals(PNG_SIGNATURE)
    || at(0, 3) === 'GIF8'
    || (at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP');
}

async function readHead(file, bytes = 64) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return Buffer.alloc(0);
  }
}

// Correct kind/mime from the actual bytes so an octet-stream recording is
// still treated as video and a bare screenshot as an image.
async function normalizeAttachmentKind(sessionId, attachment) {
  if (!attachment?.id || String(attachment.kind || '') === 'archive') return attachment;
  try {
    const head = await readHead(await resolveAttachment(sessionId, attachment));
    const sniffed = sniffMediaKind(head);
    if (!sniffed || sniffed === attachment.kind) return attachment;
    const declaredMime = String(attachment.mimeType || '').toLowerCase();
    const mimeType = sniffed === 'video'
      ? (declaredMime.startsWith('video/') ? declaredMime : 'video/mp4')
      : (declaredMime.startsWith('image/') ? declaredMime : 'image/png');
    return { ...attachment, kind: sniffed, mimeType, declaredKind: attachment.kind };
  } catch {
    return attachment;
  }
}

/**
 * Decode attachments for the vision model.
 * Returns { images, notes }:
 *   - images: [{ attachment, base64 }] ready for an Ollama vision call
 *   - notes:  human-readable fallbacks when frames could not be produced
 *     (FFmpeg missing, extraction failed, unsupported format) so the agent
 *     task continues on metadata instead of crashing.
 */
async function prepareImageFrames(sessionId, attachments) {
  const images = [];
  const notes = [];

  const metaSummary = (attachment, duration, meta) => {
    const bits = [];
    if (duration > 0) bits.push(`${duration.toFixed(1)}s`);
    const video = (meta?.streams || []).find(s => s?.width && s?.height) || null;
    if (video) bits.push(`${video.width}x${video.height}${video.codec_name ? ` ${video.codec_name}` : ''}`);
    bits.push(`${attachment.size ?? meta?.format?.size ?? '?'} bytes`);
    return bits.join(', ');
  };

  for (const attachment of attachments || []) {
    let full;
    try {
      full = await resolveAttachment(sessionId, attachment);
    } catch (error) {
      notes.push(`${attachment?.name || 'attachment'}: ${error?.message || error}`);
      continue;
    }
    const mime = String(attachment.mimeType || '').toLowerCase();
    const head = await readHead(full);
    const sniffed = sniffMediaKind(head);
    const kind = sniffed
      || (attachment.kind === 'video' || mime.startsWith('video/') ? 'video'
        : attachment.kind === 'image' || mime.startsWith('image/') ? 'image' : null);

    if (kind === 'image') {
      // Screenshots pass through untouched: this path has no FFmpeg
      // dependency, so images keep working even when FFmpeg is missing.
      const data = await fs.readFile(full).catch(() => null);
      if (!data?.length) {
        notes.push(`${attachment.name}: the image file is empty or unreadable, so it cannot be analyzed.`);
        continue;
      }
      if (isDirectOllamaImage(head)) {
        images.push({ attachment, base64: data.toString('base64') });
        continue;
      }
      // SVG/TIFF/BMP/unknown: convert one frame to PNG when FFmpeg exists.
      const png = await convertImageToPng(sessionId, attachment, full);
      if (png) {
        images.push({ attachment: { ...attachment, name: `${attachment.name} (as PNG)` }, base64: png.toString('base64') });
      } else {
        const ffmpegOk = await commandAvailable('ffmpeg');
        notes.push(`${attachment.name} [image]: format is not one Ollama decodes directly (JPEG/PNG/WebP/GIF) and FFmpeg could not convert it${ffmpegOk ? '' : ' because FFmpeg is not installed'}. Re-export the screenshot as PNG or JPEG.`);
      }
      continue;
    }

    if (kind !== 'video') continue; // archives/text are handled by attachment tools

    // --- video -------------------------------------------------------------
    const stat = await fs.stat(full).catch(() => null);
    const ffmpegBin = await resolveExecutable('ffmpeg');
    const ffprobeBin = await resolveExecutable('ffprobe');
    const ffmpegOk = Boolean(ffmpegBin);
    const ffprobeOk = Boolean(ffprobeBin);
    let duration = 0;
    let meta = null;
    if (ffprobeOk) {
      try {
        const { stdout } = await execFilePromise(ffprobeBin, [
          '-v', 'error', '-show_entries', 'format=duration,size',
          '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate',
          '-of', 'json', full
        ], { timeout: 15_000, maxBuffer: 512 * 1024, windowsHide: true });
        meta = JSON.parse(String(stdout) || '{}');
        duration = Math.max(0, Number.parseFloat(String(meta?.format?.duration ?? '')) || 0);
      } catch (error) {
        console.warn(`[Vision] ffprobe could not read ${attachment.name}: ${error?.message || error}`);
      }
    }
    const metaText = metaSummary(attachment, duration, meta) || `size ${stat?.size ?? attachment.size ?? '?'} bytes`;

    if (!ffmpegOk) {
      notes.push(`${attachment.name} [video]: FFmpeg is not installed or not found on PATH, so no frames could be sampled (metadata: ${metaText}). Install FFmpeg (winget install Gyan.FFmpeg) or attach the key screenshots — the task continues without frame-level analysis.`);
      continue;
    }

    const frameDir = path.join(attachmentRoot(sessionId), `${attachment.id}-frames`);
    let frames = [];
    try {
      frames = await extractVideoFrames({ videoPath: full, frameDir, duration, maxFrames: VISION_FRAME_COUNT, intervalSeconds: VISION_FRAME_INTERVAL });
    } catch (error) {
      notes.push(`${attachment.name} [video]: frame extraction failed — ${error?.message || error} (metadata: ${metaText}). The task continues without frame-level analysis.`);
      continue;
    }
    let produced = 0;
    for (const frame of frames) {
      const data = await fs.readFile(frame.file).catch(() => null);
      if (!data?.length) continue;
      produced++;
      images.push({
        attachment: { ...attachment, name: `${attachment.name} · ${String(produced).padStart(2, '0')} @ ${frame.timestamp.toFixed(1)}s` },
        base64: data.toString('base64')
      });
    }
    if (!produced) notes.push(`${attachment.name} [video]: FFmpeg produced no readable frames (metadata: ${metaText}). The task continues without frame-level analysis.`);
  }

  return { images, notes };
}

// One frame from an exotic image format (SVG/TIFF/BMP) converted to PNG so
// Ollama can decode it. Returns null when FFmpeg is unavailable or fails.
async function convertImageToPng(sessionId, attachment, full) {
  const ffmpegBin = await resolveExecutable('ffmpeg');
  if (!ffmpegBin) return null;
  try {
    const dir = path.join(attachmentRoot(sessionId), `${attachment.id}-frames`);
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, 'converted.png');
    await execFilePromise(ffmpegBin, [
      '-y', '-nostdin', '-loglevel', 'error', '-i', full,
      '-frames:v', '1', '-vf', `scale=${VISION_MAX_IMAGE_WIDTH}:-2`, out
    ], { timeout: Number.isFinite(FFMPEG_SEEK_TIMEOUT_MS) && FFMPEG_SEEK_TIMEOUT_MS > 0 ? FFMPEG_SEEK_TIMEOUT_MS : undefined, maxBuffer: 128 * 1024, windowsHide: true });
    const png = await fs.readFile(out).catch(() => null);
    return png?.length ? png : null;
  } catch {
    return null;
  }
}

async function collectFrames(frameDir, timestampFor) {
  const names = (await fs.readdir(frameDir).catch(() => []))
    .filter(name => /^frame-\d+\.jpg$/i.test(name))
    .sort();
  const frames = [];
  for (const name of names) {
    const file = path.join(frameDir, name);
    const size = await fs.stat(file).then(s => s.size).catch(() => 0);
    if (size <= 0) continue;
    const parsed = /(\d+)\.jpg$/i.exec(name);
    const index = Math.max(0, (parsed ? Number.parseInt(parsed[1], 10) : 1) - 1);
    frames.push({ file, timestamp: Math.max(0, Number(timestampFor(index)) || 0) });
  }
  return frames;
}

/**
 * Sample a video efficiently: one sequential pass with an fps filter (one frame
 * every few seconds) and, when that fails or times out, fast per-timestamp
 * seeks. Errors are tagged FFMPEG_MISSING / FFMPEG_TIMEOUT / FFMPEG_FAILED so
 * callers can fall back to metadata instead of crashing.
 */
async function extractVideoFrames({ videoPath, frameDir, duration = 0, maxFrames = VISION_FRAME_COUNT, intervalSeconds = VISION_FRAME_INTERVAL }) {
  await fs.mkdir(frameDir, { recursive: true });
  const ffmpegBin = await resolveExecutable('ffmpeg');
  if (!ffmpegBin) {
    const err = new Error('FFmpeg is not installed or not discoverable. Set FFMPEG_PATH in .env to the full path of ffmpeg.exe, then restart Agent21.');
    err.code = 'FFMPEG_MISSING';
    throw err;
  }
  // Drop stale frames from an earlier upload stored under the same id.
  for (const name of await fs.readdir(frameDir).catch(() => [])) {
    if (/^frame-\d+\.jpg$/i.test(name) || name === 'converted.png') await fs.unlink(path.join(frameDir, name)).catch(() => {});
  }

  const span = duration > 0 ? duration : 0;
  const step = Math.round(Math.max(1, span > 0 ? span / Math.max(1, maxFrames) : intervalSeconds) * 10) / 10;
  const timeoutArg = ms => (Number.isFinite(ms) && ms > 0 ? ms : undefined);

  const typedError = (error, phase) => {
    const code = error?.code === 'ENOENT' ? 'FFMPEG_MISSING'
      : (error?.killed || error?.signal) ? 'FFMPEG_TIMEOUT' : 'FFMPEG_FAILED';
    const budget = phase === 'pass' ? FFMPEG_FRAME_TIMEOUT_MS : FFMPEG_SEEK_TIMEOUT_MS;
    const tail = String(error?.stderr || error?.message || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(-300);
    const text = code === 'FFMPEG_MISSING'
      ? 'FFmpeg is not installed or not found on PATH. Install FFmpeg (winget install Gyan.FFmpeg) or attach screenshots directly.'
      : code === 'FFMPEG_TIMEOUT'
        ? `FFmpeg timed out after ${Math.round(budget / 1000)}s while ${phase === 'pass' ? 'sampling the clip sequentially' : 'seeking sample timestamps'}.`
        : `FFmpeg failed while ${phase === 'pass' ? 'sampling the clip' : 'seeking sample timestamps'}${tail ? `: ${tail}` : '.'}`;
    const wrapped = new Error(text);
    wrapped.code = code;
    return wrapped;
  };

  let lastError = null;
  // 1) Single sequential decode: fps=1/step keeps roughly one frame every few
  //    seconds and -frames:v bounds the output, so short clips stop early.
  try {
    await execFilePromise(ffmpegBin, [
      '-y', '-nostdin', '-loglevel', 'error', '-i', videoPath,
      '-vf', `fps=1/${step},scale=${VISION_MAX_IMAGE_WIDTH}:-2`,
      '-frames:v', String(maxFrames), '-q:v', '3',
      path.join(frameDir, 'frame-%03d.jpg')
    ], { timeout: timeoutArg(FFMPEG_FRAME_TIMEOUT_MS), maxBuffer: 512 * 1024, windowsHide: true });
  } catch (error) {
    lastError = typedError(error, 'pass');
    if (lastError.code === 'FFMPEG_MISSING') throw lastError;
    // A killed pass can still have left usable frames; collect them below.
  }
  const fromPass = await collectFrames(frameDir, index => index * step);
  if (fromPass.length) return fromPass;

  // 2) Fallback: fast input seeks to evenly spaced timestamps. Each seek only
  //    decodes around its own target, so this survives long clips and machines
  //    too slow for a full sequential decode.
  const ratios = [0.01, 0.12, 0.24, 0.38, 0.52, 0.68, 0.82, 0.97];
  const count = span > 0 ? Math.min(maxFrames, ratios.length) : Math.min(6, maxFrames);
  const timestamps = span > 0
    ? ratios.slice(0, count).map(r => Math.max(0, Math.min(span - 0.05, span * r)))
    : Array.from({ length: count }, (_, i) => i * Math.max(1, intervalSeconds));
  for (let i = 0; i < timestamps.length; i++) {
    const target = path.join(frameDir, `frame-${String(i + 1).padStart(3, '0')}.jpg`);
    try {
      await execFilePromise(ffmpegBin, [
        '-y', '-nostdin', '-loglevel', 'error', '-ss', String(timestamps[i]), '-i', videoPath,
        '-frames:v', '1', '-vf', `scale=${VISION_MAX_IMAGE_WIDTH}:-2`, '-q:v', '3', target
      ], { timeout: timeoutArg(FFMPEG_SEEK_TIMEOUT_MS), maxBuffer: 256 * 1024, windowsHide: true });
    } catch (error) {
      lastError = typedError(error, 'seek');
      if (lastError.code === 'FFMPEG_MISSING') throw lastError;
      console.warn(`[Vision] frame ${i + 1} seek failed: ${error?.message || error}`);
    }
  }
  const frames = await collectFrames(frameDir, index => timestamps[Math.min(index, timestamps.length - 1)] ?? 0);
  if (!frames.length) throw lastError || new Error('FFmpeg produced no readable frames for this video.');
  return frames;
}

function modelSupportsVision(modelName = '') {
  const n = String(modelName).toLowerCase();
  return /(vision|vl|llava|moondream|minicpm-v|gemma3)/.test(n);
}

// Cheap name check used to size token budgets (no Ollama round-trip).
function isVisionModelName(modelName = '') {
  return /(vision|vl|llava|moondream|minicpm-v|gemma3)/i.test(String(modelName || ''));
}

async function modelSupportsVisionAsync(modelName = '') {
  if (modelSupportsVision(modelName)) return true;
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName })
    });
    const data = await r.json().catch(() => ({}));
    return Array.isArray(data.capabilities) && data.capabilities.some(c => /vision/i.test(c));
  } catch {
    return false;
  }
}

function attachmentInstruction(attachments, mediaAlreadyAnalyzed = false) {
  if (!attachments?.length) return '';
  const lines = [
    '',
    'USER ATTACHMENTS ARE AVAILABLE FOR THIS TASK:',
    ...attachments.map(a => `- ${a.name} [${a.kind}] id=${a.id}`),
    'Do not ask the user to re-upload or describe an attachment. Inspect it yourself.',
    'For ZIP/archive files, inspect the archive before deciding what to change. For text files, use read_attachment.',
    'For screenshots/images/video frames, use the visual content directly when the selected model supports vision.',
    'If a source-project ZIP is attached and the user asks you to update that project, inspect it and use extract_attachment to bring it into the active workspace when appropriate; do not ask the user to repeat its contents.'
  ];
  if (mediaAlreadyAnalyzed) {
    lines.push('The image/video attachments were already analyzed locally and the findings are in the user message. Use those findings as evidence, then verify against the source code.');
  }
  return lines.join('\n');
}

async function executeAgentTool(name, args, workspace, sessionId, attachments = []) {

  switch (name) {
    case 'inspect_project': return inspectProject(workspace);
    case 'list_files': return listFiles(workspace, args?.path || '.', Number(args?.depth ?? 2));
    case 'search_files': return searchFiles(workspace, args?.query, args?.path || '.');
    case 'read_file': return readFile(workspace, args?.path);
    case 'write_file': return writeFile(workspace, args?.path, args?.content ?? '', { allowProject: args?.allow_project === true });
    case 'execute_code': return executeCode(workspace, args?.language, args?.code);
    case 'run_command': return runCommand(workspace, args?.command);
    case 'inspect_attachment': {
      const target = findAttachment(attachments, args?.id);
      if (!target) throw new Error(`Unknown attachment: ${args?.id || 'missing id'}. Available: ${(attachments || []).map(a => a.name || a.id).join(', ') || 'none'}`);
      return inspectAttachment(sessionId, target);
    }
    case 'read_attachment': {
      const target = findAttachment(attachments, args?.id);
      if (!target) throw new Error(`Unknown attachment: ${args?.id || 'missing id'}. Available: ${(attachments || []).map(a => a.name || a.id).join(', ') || 'none'}`);
      return readAttachment(sessionId, target, args?.path);
    }
    case 'extract_attachment': {
      const target = findAttachment(attachments, args?.id);
      if (!target) throw new Error(`Unknown attachment: ${args?.id || 'missing id'}. Available: ${(attachments || []).map(a => a.name || a.id).join(', ') || 'none'}`);
      return extractAttachment(sessionId, target, workspace);
    }
    default: throw new Error(`Unknown agent tool: ${name}`);
  }
}

// Local model compatibility helpers.
function supportsNativeTools(modelName = '') {
  return !String(modelName).toLowerCase().startsWith('gemma');
}

function extractToolCall(text) {
  if (!text) return null;
  const candidates = [];
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  candidates.push(...fenced.map(x => x.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()));
  let depth = 0, begin = -1, inString = false, escaped = false;
  const raw = String(text);
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') { if (depth === 0) begin = i; depth++; }
    else if (ch === '}' && depth > 0) { depth--; if (depth === 0 && begin >= 0) candidates.push(raw.slice(begin, i + 1)); }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const name = parsed?.tool || parsed?.name;
      const args = parsed?.arguments || parsed?.args || parsed?.parameters || parsed;
      if (typeof name === 'string' && ['inspect_project','list_files','search_files','read_file','write_file','execute_code','run_command','inspect_attachment','read_attachment','extract_attachment'].includes(name)) return { name, args };
    } catch {}
  }
  return null;
}

function ollamaToolDefinitions() {
  return [
    { type: 'function', function: { name: 'inspect_project', description: 'Fast project overview. Use first for project structure questions.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
    { type: 'function', function: { name: 'list_files', description: 'List files in the active project.', parameters: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer' } }, additionalProperties: false } } },
    { type: 'function', function: { name: 'search_files', description: 'Search source files for a text string.', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a text file from the active project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
    { type: 'function', function: { name: 'write_file', description: 'Create or update a text file in the active project. New files in src/ or the project root are redirected into .sandbox/ unless allow_project is true.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, allow_project: { type: 'boolean', description: 'Set true ONLY when the user explicitly asked to create this file in the main project (src/ or project root). Omit otherwise; redirected writes land in .sandbox/.' } }, required: ['path','content'], additionalProperties: false } } },
    { type: 'function', function: { name: 'execute_code', description: 'Execute Python or JavaScript in the active project.', parameters: { type: 'object', properties: { language: { type: 'string' }, code: { type: 'string' } }, required: ['language','code'], additionalProperties: false } } },
    { type: 'function', function: { name: 'run_command', description: 'Run a shell command in the active project. Use only when needed.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } } },
    { type: 'function', function: { name: 'inspect_attachment', description: 'Inspect a user-uploaded image, video, ZIP/archive, or file. Use this when attachments are present.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } },
    { type: 'function', function: { name: 'read_attachment', description: 'Read a text file or a file inside a ZIP attachment. Never ask the user to paste its contents.', parameters: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' } }, required: ['id'], additionalProperties: false } } },
    { type: 'function', function: { name: 'extract_attachment', description: 'Safely extract a ZIP attachment into .agent-imports inside the active workspace so you can inspect or modify the imported project.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } }
  ];
}

function modelSupportsTools(model) {
  const n = String(model || '').toLowerCase();
  return !n.startsWith('gemma');
}

function shouldDirectQuestion(text) {
  const s = String(text || '').toLowerCase().trim();
  return /^(what is|what's|tell me|which is|where is)\b/.test(s)
    && /\b(project name|project|framework|technology|tech stack|database|entry point|package name)\b/.test(s)
    && !/\b(fix|change|update|modify|implement|create|add|remove|delete|build|test|debug|edit|refactor|improve|resolve)\b/.test(s);
}

function answerSimpleProjectQuestion(text, info) {
  const key = info.keyFiles || {};
  let pkg = {};
  try { pkg = JSON.parse(key['package.json'] || '{}'); } catch {}
  const s = String(text || '').toLowerCase();
  if (/project name|package name/.test(s)) return pkg.name ? `The project name is \`${pkg.name}\`.` : `The project name could not be determined because package.json does not contain a name.`;
  if (/framework|technology|tech stack/.test(s)) {
    const summary = makeFastProjectSummary(info);
    return summary.split('\n')[1] || 'The technology stack could not be determined.';
  }
  if (/database/.test(s)) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const names = Object.keys(deps).filter(k => /mysql|postgres|sqlite|mongodb|prisma|sequelize|typeorm/i.test(k));
    return names.length ? `Detected database-related packages: ${names.join(', ')}.` : 'No database package was detected in package.json.';
  }
  return makeFastProjectSummary(info);
}

function shouldDirectInspect(text) {
  const s = String(text || '').toLowerCase();
  return /\b(inspect|analy[sz]e|analyse|structure|which files|what files|project overview|project structure)\b/.test(s)
    && /\b(project|react|typescript|node|mysql|folder|workspace|codebase)\b/.test(s)
    && !/\b(create|add|change|modify|update|fix|implement|delete|remove|build|test|run)\b/.test(s);
}

function makeFastProjectSummary(info) {
  const files = info.files || [];
  const key = info.keyFiles || {};
  let pkg = {};
  try { pkg = JSON.parse(key['package.json'] || '{}'); } catch {}
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = name => Object.keys(deps).some(k => k.toLowerCase() === name.toLowerCase());
  const frameworks = [];
  if (has('react')) frameworks.push('React');
  if (has('typescript') || key['tsconfig.json']) frameworks.push('TypeScript');
  if (has('vite')) frameworks.push('Vite');
  if (has('next')) frameworks.push('Next.js');
  if (has('express')) frameworks.push('Node.js/Express');
  if (has('mysql2') || has('mysql')) frameworks.push('MySQL');
  return [
    `Active workspace: ${info.workspace}`,
    `Detected stack: ${frameworks.length ? frameworks.join(', ') : 'not determined from package/config files'}.`,
    `Top project files: ${files.slice(0, 40).join(', ') || 'none found'}.`,
    `package.json: ${key['package.json'] ? 'found' : 'not found'}; tsconfig: ${key['tsconfig.json'] ? 'found' : 'not found'}.`,
    'No files were modified.'
  ].join('\n');
}


async function callOllamaChat(model, messages, tools, think = false, timeoutMs = OLLAMA_TIMEOUT_MS) {
  const controller = new AbortController();
  // A non-finite/zero timeout removes the abort timer entirely — that is what
  // OLLAMA_VISION_TIMEOUT_MS=0 ("no limit") resolves to.
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const body = {
      model,
      messages,
      stream: false,
      keep_alive: '30m',
      think,
      options: {
        temperature: 0,
        num_ctx: String(model).toLowerCase().includes('vl') || String(model).toLowerCase().includes('vision') ? 4096 : 4096,
        // A reasoning-capable vision model (qwen3-vl) can spend its whole token
        // budget thinking and answer with an empty string. Vision calls carry no
        // tools, so give them room for reasoning + a real answer.
        num_predict: String(model).toLowerCase().startsWith('deepseek') ? 768
          : (isVisionModelName(model) && !tools?.length ? 1536 : 768),
        num_thread: Math.max(1, Math.min(8, os.cpus().length)),
        repeat_penalty: 1.05
      }
    };
    if (tools?.length) body.tools = tools;
    let response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal
    });
    let raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { throw new Error(`Ollama returned invalid JSON (HTTP ${response.status}).`); }
    // Older Ollama releases may not understand the `think` request field.
    // Retry once without it instead of failing the entire agent turn.
    if (!response.ok && /think|unknown field/i.test(String(data.error || '')) && Object.prototype.hasOwnProperty.call(body, 'think')) {
      delete body.think;
      response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal
      });
      raw = await response.text();
      try { data = JSON.parse(raw); } catch { throw new Error(`Ollama returned invalid JSON (HTTP ${response.status}).`); }
    }
    if (!response.ok) throw new Error(data.error || `Ollama HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutSeconds = Math.round(timeoutMs / 1000);
      const timeoutError = new Error(`Ollama model call timed out after ${timeoutSeconds} seconds.`);
      timeoutError.code = 'OLLAMA_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}

function shouldAutonomyRetry(userMessage, reply) {
  const request = String(userMessage || '').toLowerCase();
  const answer = String(reply || '').toLowerCase();
  const isTask = /\b(fix|change|update|modify|implement|create|add|remove|delete|build|test|debug|inspect|analy[sz]e|review|edit|refactor|improve|resolve)\b/.test(request);
  const asksForInput = /\b(please provide|provide more information|can you provide|could you provide|need more information|please clarify|could you clarify|what (is|are) the|tell me more|i need to know|shall i|should i|can i|would you like|do you want me to|may i|is it okay if)\b/.test(answer)
    || /\?\s*$/.test(answer);
  return isTask && asksForInput;
}

function isImplementationRequest(text) {
  return /\b(fix|change|update|modify|implement|create|add|remove|delete|build|test|debug|edit|refactor|improve|resolve|make|integrate)\b/i.test(String(text || ''));
}

function shouldForceImplementationRetry(userMessage, reply, toolExecuted) {
  if (toolExecuted) return false;
  const request = String(userMessage || '').toLowerCase();
  const answer = String(reply || '').toLowerCase();
  const isImplementation = /\b(fix|change|update|modify|implement|create|add|remove|delete|build|test|debug|edit|refactor|improve|resolve)\b/.test(request);
  if (!isImplementation) return false;
  const explanationOnly = /\b(here(?:'s| is) (?:a )?(?:breakdown|summary|description)|the provided (?:configuration|files|project)|package\.json|tsconfig\.json|vite\.config|this project uses|here is an overview)\b/.test(answer);
  return explanationOnly || answer.length > 900;
}

async function loadAgentSystemPrompt(workspace) {
  const configured = String(process.env.AGENT_SYSTEM_PROMPT_FILE || 'agent-system-prompt.md').trim();
  const candidates = [configured, 'agent-system-prompt.md', 'AGENT_SYSTEM_PROMPT.md'];
  const seen = new Set();
  for (const name of candidates) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const file = path.resolve(workspace, name);
    const workspaceRoot = path.resolve(workspace) + path.sep;
    if (!file.startsWith(workspaceRoot)) continue;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      return (await fs.readFile(file, 'utf8')).slice(0, 40000);
    } catch {}
  }
  return '';
}

async function loadProjectInstructions(workspace) {
  const candidates = ['project-instructions.md', 'AGENTS.md', '.agent-instructions.md'];
  for (const name of candidates) {
    const file = path.join(workspace, name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      const text = await fs.readFile(file, 'utf8');
      return text.slice(0, 30000);
    } catch {}
  }
  return '';
}

function nativeSystemPrompt(workspace, model, projectInstructions = '', configuredSystemPrompt = '') {
  return [
    configuredSystemPrompt ? `CONFIGURED AGENT SYSTEM PROMPT:\n${configuredSystemPrompt}` : '',
    'You are LocalAgent, a fast autonomous senior software engineer.',
    String(model || '').toLowerCase().startsWith('deepseek') ? 'Use concise reasoning and tools.' : 'Do not think aloud; use tools immediately.',
    `ACTIVE WORKSPACE: ${workspace}`,
    'Work only inside the active workspace.',
    '',
    'MANDATORY SOFTWARE DEVELOPMENT LIFECYCLE (SDLC):',
    'PHASE 1 — COMPREHENSION & CONTEXT: Analyze the user intent. Inspect the project structure and relevant configuration/source files before editing. Use existing patterns, libraries, architecture, and coding style. Inspect screenshots, attachments, logs, and history yourself when available.',
    'PHASE 2 — STRATEGY & PLAN: For a non-trivial task, formulate a concise 2–3 line implementation plan internally before the first write. Identify the files likely to change and the validation needed. Do not ask the user for permission to execute that plan.',
    'PHASE 3 — IMPLEMENTATION: Make targeted, minimal changes. Preserve working behavior. Maintain type safety, imports, error handling, input validation, and existing conventions. Do not rewrite unrelated files. Update dependencies only when required.',
    'PHASE 4 — VERIFICATION & SELF-CORRECTION: After modifications, run the smallest relevant build, typecheck, test, lint, or runtime check. If verification fails, inspect the error, correct the code, and verify again. Never claim completion when the changed code has not been reasonably validated.',
    'PHASE 5 — PREVIEW & HANDOVER: Ensure the application/preview can use the updated files. Refresh or trigger the preview when supported. Summarize what changed, verification performed, and any remaining limitation. Do not make the user manually repeat steps the agent can perform.',
    '',
    'AUTONOMY AND AUTHORIZATION:',
    'The user task itself is authorization for normal non-destructive development work: inspect, read, create, edit, delete generated/intermediate files when necessary, build, test, run development commands, diagnose errors, and refresh preview.',
    'NEVER ask for confirmation before normal implementation work. Never ask "shall I", "should I", "can I", "would you like me to", "do you want me to", or similar questions for work already requested.',
    'Ask the user only for a truly blocking external decision, missing credential, irreversible/destructive production action, or requirement that cannot be discovered safely. Otherwise make the safest reasonable assumption and continue.',
    'Do not ask the user to provide information that can be obtained from the workspace, database, source files, logs, browser state, screenshots, ZIPs, videos, or attachments.',
    'If a tool call fails because of an incorrect path/type, recover by inspecting the parent path and file type, then continue. In particular, recover automatically from ENOTDIR/scandir/path-type errors.',
    'Do not stop after saying what you would do. Actually perform the work.',
    '',
    'ENGINEERING SAFETY AND QUALITY:',
    'Never expose production secrets, passwords, API keys, tokens, or real identification numbers. Use placeholders in generated documentation/examples.',
    'For server startup/routing changes, prefer process.env.PORT with a safe fallback rather than hard-coded ports, and avoid EADDRINUSE conflicts.',
    'Use strict TypeScript types where TypeScript is present; avoid introducing any unless unavoidable and justified.',
    'Wrap asynchronous persistence/API operations with appropriate error handling and useful user-facing errors.',
    'Sanitize numeric/text inputs where the feature requires it.',
    'Prefer targeted diffs and preserve unrelated code.',
    '',
    'TOOL ORDER:',
    'For implementation tasks, ALWAYS perform at least one discovery tool call before writing: inspect_project, search_files, list_files, read_file, or inspect_attachment as appropriate. Then read the exact target files, make the requested edit, and verify it. Never answer with only a project/configuration explanation when the user asked to change code.',
    'If the user explicitly names a file to update, locate and read that file before any explanation. If it exists, modify it unless the task is impossible or unsafe.',
    'If attachments exist, inspect them before deciding the implementation. Never ask the user to describe or re-upload an attachment that is already available.',
    'Prefer search_files over huge directory listings. Use the smallest relevant command for verification.',
    projectInstructions ? `\nPROJECT-SPECIFIC INSTRUCTIONS:\n${projectInstructions}` : '',
    'Keep the final response concise and factual.'
  ].filter(Boolean).join('\n');
}


function isSimpleStaticHomeTask(text) {
  const s = String(text || '').toLowerCase();
  return /\b(create|prepare|make|build|design)\b/.test(s)
    && /\bhome\s*page\b/.test(s)
    && /\b(html|css)\b/.test(s)
    && /\b(js|javascript)\b/.test(s);
}

async function createStaticHomePage(workspace) {
  const files = {
    'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome Home</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <header class="site-header">
    <a class="brand" href="#">Home</a>
    <nav aria-label="Primary navigation">
      <a href="#home">Home</a><a href="#features">Features</a><a href="#about">About</a><a href="#contact">Contact</a>
    </nav>
  </header>
  <main>
    <section id="home" class="hero">
      <div class="hero-copy">
        <p class="eyebrow">WELCOME</p>
        <h1>A clean, modern home page.</h1>
        <p class="lead">A responsive HTML, CSS and JavaScript starter that you can customize for your project.</p>
        <div class="actions"><a class="button primary" href="#features">Explore</a><a class="button secondary" href="#contact">Get started</a></div>
      </div>
    </section>
    <section id="features" class="features">
      <article><h2>Simple</h2><p>Semantic HTML with a small, maintainable structure.</p></article>
      <article><h2>Responsive</h2><p>Mobile-first CSS that adapts to desktop screens.</p></article>
      <article><h2>Interactive</h2><p>Vanilla JavaScript handles the menu and button feedback.</p></article>
    </section>
    <section id="about" class="about"><h2>Built to extend</h2><p>Replace this content with your product, service or application details.</p></section>
    <section id="contact" class="contact"><h2>Ready to customize?</h2><button id="contactButton" class="button primary" type="button">Say hello</button></section>
  </main>
  <footer><span>© <span id="year"></span> Your Project</span></footer>
  <script src="./script.js"></script>
</body>
</html>
`,
    'styles.css': `:root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f5f7fb;background:#0b1020;line-height:1.6;font-synthesis:none}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 15% 10%,#1b2a52 0,transparent 35%),#0b1020}a{color:inherit;text-decoration:none}.site-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:18px clamp(20px,5vw,72px);background:rgba(11,16,32,.78);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,.08)}.brand{font-weight:800;font-size:1.2rem}.site-header nav{display:flex;gap:24px;color:#b8c2d9;font-size:.95rem}.site-header nav a:hover{color:#fff}.hero{min-height:72vh;display:grid;place-items:center;padding:80px 24px}.hero-copy{max-width:820px;text-align:center}.eyebrow{color:#7dd3fc;font-weight:800;letter-spacing:.18em}.hero h1{margin:12px 0;font-size:clamp(2.8rem,7vw,6rem);line-height:1.02;letter-spacing:-.06em}.lead{max-width:650px;margin:0 auto;color:#b8c2d9;font-size:1.15rem}.actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:30px}.button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:12px;padding:12px 20px;font-weight:750;cursor:pointer}.primary{background:#7dd3fc;color:#06111d}.secondary{border:1px solid rgba(255,255,255,.15);color:#fff;background:rgba(255,255,255,.05)}.features{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;max-width:1050px;margin:auto;padding:24px}.features article,.about,.contact{padding:28px;border:1px solid rgba(255,255,255,.1);border-radius:20px;background:rgba(255,255,255,.045)}.features p,.about p{color:#b8c2d9}.about,.contact{max-width:1000px;margin:24px auto;padding-left:28px;padding-right:28px}.contact{text-align:center;margin-bottom:50px}footer{text-align:center;padding:24px;color:#7f8aa3;border-top:1px solid rgba(255,255,255,.08)}@media(max-width:760px){.site-header nav{display:none}.features{grid-template-columns:1fr}.hero{min-height:65vh}.hero h1{font-size:clamp(2.5rem,14vw,4rem)}}
`,
    'script.js': `document.addEventListener('DOMContentLoaded',()=>{const year=document.getElementById('year');if(year)year.textContent=new Date().getFullYear();const button=document.getElementById('contactButton');button?.addEventListener('click',()=>{button.textContent='Thanks! We will be in touch.';button.disabled=true;});});
`
  };
  const written=[];
  for (const [file, content] of Object.entries(files)) {
    const full=safePath(workspace,file);
    const exists=await fs.stat(full).then(()=>true).catch(()=>false);
    if (!exists) { await fs.writeFile(full,content,'utf8'); written.push(file); }
  }
  return { files: written, status: 'success', fallback: true };
}

// Map a tool name to the timeline row (icon + title) shown in the chat's
// live "Working" panel: Thinking / List / Read / Write / Search / Run.
// Canonical timeline milestone, so every successful edit reads the same way
// ("Write ✓ changes made") no matter which tool loop executed it.
function emitWriteMilestone(emitStep, toolName, result) {
  if (!result?.error && ['write_file', 'extract_attachment'].includes(String(toolName))) {
    emitStep({ kind: 'write', label: 'Write' }, 'changes made', 'done');
  }
}

function toolEventInfo(name) {
  switch (name) {
    case 'list_files':
    case 'inspect_project':
      return { kind: 'list', label: 'List' };
    case 'search_files': return { kind: 'search', label: 'Search' };
    case 'read_file': return { kind: 'read', label: 'Read' };
    case 'write_file':
    case 'create_static_home_page':
      return { kind: 'write', label: 'Write' };
    case 'inspect_attachment':
    case 'read_attachment':
    case 'extract_attachment': return { kind: 'attachment', label: 'Attachment' };
    case 'execute_code':
    case 'run_command':
    default: return { kind: 'run', label: 'Run' };
  }
}

function toolEventDetail(name, args) {
  const a = args || {};
  if (name === 'read_file' || name === 'write_file' || name === 'list_files') return String(a.path || '.');
  if (name === 'search_files') return String(a.query || '');
  if (name === 'execute_code') return String(a.language || 'code');
  if (name === 'run_command') return String(a.command || '').replace(/\s+/g, ' ').slice(0, 60);
  if (name === 'inspect_attachment' || name === 'read_attachment' || name === 'extract_attachment') return String(a.id || 'attachment');
  return '';
}

async function listOllamaModels() {
  let response = null;
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined;
    response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal });
  } catch (error) {
    // A stopped/restarting Ollama is not the same problem as an empty model
    // library. Reporting it as "no models installed" sends the user to
    // `ollama pull` when what they need is a running Ollama.
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? `timed out after 15 s`
      : `${error?.message || error}`;
    const unreachable = new Error(`Ollama did not respond at ${OLLAMA_BASE_URL} (${reason}). Start it with 'ollama serve' or the Ollama desktop app, then retry.`);
    unreachable.code = 'OLLAMA_UNREACHABLE';
    throw unreachable;
  }
  if (!response.ok) {
    const unreachable = new Error(`Ollama at ${OLLAMA_BASE_URL} answered HTTP ${response.status} for /api/tags. Restart Ollama, then retry.`);
    unreachable.code = 'OLLAMA_UNREACHABLE';
    throw unreachable;
  }
  const data = await response.json().catch(() => ({}));
  const names = Array.isArray(data.models) ? data.models.map(m => m?.name).filter(Boolean) : [];
  // Several tags can point at one manifest, which yields duplicate names. A
  // unique list keeps model selection and UI keying deterministic.
  return [...new Set(names)];
}

function isLikelyCodingTask(text = '') {
  return /\b(fix|update|modify|change|edit|implement|create|add|remove|refactor|debug|repair|build|compile|test|typescript|react|component|api|route|database|sql|bug|error|issue|file|code)\b/i.test(String(text));
}

function isLikelySimpleQuestion(text = '') {
  const s = String(text || '').trim();
  return /^(what|which|where|when|who|how)\b/i.test(s) && !isLikelyCodingTask(s);
}

function isVisualReadOnlyRequest(text = '') {
  const raw = String(text || '').toLowerCase().trim();
  if (!raw) return false;
  const s = raw
    // "Do not guess or modify the URL" / "Do not describe the image" constrains
    // the answer; it is not a request to change project files. Only positive
    // clauses count as change work.
    .replace(/\b(?:do not|don't|never|no need to|avoid)\b[^.!?\n]*/g, ' ')
    // Headings such as "Image test:" / "Video test:" label the request, they
    // are not "run the tests" change work.
    .replace(/\b(?:image|video|screenshot|screen|photo|picture|attachment|media)\s+test\s*:/g, ' ')
    .replace(/\btest\s*:/g, ' ');
  const asksToRead = /\b(read|ocr|extract|transcribe|print|show|tell me|find|identify|inspect|what(?:'s| is)|which|list)\b/.test(s);
  const asksToChange = /\b(fix|update|modify|change|edit|implement|create|add|remove|refactor|repair|write|build|test|debug)\b/.test(s);
  const visualWords = /\b(image|screenshot|photo|picture|video|recording|frame|url|text|visible|screen)\b/.test(s);
  return asksToRead && visualWords && !asksToChange;
}

function hasVisualAttachment(attachments = []) {
  return attachments.some(a => a?.kind === 'image' || a?.kind === 'video' || /^image\//i.test(a?.mimeType || '') || /^video\//i.test(a?.mimeType || ''));
}

async function resolveAutoModel(userMessage, attachments = []) {
  const models = await listOllamaModels();
  if (!models.length) throw new Error('Ollama is running but no models are installed. Install qwen3:8b and qwen3-vl:8b (recommended) and retry.');

  const visual = hasVisualAttachment(attachments);
  if (visual) {
    const preferred = [VISION_MODEL, 'qwen3-vl:8b', 'qwen3-vl:8b-instruct', VISION_FALLBACK_MODEL, 'llama3.2-vision'];
    const exact = preferred.find(name => models.some(installed => installed.toLowerCase() === name.toLowerCase()));
    if (exact) return models.find(installed => installed.toLowerCase() === exact.toLowerCase());
    const namedVision = models.find(name => /(vision|vl|llava|moondream|minicpm-v|gemma3)/i.test(name));
    if (namedVision) return namedVision;
    for (const name of models.slice(0, 12)) {
      if (await modelSupportsVisionAsync(name)) return name;
    }
    // No vision model installed: do not abort here. The run can still fall
    // back to media metadata / text-only work; a hard error is raised later
    // only if frames actually need a vision model.
    console.warn('[Agent] No vision-capable Ollama model installed; auto mode continues with a text model.');
  }

  if (isLikelyCodingTask(userMessage)) {
    const qwen = models.find(name => /^qwen3(?::|$)/i.test(name) || /qwen.*coder/i.test(name));
    if (qwen) return qwen;
    const llama = models.find(name => /^llama3\.2(?::|$)/i.test(name));
    if (llama) return llama;
  }

  if (isLikelySimpleQuestion(userMessage)) {
    const llama = models.find(name => /^llama3\.2(?::|$)/i.test(name));
    if (llama) return llama;
  }

  const qwen = models.find(name => /^qwen3(?::|$)/i.test(name) || /qwen.*coder/i.test(name));
  return qwen || models.find(name => /^llama3\.2(?::|$)/i.test(name)) || models[0];
}

export async function runAgentLoop(sessionId, userMessage, model = DEFAULT_MODEL, workspacePath, onEvent, attachments = [], taskId = null) {
  const workspace = path.resolve(workspacePath || process.cwd());
  const stat = await fs.stat(workspace).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`Active workspace not found: ${workspace}`);

  // Optional progress listener (used by the NDJSON streaming endpoint).
  // Listener errors must never break the agent loop itself.
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const emitStep = (info, detail, status) => {
    try { emit({ type: 'step', kind: info.kind, label: info.label, detail: String(detail || '').slice(0, 90), status }); } catch { /* ignore */ }
  };
  const emitThinking = (status, detail) => emitStep({ kind: 'thinking', label: 'Thinking' }, detail, status);
  const thinkSnippet = (msgs) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'user' && String(msgs[i].content || '').trim()) {
        return String(msgs[i].content).replace(/\s+/g, ' ').slice(0, 70);
      }
    }
    return '';
  };

  await db.ensureSession(sessionId, { title: userMessage, workspacePath });
  if (taskId) await db.updateTask(taskId, { status: 'running', startedAt: new Date().toISOString(), error: null });
  emitStep({ kind: 'sdlc', label: 'SDLC' }, 'Discover → Plan → Implement → Verify → Preview', 'done');
  const [projectInstructions, configuredSystemPrompt] = await Promise.all([
    loadProjectInstructions(workspace),
    loadAgentSystemPrompt(workspace)
  ]);
  const history = await db.getHistory(sessionId, 8);
  const attachmentList = Array.isArray(attachments) ? attachments.slice(0, 12) : [];
  // Absolute paths the user typed in their own message (D:\Antony\Temp\shot.png,
  // /home/me/rec.mp4, "D:\My Files\clip.mp4", …) are opened directly and joined
  // to this turn, so "read the image at <path>" works with no browser upload.
  // Only the message text is scanned — model tool arguments never reach here.
  const { attachments: messageAttachments, missing: missingMessageFiles } = await collectMessageAttachments(sessionId, userMessage);
  if (messageAttachments.length) {
    attachmentList.push(...messageAttachments);
    if (attachmentList.length > 12) attachmentList.length = 12;
    emitStep({ kind: 'attachment', label: 'Attachment' }, `opened from message path: ${messageAttachments.map(a => a.name).join(', ')}`, 'done');
  }
  if (missingMessageFiles.length) {
    userMessage = `${userMessage}\n\nNOTE — these files referenced in your message could not be opened on this machine: ${missingMessageFiles.join(', ')}. Tell the user the path is wrong or the file is missing; do not invent its contents.`;
  }
  // Trust the stored bytes over browser MIME/kind before anything decides this
  // is (or is not) a visual task — screen recordings frequently arrive as
  // application/octet-stream.
  for (let i = 0; i < attachmentList.length; i++) {
    attachmentList[i] = await normalizeAttachmentKind(sessionId, attachmentList[i]);
  }
  const storedUserMessage = attachmentList.length
    ? `${userMessage}\n\n[Attachments: ${attachmentList.map(a => `${a.name} (${a.kind})`).join(', ')}]`
    : userMessage;
  if (!taskId) await db.insertMessage({ sessionId, role: 'user', content: storedUserMessage, attachments: attachmentList });

  if (!attachmentList.length && isSimpleStaticHomeTask(userMessage)) {
    emitStep({ kind: 'write', label: 'Write' }, 'index.html, styles.css, script.js', 'running');
    const scaffold = await createStaticHomePage(workspace);
    emitStep({ kind: 'write', label: 'Write' }, 'index.html, styles.css, script.js', 'done');
    const reply = `Created a static home page in the active workspace: ${scaffold.files.join(', ')}. Files that already existed were left unchanged.`;
    await db.insertMessage({ sessionId, taskId, role: 'tool', content: JSON.stringify(scaffold), toolCallJson: JSON.stringify({ name: 'create_static_home_page', args: {} }) });
    await db.insertMessage({ sessionId, taskId, role: 'assistant', content: reply });
    if (taskId) await db.updateTask(taskId, { status: 'done', completedAt: new Date().toISOString(), error: null });
    return { reply, toolExecuted: true, toolCall: { name: 'create_static_home_page', args: {} }, status: 'success', fallbackUsed: true, modelUsed: 'local-template', taskId };
  }

  // Deterministic read-only inspection: do not waste CPU/model time for a task
  // that can be answered from the filesystem directly.
  if (!attachmentList.length && shouldDirectInspect(userMessage)) {
    emitStep({ kind: 'list', label: 'List' }, 'project overview', 'running');
    const info = await inspectProject(workspace);
    emitStep({ kind: 'list', label: 'List' }, 'project overview', 'done');
    const reply = makeFastProjectSummary(info);
    await db.insertMessage({ sessionId, taskId, role: 'assistant', content: reply });
    if (taskId) await db.updateTask(taskId, { status: 'done', completedAt: new Date().toISOString(), error: null });
    return { reply, toolExecuted: true, toolCall: { name: 'inspect_project', args: {} }, status: 'success', taskId };
  }

  if (!attachmentList.length && shouldDirectQuestion(userMessage)) {
    emitStep({ kind: 'list', label: 'List' }, 'answering from project files', 'running');
    const info = await inspectProject(workspace);
    emitStep({ kind: 'list', label: 'List' }, 'answering from project files', 'done');
    const reply = answerSimpleProjectQuestion(userMessage, info);
    await db.insertMessage({ sessionId, taskId, role: 'assistant', content: reply });
    if (taskId) await db.updateTask(taskId, { status: 'done', completedAt: new Date().toISOString(), error: null });
    return { reply, toolExecuted: true, toolCall: { name: 'inspect_project', args: {} }, status: 'success', taskId };
  }

  let modelName = String(model || DEFAULT_MODEL);
  const requestedModel = modelName;
  const originalUserMessage = String(userMessage || '');
  const visualTask = hasVisualAttachment(attachmentList);
  const visualReadOnly = visualTask && isVisualReadOnlyRequest(originalUserMessage);

  if (modelName.toLowerCase() === 'auto') {
    modelName = await resolveAutoModel(userMessage, attachmentList);
    emitThinking('running', `auto-selected ${modelName}`);
  }

  // Visual tasks are handled locally. Images go straight to the selected vision
  // model; videos are sampled into timestamped frames by FFmpeg first. Media is
  // decoded up front: when FFmpeg is missing or fails, prepareImageFrames reports
  // it through `notes` and the turn continues on metadata instead of aborting.
  // This keeps all media on the machine and avoids cloud/API dependencies.
  let visualEvidenceProvided = false;
  if (visualTask) {
    const { images: visualInputs, notes: mediaNotes } = await prepareImageFrames(sessionId, attachmentList);
    if (!visualInputs.length && mediaNotes.length) {
      // Graceful fallback: no frames, but the agent still receives the media
      // metadata and continues with source inspection instead of crashing.
      const fallbackReport = mediaNotes.join('\n\n');
      emitStep({ kind: 'attachment', label: 'Attachment' }, 'frames unavailable — continuing with media metadata', 'done');
      await db.insertMessage({ sessionId, taskId, role: 'tool', content: fallbackReport, toolCallJson: JSON.stringify({ name: 'local_media_metadata_fallback', args: { attachments: attachmentList.map(a => a.id) } }) });
      emitThinking('done', 'media metadata fallback');
      console.warn(`[Vision] metadata fallback: ${fallbackReport}`);
      userMessage = `${userMessage}\n\nMEDIA ANALYSIS FALLBACK (frame extraction unavailable):\n${fallbackReport}\n\nWork from this metadata plus the user's description: inspect the project source, implement the requested change, and state plainly that frame-level visual analysis was not possible.`;
    } else if (!visualInputs.length) {
      throw new Error('No readable image/video frames were produced. Install FFmpeg for video analysis or attach a screenshot.');
    } else {
      if (!(await modelSupportsVisionAsync(modelName))) {
        const candidates = await listOllamaModels();
        const preferred = [VISION_MODEL, 'qwen3-vl:8b', VISION_FALLBACK_MODEL, 'llama3.2-vision'];
        const visionModel = preferred.map(wanted => candidates.find(name => name.toLowerCase() === wanted.toLowerCase())).find(Boolean)
          || candidates.find(name => /(vision|vl|llava|moondream|minicpm-v|gemma3)/i.test(name))
          || (await Promise.all(candidates.slice(0, 12).map(async name => (await modelSupportsVisionAsync(name)) ? name : null))).find(Boolean);
        if (!visionModel) throw new Error('Visual task cannot start: no vision-capable Ollama model is installed. Install qwen3-vl:8b or llama3.2-vision.');
        emitThinking('running', `switching to local vision model ${visionModel}`);
        modelName = visionModel;
      }
      const visualPrompt = [
        'You are the local visual specialist for Agent21.',
        visualReadOnly
          ? 'This is a READ-ONLY visual extraction task. Read the supplied image/video frames carefully and answer the user directly. Extract visible text/URLs exactly; do not guess missing characters or invent a URL. For video, include the frame timestamp when reporting text. Do not invent sections, causes, fixes, or project changes.'
          : 'Analyze the attached screenshots/video frames as evidence for the user software task.',
        'Do not invent details. Distinguish OBSERVED facts from likely causes.',
        'For video frames, infer the interaction sequence from the supplied timestamped frames and call out visible state changes/errors.',
        visualReadOnly
          ? "OUTPUT FORMAT: follow the user's output instructions literally and output nothing else. If they ask for ONLY a URL, print only the URL; if they ask for a URL plus its timestamp, print exactly those; if they specify an exact sentence for the case where nothing is readable, print that sentence verbatim. No preamble, no markdown, no description of the image."
          : 'Return an engineering report with exactly these sections: OBSERVED, LIKELY CAUSE/CLUES, REQUIRED CHANGE, VERIFICATION.',
        `USER TASK: ${String(userMessage || '').slice(0, 12000)}`,
        `ATTACHMENTS: ${attachmentList.map(a => `${a.name} (${a.kind})`).join(', ')}`
      ].join('\n');
      emitStep({ kind: 'attachment', label: 'Attachment' }, `local vision analysis with ${modelName}`, 'running');
      let visualModelUsed = modelName;
      let visualData = null;
      let visualError = null;
      const visionCandidates = [
        modelName,
        VISION_MODEL,
        'qwen3-vl:8b',
        VISION_FALLBACK_MODEL,
        'llama3.2-vision:latest'
      ].filter(Boolean);
      const uniqueVisionCandidates = [...new Map(visionCandidates.map(name => [String(name).toLowerCase(), name])).values()];
      // One shared budget across candidates: several slow models cannot stack
      // their latency on top of each other (0 = run without a time limit).
      const visionDeadline = Number.isFinite(VISION_TIMEOUT_MS) ? Date.now() + VISION_TIMEOUT_MS : Number.POSITIVE_INFINITY;
      const transientVisionRetries = new Set();
      for (let candidateIndex = 0; candidateIndex < uniqueVisionCandidates.length; candidateIndex++) {
        const candidate = uniqueVisionCandidates[candidateIndex];
        const remaining = visionDeadline - Date.now();
        if (remaining <= 1_000) {
          visualError = visualError || new Error(`The vision budget of ${Math.round(VISION_TIMEOUT_MS / 1000)}s was used up before every candidate answered.`);
          break;
        }
        if (!(await modelSupportsVisionAsync(candidate))) continue;
        try {
          emitStep({ kind: 'attachment', label: 'Attachment' }, `trying local vision model ${candidate}`, 'running');
          // Analyze one image/frame per Ollama request. Passing many full-resolution
          // frames in one request is unreliable with local Qwen3-VL/Ollama and can
          // exhaust the multimodal context on 16 GB machines. Sequential calls also
          // preserve video timestamps and make failures diagnosable.
          const frameReports = [];
          const bareSingleImage = visualReadOnly && visualInputs.length === 1;
          for (let index = 0; index < visualInputs.length; index++) {
            const item = visualInputs[index];
            const perCallRemaining = visionDeadline === Infinity ? VISION_TIMEOUT_MS : Math.max(1_000, visionDeadline - Date.now());
            if (perCallRemaining <= 1_000) break;
            const frameLabel = visualInputs.length > 1 ? `FRAME ${index + 1}/${visualInputs.length}: ${item.attachment.name}` : `IMAGE: ${item.attachment.name}`;
            const framePrompt = `${visualPrompt}\n\n${frameLabel}\nAnalyze ONLY this supplied image. If it is one frame from a video, use the filename timestamp as the frame timestamp. Return concrete visible evidence; do not claim to have watched the entire video.`;
            const frameData = await callOllamaChat(candidate, [{ role: 'user', content: framePrompt, images: [item.base64] }], [], false, Math.min(perCallRemaining, VISION_TIMEOUT_MS));
            let frameContent = String(frameData?.message?.content || '').trim();
            if (!frameContent) {
              // Qwen3-VL occasionally answers with reasoning only and no text.
              // One retry with an explicit instruction recovers the answer
              // instead of failing the whole visual turn.
              const retryRemaining = visionDeadline === Infinity ? VISION_TIMEOUT_MS : visionDeadline - Date.now();
              if (retryRemaining > 5_000) {
                const retry = await callOllamaChat(candidate, [{
                  role: 'user',
                  content: `${framePrompt}\nYour previous reply contained no text output. Answer now with the requested text only.`,
                  images: [item.base64]
                }], [], false, Math.min(retryRemaining, VISION_TIMEOUT_MS));
                frameContent = String(retry?.message?.content || '').trim();
              }
            }
            if (!frameContent) throw new Error(`Model ${candidate} returned an empty visual response for ${frameLabel}.`);
            // Read-only single-image requests must be answerable verbatim:
            // "Print ONLY the URL" cannot carry a frame header.
            frameReports.push(bareSingleImage ? frameContent : `\n--- ${frameLabel} ---\n${frameContent}`);
          }
          if (!frameReports.length) throw new Error(`Model ${candidate} produced no visual frame reports.`);
          visualData = { message: { role: 'assistant', content: frameReports.join('\n') } };
          visualModelUsed = candidate;
          break;
        } catch (error) {
          visualError = error;
          // A dropped connection to the local Ollama daemon ("fetch failed" while
          // a model is loading, ECONNRESET, …) is transient. Retry the same
          // model once instead of falling through to a fallback that may itself
          // be unusable on this machine.
          const transient = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed/i.test(String(error?.message || error));
          const key = String(candidate).toLowerCase();
          if (transient && !transientVisionRetries.has(key) && visionDeadline - Date.now() > 30_000) {
            transientVisionRetries.add(key);
            candidateIndex--;
            console.warn(`[Vision] ${candidate} hit a transient Ollama connection error; retrying once: ${error?.message || error}`);
            emitStep({ kind: 'attachment', label: 'Attachment' }, `retrying ${candidate} after a transient connection error`, 'running');
            continue;
          }
          console.warn(`[Vision] ${candidate} failed: ${error?.message || error}`);
        }
      }
      let visualAnalysis = String(visualData?.message?.content || '').trim();
      if (!visualAnalysis) {
        throw new Error(`Local image/video analysis failed. Tried ${uniqueVisionCandidates.join(', ')}. ${visualError?.message || 'No vision-capable local model responded.'}`);
      }
      // Video read-only requests are answered frame by frame, so the raw result
      // is a stack of FRAME i/n reports. Merge them into the single answer the
      // user asked for ("the URL and the timestamp where it appears"). Falls
      // back to the per-frame stack when the merge call fails or times out.
      let mergedReadOnlyAnswer = '';
      if (visualReadOnly && visualInputs.length > 1) {
        try {
          // The merge is a real local model call on a busy CPU: give it the
          // remaining vision budget (capped at 5 min) instead of a tight slice,
          // otherwise a slow merge silently degrades to the per-frame stack.
          const remainingMs = visionDeadline - Date.now();
          if (remainingMs > 30_000) {
            const merged = await callOllamaChat(visualModelUsed, [{
              role: 'user',
              content: [
                'You are finishing a READ-ONLY visual extraction task for Agent21.',
                `USER TASK: ${String(originalUserMessage || '').slice(0, 6000)}`,
                'PER-FRAME FINDINGS (each analyzed separately, filename carries its timestamp):',
                visualAnalysis,
                'Produce the final answer exactly as the user requested: same output format, nothing beyond it. No frame headers, no preamble, no markdown. Only repeat URLs/timestamps that appear in the findings above. If the same text is visible in several frames, report it once with the timestamp of the first frame where it appears and note that it stays visible. If the user specified an exact sentence for the nothing-readable case and no frame found anything, print that sentence verbatim.'
              ].join('\n')
            }], [], false, Math.min(remainingMs, 300_000));
            mergedReadOnlyAnswer = String(merged?.message?.content || '').trim();
          }
        } catch (error) {
          console.warn(`[Vision] read-only frame merge failed: ${error?.message || error}`);
        }
      }
      // Attachments whose frames could not be sampled (missing/broken FFmpeg,
      // unreadable codec) still contribute their metadata as caveats.
      const mediaCaveats = mediaNotes.length ? `\n\nMEDIA CAVEATS (frames unavailable for some attachments):\n${mediaNotes.join('\n')}` : '';
      const visualEvidence = visualAnalysis + mediaCaveats;
      emitStep({ kind: 'attachment', label: 'Attachment' }, `local visual analysis completed with ${visualModelUsed}`, 'done');
      await db.insertMessage({ sessionId, taskId, role: 'tool', content: visualEvidence, toolCallJson: JSON.stringify({ name: 'local_visual_analysis', args: { model: visualModelUsed, attachments: attachmentList.map(a => a.id), caveats: mediaNotes.length } }) });
      emitThinking('done', `${visualModelUsed} visual analysis`);
      if (visualReadOnly) {
        // Read/OCR requests should be answered by the vision model directly. Do
        // not route them into qwen3:8b, do not ask for attachment tools again,
        // and do not turn a simple extraction task into a coding task.
        // Last resort when the merge call could not finish: drop the per-frame
        // banner lines so the answer still reads as the requested output.
        const headerless = visualAnalysis
          .split('\n')
          .filter(line => !/^-{3}\s.+\s-{3}$/.test(line.trim()))
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const reply = mergedReadOnlyAnswer || headerless || visualAnalysis;
        await db.insertMessage({ sessionId, taskId, role: 'assistant', content: reply });
        if (taskId) await db.updateTask(taskId, { status: 'done', completedAt: new Date().toISOString(), error: null });
        return { reply, toolExecuted: false, modelUsed: visualModelUsed, fallbackUsed: visualModelUsed !== modelName, taskId };
      }
      userMessage = `${userMessage}\n\nMANDATORY LOCAL VISUAL EVIDENCE (${visualModelUsed}):\n${visualEvidence}\n\nNow inspect the active project source and implement the requested fix. Do not stop at analysis.`;
      visualEvidenceProvided = true;
    }
    // Keep vision and coding responsibilities separate: Qwen3-VL analyzes the
    // evidence, then Qwen3 8B performs the repository/tool work.
    const installedAfterVision = await listOllamaModels();
    const textAgent = installedAfterVision.find(name => name.toLowerCase() === TEXT_MODEL.toLowerCase())
      || installedAfterVision.find(name => /^qwen3(?::|$)/i.test(name) || /qwen.*coder/i.test(name))
      || installedAfterVision.find(name => /^llama3\.2(?::|$)/i.test(name));
    if (!textAgent) throw new Error('No local text/coding model is installed to continue this task. Install qwen3:8b and retry.');
    modelName = textAgent;
    emitThinking('running', `coding agent: ${modelName}`);
  }

  // Only replay real user/assistant turns. Feeding persisted tool rows back as
  // fake user messages confuses local models and can trigger unnecessary
  // confirmation questions. Keep the context small for faster CPU inference.
  const historyMessages = history.filter(h => h.content && (h.role === 'assistant' || h.role === 'user')).map(h => ({ role: h.role, content: String(h.content).slice(-12000) }));
  // Visual evidence has already been decoded by Qwen3-VL. Coding/debug tasks
  // deliberately continue with the text model (qwen3:8b); never switch the
  // coding model back to a vision model after the visual pass.
  // Visual evidence has already been analyzed above. Do NOT attach the raw
  // images/frames to qwen3:8b: it is a text model and some Ollama versions reject
  // multimodal fields on non-vision models. The coding agent receives the compact
  // visual report instead, which is also much cheaper on a 16 GB machine.
  const userMessageWithAttachments = { role: 'user', content: userMessage };
  let messages = [
    { role: 'system', content: nativeSystemPrompt(workspace, modelName, projectInstructions, configuredSystemPrompt) + attachmentInstruction(attachmentList) },
    ...historyMessages,
    userMessageWithAttachments
  ];
  let executionInfo = null;
  if (attachmentList.length) {
    emitStep({ kind: 'attachment', label: 'Attachment' }, `inspecting ${attachmentList.length} attachment(s)`, 'running');
    for (const attachment of attachmentList) {
      try {
        const inspected = await executeAgentTool('inspect_attachment', { id: attachment.id }, workspace, sessionId, attachmentList);
        await db.insertMessage({ sessionId, taskId, role: 'tool', content: JSON.stringify(inspected), toolCallJson: JSON.stringify({ name: 'inspect_attachment', args: { id: attachment.id } }) });
      } catch (error) {
        emitStep({ kind: 'attachment', label: 'Attachment' }, attachment.name, 'error');
        throw error;
      }
    }
    emitStep({ kind: 'attachment', label: 'Attachment' }, `inspected ${attachmentList.length} attachment(s)`, 'done');
  }
  const tools = modelSupportsTools(modelName) ? ollamaToolDefinitions() : [];
  const deadline = Date.now() + AGENT_TOTAL_TIMEOUT_MS;
  let fallbackUsed = false;

  // Direct Ollama API is used instead of LangChain. Qwen3 8B can be slow on
  // CPU-only machines, so a timed-out Qwen call automatically falls back to
  // the smaller/faster Llama model instead of making the browser wait 135s.
  if (tools.length) {
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const remaining = deadline - Date.now();
      if (remaining < 2_000) throw new Error('Agent execution deadline reached.');
      emitThinking('running', thinkSnippet(messages));
      let data;
      try {
        data = await callOllamaChat(modelName, messages, tools, modelName.toLowerCase().startsWith('deepseek'), Math.min(OLLAMA_TIMEOUT_MS, remaining));
      } catch (error) {
        if (error?.code === 'OLLAMA_TIMEOUT' && !fallbackUsed && FALLBACK_MODEL !== modelName) {
          emitThinking('error', 'timed out');
          fallbackUsed = true;
          modelName = FALLBACK_MODEL;
          messages = [
            { role: 'system', content: nativeSystemPrompt(workspace, modelName, projectInstructions, configuredSystemPrompt) + attachmentInstruction(attachmentList) },
            ...historyMessages,
            userMessageWithAttachments
          ];
          console.warn(`[Agent] ${requestedModel} timed out; falling back to ${modelName}`);
          emitThinking('running', `retrying with ${modelName}`);
          data = await callOllamaChat(modelName, messages, tools, false, Math.min(OLLAMA_TIMEOUT_MS, deadline - Date.now()));
        } else {
          emitThinking('error', 'model call failed');
          throw error;
        }
      }
      emitThinking('done', '');
      const msg = data.message || {};
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.slice(0, 2) : [];
      if (!toolCalls.length) {
        const reply = String(msg.content || '').trim() || 'Task completed.';
        if ((shouldAutonomyRetry(userMessage, reply) || shouldForceImplementationRetry(userMessage, reply, !!executionInfo) || (isImplementationRequest(userMessage) && !executionInfo)) && step < Math.min(MAX_TOOL_STEPS - 1, 4)) {
          emitThinking('done', 'agent asked for information it can inspect; retrying autonomously');
          messages.push(msg, {
            role: 'user',
            content: 'Do not ask me to repeat or provide information you can inspect yourself. You are authorized to inspect the active workspace and attachments, make the best safe assumption, implement the requested task, and validate it. Continue now.'
          });
          continue;
        }
        await db.insertMessage({ sessionId, taskId, role: 'assistant', content: reply });
        if (taskId) await db.updateTask(taskId, { status: 'done', completedAt: new Date().toISOString(), error: null });
        return { reply, toolExecuted: !!executionInfo, modelUsed: modelName, fallbackUsed, taskId, ...(executionInfo || {}) };
      }
      messages.push(msg);
      for (const tc of toolCalls) {
        const name = tc?.function?.name;
        let args = tc?.function?.arguments || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        if (!name) continue;
        const stepInfo = toolEventInfo(name);
        const stepDetail = toolEventDetail(name, args);
        emitStep(stepInfo, stepDetail, 'running');
        let result;
        try {
          result = await executeAgentTool(name, args, workspace, sessionId, attachmentList);
        } catch (toolError) {
          emitStep(stepInfo, stepDetail, 'error');
          const toolMessage = String(toolError?.message || toolError);
          // Filesystem type/path mistakes are recoverable. Feed the error back
          // to the model so it can inspect the correct path rather than asking
          // the user for confirmation or stopping the whole task. This applies
          // on the final step too: the loop bound still guarantees termination,
          // and a single bad path must never abort an otherwise-completed turn.
          if (/ENOENT|ENOTDIR|scandir|not a directory|Path not found|Path is not a directory|Path must stay inside/i.test(toolMessage)) {
            messages.push({ role: 'tool', content: JSON.stringify({ error: toolMessage, recovery: 'The path argument was invalid. Paths must stay inside the active project workspace. List the workspace root, use a workspace-relative path, and continue the requested task. Do not ask the user.' }) });
            continue;
          }
          // A model that echoes an attachment filename while this turn has no
          // (or different) attachments must not abort the whole task.
          if (/Unknown attachment/i.test(toolMessage)) {
            messages.push({ role: 'tool', content: JSON.stringify({ error: toolMessage, recovery: 'No attachment is available to that tool in this turn. Do not retry attachment tools. Answer from the message text and any file path it contains, or state plainly which referenced file is missing. Do not ask the user to re-upload.' }) });
            continue;
          }
          throw toolError;
        }
        emitStep(stepInfo, stepDetail, 'done');
        emitWriteMilestone(emitStep, name, result);
        const resultText = JSON.stringify(result);
        let parsed = result || {};
        executionInfo = { toolCall: { name, args }, codeExecuted: name === 'execute_code' ? args.code : undefined, stdout: parsed.stdout, stderr: parsed.stderr, status: parsed.status || 'success' };
        await db.insertMessage({ sessionId, taskId, role: 'tool', content: resultText, toolCallJson: JSON.stringify({ name, args }) });
        if (name === 'execute_code' || name === 'run_command') {
          await db.insertExecution({ sessionId, taskId, language: name === 'execute_code' ? args.language : 'shell', code: name === 'execute_code' ? args.code : args.command, stdout: parsed.stdout, stderr: parsed.stderr, status: parsed.status });
        }
        messages.push({ role: 'tool', content: resultText });
      }
    }
    const reply = 'I completed the available tool steps. Continue the task if another change is required.';
    await db.insertMessage({ sessionId, taskId, role: 'assistant', content: reply });
    if (taskId) await db.updateTask(taskId, { status: 'done', completedAt: new Date().toISOString(), error: null });
    return { reply, toolExecuted: true, modelUsed: modelName, fallbackUsed, taskId, ...(executionInfo || {}) };
  }

  // Gemma compatibility mode: ask for one compact JSON tool call at a time.
  messages = [{ role: 'system', content: nativeSystemPrompt(workspace, modelName, projectInstructions, configuredSystemPrompt) + attachmentInstruction(attachmentList) + '\nReturn ONLY one JSON object when a tool is needed. Allowed tools: inspect_project, list_files, search_files, read_file, write_file, execute_code, run_command, inspect_attachment, read_attachment, extract_attachment. Use /no_think. Keep responses short.' }, ...historyMessages, userMessageWithAttachments];
  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    emitThinking('running', thinkSnippet(messages));
    const data = await callOllamaChat(modelName, messages, [], false);
    emitThinking('done', '');
    const raw = String(data.message?.content || '');
    const call = extractToolCall(raw);
    if (!call) {
      if ((shouldAutonomyRetry(userMessage, raw) || shouldForceImplementationRetry(userMessage, raw, !!executionInfo)) && step < Math.min(MAX_TOOL_STEPS - 1, 3)) {
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: 'Do not summarize the project or ask for confirmation. The user already authorized the requested implementation. Use the JSON tool format now: inspect the relevant files, edit the requested file(s), and verify the result. Continue until the task is actually implemented.' });
        continue;
      }
      await db.insertMessage({ sessionId, taskId, role: 'assistant', content: raw });
      if (taskId) await db.updateTask(taskId, { status: 'done', completedAt: new Date().toISOString(), error: null });
      return { reply: raw, toolExecuted: !!executionInfo, taskId, ...(executionInfo || {}) };
    }
    const stepInfo = toolEventInfo(call.name);
    const stepDetail = toolEventDetail(call.name, call.args);
    emitStep(stepInfo, stepDetail, 'running');
    let result;
    try {
      result = await executeAgentTool(call.name, call.args || {}, workspace, sessionId, attachmentList);
    } catch (toolError) {
      emitStep(stepInfo, stepDetail, 'error');
      // Recoverable path mistakes: feed the error back so the model can retry
      // with a workspace-relative path instead of failing the whole task.
      const toolMessage = String(toolError?.message || toolError);
      if (/ENOENT|ENOTDIR|scandir|not a directory|Path not found|Path is not a directory|Path must stay inside/i.test(toolMessage)) {
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: `Tool error for ${call.name}: ${toolMessage}. Paths must stay inside the active project workspace. List the workspace root, use a workspace-relative path, and continue the requested task. Do not ask the user.` });
        continue;
      }
      if (/Unknown attachment/i.test(toolMessage)) {
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: `Tool error for ${call.name}: ${toolMessage}. No attachment is available in this turn. Do not retry attachment tools — answer from the message text and any file path it contains, or state plainly which referenced file is missing. Do not ask the user to re-upload.` });
        continue;
      }
      throw toolError;
    }
    emitStep(stepInfo, stepDetail, 'done');
    emitWriteMilestone(emitStep, call.name, result);
    const resultText = JSON.stringify(result);
    executionInfo = { toolCall: call, codeExecuted: call.name === 'execute_code' ? call.args?.code : undefined, stdout: result?.stdout, stderr: result?.stderr, status: result?.status || 'success' };
    await db.insertMessage({ sessionId, taskId, role: 'tool', content: resultText, toolCallJson: JSON.stringify(call) });
    messages.push({ role: 'assistant', content: raw }, { role: 'user', content: `Tool result for ${call.name}: ${resultText}` });
  }
  const reply = 'I completed the available tool steps. Continue the task if another change is required.';    await db.insertMessage({ sessionId, taskId, role: 'assistant', content: reply });
    if (taskId) await db.updateTask(taskId, { status: 'done', completedAt: new Date().toISOString(), error: null });
    return { reply, toolExecuted: !!executionInfo, taskId, ...(executionInfo || {}) };
  }

// Media/timeout helpers exported for the regression checks in
// scripts/check-media.mjs (run with: node scripts/check-media.mjs).
export { parseTimeoutMs, sniffMediaKind, normalizeAttachmentKind, prepareImageFrames, extractVideoFrames, callOllamaChat, collectMessageAttachments, extractFilePathCandidates, isVisualReadOnlyRequest, sanitizeFilePath, ensureSandboxDir };


