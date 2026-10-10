import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import util from 'util';
import * as db from './server/db.js';
import agentRouter from './server/routes.js';
import * as orchStore from './server/orchestratorStore.js';
import orchestratorRouter from './server/orchestratorRoutes.js';
import * as githubService from './server/githubService.js';
import githubRouter from './server/githubRoutes.js';
import { sanitizeFilePath, ensureSandboxDir } from './server/agentService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Minimal .env loader (dependency-free): KEY=VALUE lines, # comments.
// Keeps secrets like GITHUB_TOKEN out of the source tree.
try {
    const envSource = await fs.readFile(path.join(__dirname, '.env'), 'utf-8');
    for (const line of envSource.split('\n')) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
} catch { /* no .env file — fine */ }

const execPromise = util.promisify(exec);
const app = express();
app.use(express.json());
app.use(cors());

// Workspace targets this LocalAgent folder
const WORKSPACE_DIR = __dirname;
// Projects normally live beside LocalAgent (for example D:\Antony\React3\Matrimon01).
// LOCALAGENT_PROJECT_ROOT can override this when LocalAgent is installed elsewhere.
const PROJECTS_ROOT = path.resolve(process.env.LOCALAGENT_PROJECT_ROOT || path.dirname(WORKSPACE_DIR));
const WORKSPACE_PARENT = PROJECTS_ROOT;
let activePreviewWorkspace = WORKSPACE_DIR;
// The workspace selected via the Workspace Switcher / project list. Kept
// separate from activePreviewWorkspace, which preview/build handlers repoint
// at <project>/dist or a live-preview root.
let activeWorkspaceRoot = WORKSPACE_DIR;
let livePreview = null; // { projectId, projectPath, port, child, output }

// Resolve a workspace path. Any absolute folder is allowed — the Workspace
// Switcher explicitly supports custom folders outside PROJECTS_ROOT (which now
// only seeds the sidebar project list and the default example root). Security
// is enforced per file, not per workspace: write endpoints still reject any
// filePath that escapes the selected workspace.
function resolveWorkspacePath(candidate) {
    return path.resolve(String(candidate || WORKSPACE_DIR));
}

// Persistence (MySQL ai_studio_db, or the file-store fallback) + agent routes.
await db.init();

// Canonical binary attachment endpoint. Keep this route at the main server level
// as well as the router for compatibility with older AgentStudio/Vite proxy
// processes. The browser sends the file bytes directly (never base64), which
// avoids JSON/body-size problems for screenshots and recorded videos.
app.post('/api/agent/upload', express.raw({ type: () => true, limit: '250mb' }), async (req, res) => {
    try {
        const sessionId = String(req.query?.sessionId || '').trim();
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
        const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
        const dir = path.join(__dirname, '.data', 'attachments', safeSession);
        await fs.mkdir(dir, { recursive: true });
        const storedName = `${id}-${fileName}`;
        await fs.writeFile(path.join(dir, storedName), body);

        console.log(`[Attachment] Stored ${fileName} (${body.length} bytes) for ${sessionId}`);
        return res.status(201).json({
            success: true,
            attachment: { id, name: fileName, mimeType, size: body.length, kind, storedName }
        });
    } catch (error) {
        console.error('[Attachment] Upload failed:', error?.message || error);
        return res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

app.use('/api/agent', agentRouter);

// Application lifecycle orchestrator (Start/Stop Backend & Frontend, Launch).
await orchStore.init();
app.use('/api/orchestrator', orchestratorRouter);

// GitHub sync (connect repo, changed files, commit+push) — workspace-aware:
// git always targets the folder selected in the Workspace Switcher.
await githubService.init();
githubService.setActiveWorkspace(activeWorkspaceRoot);
app.use('/api/github', githubRouter);

// Root status check
app.get('/', (req, res) => {
    res.json({ status: 'Online', message: 'LocalAgent backend server is running!', serverVersion: 'workspace-v5' });
});

// 1. Endpoint for the agent to write/update generated code files
app.post('/api/agent/write-file', async (req, res) => {
    const filePath = req.body?.filePath || req.body?.path; // accept both spellings
    const content = req.body?.content;
    const workspacePath = req.body?.workspacePath;
    try {
        if (!filePath || typeof filePath !== 'string') {
            return res.status(400).json({ success: false, error: 'A "filePath" string is required.' });
        }
        if (typeof content !== 'string') {
            return res.status(400).json({ success: false, error: 'A "content" string is required.' });
        }
        const targetWorkspace = resolveWorkspacePath(workspacePath);
        // Block path traversal outside the selected workspace.
        const requestedPath = path.resolve(targetWorkspace, filePath);
        const workspacePrefix = targetWorkspace.endsWith(path.sep) ? targetWorkspace : targetWorkspace + path.sep;
        if (requestedPath !== targetWorkspace && !requestedPath.startsWith(workspacePrefix)) {
            return res.status(400).json({ success: false, error: 'filePath must stay inside the workspace.' });
        }
        // File Safety & Sandbox Rule: a NEW file targeting src/ or the project
        // root is redirected into <workspace>/.sandbox/ unless the caller
        // declares allowProject (user explicitly asked for the main project).
        const fullPath = await sanitizeFilePath(filePath, targetWorkspace, { allowProject: req.body?.allowProject === true });
        const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
        const redirected = fold(fullPath) !== fold(requestedPath);
        if (redirected) await ensureSandboxDir(path.dirname(fullPath));
        else await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        if (redirected) {
            const finalPath = path.relative(targetWorkspace, fullPath);
            return res.json({ success: true, sandboxRedirect: true, path: finalPath, message: `File Safety Rule: new files in src/ or the project root go to .sandbox/ — wrote ${finalPath} instead of ${filePath}` });
        }
        res.json({ success: true, message: `Successfully wrote ${filePath}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ---- Local workspace explorer ----
// All project selection is resolved by the backend. The browser never needs
// to be trusted with a filesystem path; it sends the project name/key.
async function listWorkspaceProjects() {
    const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const fullPath = path.join(PROJECTS_ROOT, entry.name);
        if (path.resolve(fullPath).toLowerCase() === path.resolve(WORKSPACE_DIR).toLowerCase()) {
            // LocalAgent itself is still selectable and useful as a project.
        }
        projects.push({
            id: entry.name,
            name: entry.name,
            path: fullPath,
            relativePath: entry.name
        });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
}

app.get('/api/workspace/projects', async (req, res) => {
    try {
        const projects = await listWorkspaceProjects();
        res.json({ success: true, root: PROJECTS_ROOT, projects, serverVersion: 'workspace-v5' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message, serverVersion: 'workspace-v5' });
    }
});

async function resolveSelectedProject(req) {
    const requestedId = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    const requestedName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const requestedRelative = typeof req.body?.relativePath === 'string' ? req.body.relativePath.trim() : '';
    const requestedPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    const wanted = requestedId || requestedName || requestedRelative;

    // Resolve by backend-owned directory name first. Comparison is
    // case-insensitive on Windows so Explorer/browser casing cannot matter.
    if (wanted) {
        const projects = await listWorkspaceProjects();
        const wantedKey = process.platform === 'win32' ? wanted.toLowerCase() : wanted;
        const found = projects.find(p => {
            const keys = [p.id, p.name, p.relativePath].filter(Boolean).map(v =>
                process.platform === 'win32' ? String(v).toLowerCase() : String(v)
            );
            return keys.includes(wantedKey);
        });
        if (found) return found;
    }

    // Absolute path fallback — any existing folder outside the default list
    // (a custom project directory) is accepted as a workspace candidate.
    if (requestedPath) {
        const candidate = resolveWorkspacePath(requestedPath);
        const stat = await fs.stat(candidate).catch(() => null);
        if (stat?.isDirectory()) {
            return { id: path.basename(candidate), name: path.basename(candidate), path: candidate, relativePath: path.relative(PROJECTS_ROOT, candidate) };
        }
    }
    return null;
}

async function activateWorkspace(req, res) {
    try {
        const target = await resolveSelectedProject(req);
        if (!target) {
            return res.status(404).json({
                success: false,
                error: `Project folder not found. name=${req.body?.name || '(none)'}`,
                root: PROJECTS_ROOT,
                serverVersion: 'workspace-v5'
            });
        }
        const resolved = resolveWorkspacePath(target.path);
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isDirectory()) {
            return res.status(404).json({ success: false, error: `Folder is not accessible: ${resolved}`, serverVersion: 'workspace-v5' });
        }
        await fs.access(resolved);
        activePreviewWorkspace = resolved;
        activeWorkspaceRoot = resolved;
        githubService.setActiveWorkspace(resolved);
        return res.json({
            success: true,
            serverVersion: 'workspace-v5',
            workspace: {
                id: target.id,
                name: target.name,
                path: resolved,
                relativePath: path.relative(PROJECTS_ROOT, resolved)
            }
        });
    } catch (error) {
        console.error('[Workspace] activation failed:', error?.message || error);
        return res.status(400).json({ success: false, error: error?.message || String(error), root: PROJECTS_ROOT, serverVersion: 'workspace-v5' });
    }
}

// New canonical endpoint plus backwards-compatible alias.
app.post('/api/workspace/activate', activateWorkspace);
app.post('/api/workspace/select', activateWorkspace);

app.get('/api/workspace/health', async (req, res) => {
    try {
        const projects = await listWorkspaceProjects();
        res.json({ success: true, serverVersion: 'workspace-v5', root: PROJECTS_ROOT, projectCount: projects.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message, serverVersion: 'workspace-v5' });
    }
});

app.get('/api/workspace/current', (req, res) => {
    res.json({ success: true, serverVersion: 'workspace-v5', workspaceRoot: PROJECTS_ROOT, localAgent: WORKSPACE_DIR });
});

// GET /api/workspace — the currently active workspace (for the Workspace
// Switcher UI). Defaults to this LocalAgent folder before any selection.
app.get('/api/workspace', (req, res) => {
    const active = path.resolve(activeWorkspaceRoot || WORKSPACE_DIR);
    res.json({
        success: true,
        serverVersion: 'workspace-v5',
        workspace: {
            id: path.basename(active),
            name: path.basename(active),
            path: active,
            relativePath: path.relative(PROJECTS_ROOT, active) || '.'
        },
        workspaceRoot: PROJECTS_ROOT,
        localAgent: WORKSPACE_DIR
    });
});

// POST /api/workspace/switch { newPath, create? } — switch the active workspace
// to an arbitrary folder by path so every app stays isolated in its own
// directory. Any absolute folder is accepted (custom folders outside
// PROJECTS_ROOT included). With create:true a missing folder is created first,
// so a brand-new app can be started from the UI.
app.post('/api/workspace/switch', async (req, res) => {
    try {
        const newPath = typeof req.body?.newPath === 'string' ? req.body.newPath.trim() : '';
        if (!newPath) {
            return res.status(400).json({ success: false, error: 'A "newPath" string is required.' });
        }
        let resolved;
        try {
            resolved = resolveWorkspacePath(newPath);
        } catch (error) {
            return res.status(400).json({ success: false, error: error?.message || String(error), root: PROJECTS_ROOT });
        }
        let stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isDirectory() && req.body?.create === true) {
            await fs.mkdir(resolved, { recursive: true });
            stat = await fs.stat(resolved).catch(() => null);
        }
        if (!stat?.isDirectory()) {
            return res.status(404).json({ success: false, error: `Folder not found: ${resolved}` });
        }
        activePreviewWorkspace = resolved;
        activeWorkspaceRoot = resolved;
        githubService.setActiveWorkspace(resolved);
        return res.json({
            success: true,
            serverVersion: 'workspace-v5',
            workspace: {
                id: path.basename(resolved),
                name: path.basename(resolved),
                path: resolved,
                relativePath: path.relative(PROJECTS_ROOT, resolved)
            }
        });
    } catch (error) {
        return res.status(400).json({ success: false, error: error?.message || String(error) });
    }
});

// POST /api/workspace/open-folder { path } — opens a local folder in the OS
// file manager (Windows Explorer). The path must exist and be a directory.
app.post('/api/workspace/open-folder', async (req, res) => {
    try {
        const target = req.body?.path;
        if (!target || typeof target !== 'string') {
            return res.status(400).json({ success: false, error: 'A "path" string is required.' });
        }
        const full = path.resolve(target);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || !stat.isDirectory()) {
            return res.status(404).json({ success: false, error: `Folder not found: ${full}` });
        }
        if (process.platform === 'win32') {
            // explorer.exe exits non-zero even on success — detach and ignore.
            spawn('explorer.exe', [full], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
            spawn('open', [full], { detached: true, stdio: 'ignore' }).unref();
        } else {
            spawn('xdg-open', [full], { detached: true, stdio: 'ignore' }).unref();
        }
        res.json({ success: true, message: `Opened ${full}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ---- Project preview server -------------------------------------------------
// Preview is always scoped to the selected project. Build/preview actions are
// deterministic and never call Ollama.

// The studio must never preview itself. Serving our own dist/dev server inside
// the preview iframe boots a second full Agent Studio, which renders its own
// preview iframe at the same URL — an infinite recursion of agent prompt boxes.
function isSelfProject(project) {
    const normalize = value => {
        const resolved = path.resolve(String(value || ''));
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return !!project && normalize(project.path) === normalize(WORKSPACE_DIR);
}

const SELF_PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0e0e11; color: #d4d4d9; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .card { max-width: 440px; padding: 24px 28px; border: 1px solid #34343c; border-radius: 14px;
          background: #17181a; text-align: center; }
  h1 { font-size: 15px; margin: 0 0 10px; color: #fff; }
  p { font-size: 13px; line-height: 1.55; margin: 8px 0 0; color: #9a9aa3; }
</style>
</head>
<body>
  <div class="card">
    <h1>Self-preview disabled</h1>
    <p>This project's application is the Agent Studio itself, so it cannot be previewed here — the preview would open a second agent inside this pane, endlessly.</p>
    <p>Select a different project to preview its app.</p>
  </div>
</body>
</html>`;

// Any build of the Studio itself (this repo, or an older AgentNN copy living
// beside it) boots a full agent UI in the pane, and that nested UI renders its
// own preview iframe at the same URL — an infinite recursion of prompt boxes.
// Detection runs on the HTML that is about to be served so it also protects
// old prebuilt copies that never see new frontend code.
function isStudioHtml(html) {
    return /<title[^>]*>[^<]*Agent Studio/i.test(String(html || ''));
}

function sendSelfPreview(res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(SELF_PREVIEW_HTML);
}

async function resolveProjectById(projectId) {
    const projects = await listWorkspaceProjects();
    const wanted = process.platform === 'win32' ? String(projectId || '').toLowerCase() : String(projectId || '');
    const found = projects.find(p => {
        const key = process.platform === 'win32' ? String(p.id).toLowerCase() : String(p.id);
        return key === wanted;
    });
    if (found) return found;

    // Custom workspace fallback: folders switched in from outside PROJECTS_ROOT
    // are not part of the sidebar list. Accept (a) the basename of the
    // currently active workspace, or (b) an absolute folder path as the id.
    const raw = String(projectId || '');
    const projectFromPath = (fullPath) => ({
        id: path.basename(fullPath),
        name: path.basename(fullPath),
        path: fullPath,
        relativePath: path.relative(PROJECTS_ROOT, fullPath)
    });
    const active = path.resolve(activeWorkspaceRoot || WORKSPACE_DIR);
    const base = path.basename(active);
    const matchesActive = process.platform === 'win32' ? base.toLowerCase() === raw.toLowerCase() : base === raw;
    if (raw && matchesActive) return projectFromPath(active);
    if (raw && path.isAbsolute(raw)) {
        const stat = await fs.stat(raw).catch(() => null);
        if (stat?.isDirectory()) return projectFromPath(path.resolve(raw));
    }
    return null;
}

async function findPreviewRoot(project) {
    const candidates = [path.join(project.path, 'dist'), path.join(project.path, 'build'), project.path];
    for (const candidate of candidates) {
        const index = path.join(candidate, 'index.html');
        if (await fs.stat(index).then(() => true).catch(() => false)) return candidate;
    }
    return project.path;
}

function previewUrlFor(project) {
    return `/preview/${encodeURIComponent(project.id)}/`;
}

function npmCommand() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function getFreePort(preferred = 3000) {
    const canUse = await new Promise(resolve => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen(preferred, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (canUse) return preferred;
    return await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

async function stopLivePreview() {
    if (!livePreview?.child) { livePreview = null; return; }
    const child = livePreview.child;
    livePreview = null;
    try {
        if (process.platform === 'win32' && child.pid) {
            await new Promise(resolve => exec(`taskkill /PID ${child.pid} /T /F`, () => resolve()));
        } else if (child.pid) child.kill('SIGTERM');
    } catch {}
}

async function waitForPreviewServer(port, timeoutMs = 60000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500) });
            if (r.ok || r.status < 500) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

async function startLivePreview(project) {
    // Never spawn our own dev script for the studio's own folder: `npm run dev`
    // would launch a second backend/Vite instance of this very app.
    if (isSelfProject(project)) return null;
    if (livePreview?.projectId === project.id && livePreview?.child && !livePreview.child.killed) {
        if (await waitForPreviewServer(livePreview.port, 1500)) return livePreview;
    }
    await stopLivePreview();

    const packageFile = path.join(project.path, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    const scripts = packageJson.scripts || {};
    const script = scripts.dev ? 'dev' : (scripts.start ? 'start' : null);
    if (!script) return null;

    const port = await getFreePort();
    const args = ['run', script];
    // Vite, CRA, Next and most modern dev scripts accept these CLI arguments.
    args.push('--', '--host', '127.0.0.1', '--port', String(port));
    const output = [];
    const child = spawn(npmCommand(), args, {
        cwd: project.path,
        env: { ...process.env, BROWSER: 'none', PORT: String(port), HOST: '127.0.0.1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout?.on('data', d => output.push(String(d).slice(-4000)));
    child.stderr?.on('data', d => output.push(String(d).slice(-4000)));
    child.on('exit', () => { if (livePreview?.child === child) livePreview = null; });
    livePreview = { projectId: project.id, projectPath: project.path, port, child, output };

    const ready = await waitForPreviewServer(port, 60000);
    if (!ready) {
        const details = output.join('\n').slice(-6000);
        await stopLivePreview();
        throw new Error(`Could not start ${script} for ${project.name} on port ${port}.\n${details}`);
    }
    return livePreview;
}

function rewriteDevHtml(html, prefix) {
    // Keep Vite/React dev assets inside the project preview namespace.
    html = html.replace(/(<(?:script|link)[^>]+(?:src|href)=['"])\/(?!\/)/gi, `$1${prefix}`);
    html = html.replace(/(url\()\/(?!\/)/gi, `$1${prefix}`);
    return html;
}

// Return a JSON description of the exact preview that will be shown.
app.get('/api/workspace/preview/:projectId', async (req, res) => {
    try {
        const project = await resolveProjectById(decodeURIComponent(req.params.projectId));
        if (!project) return res.status(404).json({ success: false, error: 'Preview project not found.' });
        let live = null;
        try { live = await startLivePreview(project); } catch (e) {
            // A static preview is still available if the project has build output.
            if (!await fs.stat(path.join(project.path, 'index.html')).then(() => true).catch(() => false)) throw e;
        }
        const previewRoot = live ? project.path : await findPreviewRoot(project);
        activePreviewWorkspace = previewRoot;
        res.json({
            success: true,
            project: { id: project.id, name: project.name, path: project.path },
            previewRoot,
            previewUrl: previewUrlFor(project),
            live: !!live,
            port: live?.port || null,
            built: path.basename(previewRoot).toLowerCase() === 'dist' || path.basename(previewRoot).toLowerCase() === 'build'
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Build the selected project and resolve its preview URL in one deterministic
// operation. No LLM/Ollama call is involved.
app.post('/api/workspace/build-preview', async (req, res) => {
    try {
        const project = await resolveSelectedProject({ body: req.body || {} });
        if (!project) return res.status(404).json({ success: false, error: 'Selected project was not found.' });
        const targetWorkspace = resolveWorkspacePath(project.path);
        const packageFile = path.join(targetWorkspace, 'package.json');
        const indexFile = path.join(targetWorkspace, 'index.html');
        const hasPackage = await fs.stat(packageFile).then(() => true).catch(() => false);
        const hasIndex = await fs.stat(indexFile).then(() => true).catch(() => false);
        let output = '';
        let staticProject = false;

        if (!hasPackage) {
            if (!hasIndex) return res.status(400).json({ success: false, error: 'No package.json or index.html found in the selected project.' });
            staticProject = true;
            output = 'Static HTML project: no npm build required.';
        } else {
            try {
                const result = await execPromise('npm run build', { cwd: targetWorkspace, timeout: 120000, windowsHide: true, maxBuffer: 6 * 1024 * 1024 });
                output = result.stdout || result.stderr || 'Build completed.';
            } catch (error) {
                return res.status(400).json({ success: false, error: error.killed ? 'Build timed out after 120 seconds.' : (error.stderr || error.stdout || error.message) });
            }
        }

        let live = null;
        if (!staticProject) {
            try { live = await startLivePreview(project); } catch (e) {
                // If the dev server cannot start, fall back to compiled output.
            }
        }
        const previewRoot = live ? project.path : await findPreviewRoot(project);
        const previewIndex = path.join(previewRoot, 'index.html');
        if (!await fs.stat(previewIndex).then(() => true).catch(() => false) && !live) {
            return res.status(400).json({ success: false, error: 'Build completed but no previewable application was found.' });
        }
        activePreviewWorkspace = previewRoot;
        res.json({
            success: true,
            output,
            staticProject,
            live: !!live,
            port: live?.port || null,
            project: { id: project.id, name: project.name, path: project.path },
            previewRoot,
            previewUrl: previewUrlFor(project),
            cacheBust: Date.now()
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Serve the selected project's preview. HTML receives a <base> tag so Vite/React
// builds using root-relative /assets URLs continue to work inside the preview.
app.use('/preview/:projectId', async (req, res, next) => {
    try {
        const project = await resolveProjectById(decodeURIComponent(req.params.projectId));
        if (!project) return res.status(404).send('Preview project not found.');
        if (isSelfProject(project)) return sendSelfPreview(res);

        // Prefer the actual application's development server. This makes the
        // middle panel behave like opening the selected project in VS Code and
        // running `npm run dev` / `npm start`.
        let live = livePreview;
        if (!live || live.projectId !== project.id) live = await startLivePreview(project).catch(() => null);
        if (live?.port) {
            const requested = String(req.path || '/');
            const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            const targetPath = requested === '/' ? '/' : requested;
            const options = {
                hostname: '127.0.0.1', port: live.port, path: targetPath + query,
                method: req.method, headers: { ...req.headers, host: `127.0.0.1:${live.port}`, connection: 'close' }
            };
            const proxy = http.request(options, upstream => {
                const contentType = String(upstream.headers['content-type'] || '');
                if (contentType.includes('text/html')) {
                    const chunks = [];
                    upstream.on('data', c => chunks.push(c));
                    upstream.on('end', () => {
                        let html = Buffer.concat(chunks).toString('utf8');
                        if (isStudioHtml(html)) return sendSelfPreview(res);
                        const prefix = `/preview/${encodeURIComponent(project.id)}/`;
                        html = rewriteDevHtml(html, prefix);
                        res.status(upstream.statusCode || 200);
                        Object.entries(upstream.headers).forEach(([k,v]) => {
                            if (['content-length','content-encoding','transfer-encoding'].includes(k)) return;
                            if (v !== undefined) res.setHeader(k, v);
                        });
                        res.setHeader('Cache-Control', 'no-store');
                        res.type('html').send(html);
                    });
                } else {
                    res.status(upstream.statusCode || 200);
                    Object.entries(upstream.headers).forEach(([k,v]) => {
                        if (['content-length','content-encoding','transfer-encoding'].includes(k)) return;
                        if (v !== undefined) res.setHeader(k, v);
                    });
                    upstream.pipe(res);
                }
            });
            proxy.on('error', err => res.status(502).send(`Live preview connection failed: ${err.message}`));
            req.pipe(proxy);
            return;
        }

        // Static fallback for plain HTML or compiled output.
        const previewRoot = await findPreviewRoot(project);
        activePreviewWorkspace = previewRoot;
        const requested = String(req.path || '/').replace(/^\/+/, '') || 'index.html';
        const candidate = path.resolve(previewRoot, requested);
        const prefix = previewRoot.endsWith(path.sep) ? previewRoot : previewRoot + path.sep;
        if (candidate !== previewRoot && !candidate.startsWith(prefix)) return res.status(400).send('Invalid preview path.');
        if (path.extname(candidate).toLowerCase() === '.html' || requested === 'index.html') {
            const exists = await fs.stat(candidate).then(s => s.isFile()).catch(() => false);
            const htmlFile = exists ? candidate : path.join(previewRoot, 'index.html');
            if (!await fs.stat(htmlFile).then(s => s.isFile()).catch(() => false)) return res.status(404).send('Preview index.html not found.');
            let html = await fs.readFile(htmlFile, 'utf8');
            if (isStudioHtml(html)) return sendSelfPreview(res);
            const base = `/preview/${encodeURIComponent(project.id)}/`;
            const baseTag = `<base href="${base}">`;
            if (/<base\s/i.test(html)) html = html.replace(/<base[^>]*>/i, baseTag);
            else html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
            // A <base> tag cannot fix root-absolute URLs like "/assets/index.js" —
            // the iframe would fetch them from the dashboard origin and render a
            // blank page. Rewrite them into the preview namespace, same as the
            // live-proxy path above does for dev-server HTML.
            html = rewriteDevHtml(html, base);
            return res.type('html').send(html);
        }
        return express.static(previewRoot, { extensions: ['html'] })(req, res, next);
    } catch (error) {
        return res.status(400).send(`Preview error: ${error.message}`);
    }
});

// No unscoped /preview fallback: every preview request must identify the
// selected project so a previous project's files can never appear.

// 2. Endpoint to verify code builds properly (POST)
// Fast read-only project inspection endpoint.
app.get('/api/workspace/inspect', async (req, res) => {
    try {
        const targetWorkspace = resolveWorkspacePath(req.query?.path || req.query?.workspacePath);
        const stat = await fs.stat(targetWorkspace).catch(() => null);
        if (!stat?.isDirectory()) return res.status(404).json({ success: false, error: `Workspace not found: ${targetWorkspace}` });
        const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vite', 'coverage']);
        const files = [];
        async function walk(dir, depth, prefix = '') {
            if (depth > 2 || files.length >= 180) return;
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
                if (ignored.has(entry.name)) continue;
                const rel = prefix ? path.join(prefix, entry.name) : entry.name;
                files.push(entry.isDirectory() ? `${rel}/` : rel);
                if (entry.isDirectory()) await walk(path.join(dir, entry.name), depth + 1, rel);
                if (files.length >= 180) break;
            }
        }
        await walk(targetWorkspace, 0);
        const keyFiles = {};
        for (const name of ['package.json','tsconfig.json','vite.config.ts','vite.config.js','README.md']) {
            try { keyFiles[name] = (await fs.readFile(path.join(targetWorkspace, name), 'utf8')).slice(0, 12000); } catch {}
        }
        res.json({ success: true, workspace: targetWorkspace, files, keyFiles });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/agent/verify', async (req, res) => {
    try {
        const targetWorkspace = resolveWorkspacePath(req.body?.workspacePath);
        const packageFile = path.join(targetWorkspace, 'package.json');
        const indexFile = path.join(targetWorkspace, 'index.html');
        const hasPackage = await fs.stat(packageFile).then(() => true).catch(() => false);
        const hasIndex = await fs.stat(indexFile).then(() => true).catch(() => false);

        // Plain HTML/CSS/JS projects have no npm build step. Treat a valid index.html
        // as a successful build so the user can immediately preview the selected app.
        if (!hasPackage) {
            if (!hasIndex) return res.status(400).json({ success: false, error: 'No package.json or index.html found in the selected project.' });
            return res.json({ success: true, output: 'Static HTML project: no npm build required.', staticProject: true });
        }

        const { stdout, stderr } = await execPromise('npm run build', { cwd: targetWorkspace, timeout: 120000, windowsHide: true });
        res.json({ success: true, output: stdout || stderr || 'Build completed.' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.killed ? 'Build timed out after 120 seconds.' : (error.stderr || error.stdout || error.message) });
    }
});

// GET route for testing the verify endpoint directly in browser
app.get('/api/agent/verify', (req, res) => {
    res.json({ success: true, message: 'Verify endpoint is working via GET!' });
});

// Health check for the Ollama engine (model availability etc.)
app.get('/api/agent/health', async (req, res) => {
    try {
        const r = await fetch(process.env.OLLAMA_BASE_URL ? `${process.env.OLLAMA_BASE_URL}/api/tags` : 'http://localhost:11434/api/tags');
        if (!r.ok) throw new Error(`Ollama responded with status: ${r.status}`);
        const data = await r.json();
        // Ollama can list the same model name more than once (several tags on
        // one manifest). The UI keys model options by name, so duplicates must
        // be collapsed here instead of leaking a React duplicate-key warning.
        const models = [...new Set((data.models || []).map(m => m?.name).filter(Boolean))];
        res.json({ success: true, models, store: db.getMode(), ollama: true });
    } catch (error) {
        res.status(502).json({ success: false, error: `Ollama unreachable: ${error.message}`, ollama: false });
    }
});

// Warm a selected model once in the background. This removes the first-token
// model-load penalty from the user's first real task, which is significant on
// CPU-only 16 GB machines. The tiny completion keeps the warm-up cheap.
app.post('/api/agent/warmup', async (req, res) => {
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : 'qwen3:8b';
    const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
        const r = await fetch(`${base}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: 'Reply READY.', stream: false, keep_alive: '30m', think: false, options: { num_ctx: 768, num_predict: 8, temperature: 0 } }),
            signal: controller.signal
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(502).json({ success: false, model, error: data.error || `Ollama ${r.status}` });
        res.json({ success: true, model });
    } catch (error) {
        res.status(504).json({ success: false, model, error: error.name === 'AbortError' ? 'Model warm-up timed out.' : error.message });
    } finally {
        clearTimeout(timer);
    }
});

// 3. Robust Streaming endpoint for local Ollama LLM execution (DeepSeek-R1 / Gemma / Llama)
// Ollama streams NDJSON (one JSON object per line). Lines can be SPLIT across TCP chunk
// boundaries, so we buffer across reads and only parse complete lines. Each token is then
// re-emitted to the browser as an SSE `data:` event.
app.post('/api/agent/generate', async (req, res) => {
    const { model = 'llama3.2:latest', prompt, stream } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ success: false, error: 'A non-empty "prompt" is required.' });
    }

    const controller = new AbortController();
    // If the browser disconnects mid-stream, stop pulling from Ollama.
    // NOTE: listen on res (not req) — in modern Node, req 'close' fires as soon as
    // the request body is consumed, which would abort instantly.
    res.on('close', () => {
        if (!res.writableEnded) controller.abort();
    });

    try {
        const ollamaResponse = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, stream: stream !== false }),
            signal: controller.signal
        });

        if (!ollamaResponse.ok) {
            const errText = await ollamaResponse.text().catch(() => '');
            throw new Error(`Ollama responded with status: ${ollamaResponse.status} ${errText}`.trim());
        }

        // Non-streaming mode: wait for the full completion and return plain JSON.
        if (stream === false) {
            const data = await ollamaResponse.json();
            return res.json({ success: true, text: data.response || '' });
        }

        // --- SSE streaming mode ---
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // in case a proxy sits in front
        res.flushHeaders();

        const sendSSE = (obj) => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };

        const reader = ollamaResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';   // accumulates partial NDJSON lines across chunks
        let fullText = '';
        let doneSent = false;

        const processLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed.response === 'string' && parsed.response.length > 0) {
                    fullText += parsed.response;
                    sendSSE({ text: parsed.response });
                }
                if (parsed.error) {
                    sendSSE({ error: parsed.error });
                }
                if (parsed.done) {
                    doneSent = true;
                    // Final event carries stats + the assembled text for convenience.
                    sendSSE({
                        done: true,
                        text: fullText,
                        total_duration: parsed.total_duration,
                        eval_count: parsed.eval_count
                    });
                }
            } catch {
                // Incomplete or unexpected line — skip rather than kill the stream.
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Only parse COMPLETE lines; keep the trailing partial line in the buffer.
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                processLine(line);
            }
        }

        // Flush any decoder state + trailing partial line (Ollama always ends with \n,
        // but be defensive).
        buffer += decoder.decode();
        if (buffer.trim()) processLine(buffer);

        if (!res.writableEnded) {
            if (!doneSent) sendSSE({ done: true, text: fullText });
            res.end();
        }

    } catch (error) {
        const aborted = error.name === 'AbortError';
        if (!aborted) {
            console.error('[Server Error in /api/agent/generate]:', error.message);
        }
        if (!res.headersSent) {
            res.status(502).json({ success: false, error: error.message });
        } else if (!res.writableEnded) {
            // NOTE: sendSSE is out of scope here (declared inside try), so write directly.
            res.write(`data: ${JSON.stringify({ error: aborted ? 'Client disconnected' : error.message, done: true })}\n\n`);
            res.end();
        }
    }
});

app.listen(3002, '127.0.0.1', () => console.log('[LocalAgent] Backend listening on http://127.0.0.1:3002'));