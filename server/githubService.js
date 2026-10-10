// GitHub sync service — connect a workspace to a GitHub remote, report
// changed files, and commit+push them (the "GitHub sync" panel).
//
// WORKSPACE-AWARE: every git command targets the ACTIVE workspace selected in
// Agent Studio (set via setActiveWorkspace on startup and on every workspace
// switch), never a hardcoded path. Repo resolution per workspace:
//   • <workspace>/.git exists          → sync that folder as its own repo.
//   • folder is tracked by an ancestor  → sync the ancestor repo (e.g. the
//                                          main project inside its parent
//                                          repository), staging ONLY this
//                                          workspace's subtree.
//   • otherwise (brand-new folder)      → `git init` an independent repo on
//                                          first push — zero cross-
//                                          contamination either direction.
// Connections are stored PER repo root, so each project keeps its own remote.
//
// The personal access token lives in .env (GITHUB_TOKEN) — never in the
// source tree, never in the connection file, never in the DB, and it is
// stripped from any error text before it reaches the UI.
import { execFile } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import util from 'util';

// execFile (NO shell) is essential on Windows: cmd.exe mangles scp-like git
// URLs (git@github.com:owner/repo.git), breaking SSH auth silently.
const execFilePromise = util.promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Legacy default = the folder the pre-workspace-aware panel always synced:
// this app's parent folder, which holds the sibling projects. server.js
// replaces it with the switcher's active workspace right after init().
const WORKSPACE_DIR = path.resolve(process.env.WORKSPACE_DIR || path.join(__dirname, '..', '..'));
const CONNECTION_PATH = path.join(__dirname, '..', '.data', 'github_connection.json');
const API = 'https://api.github.com';

/* ------------------------- Active workspace state ------------------------- */

let activeWorkspace = WORKSPACE_DIR;

/** Called by server.js whenever the Workspace Switcher changes the active folder. */
export function setActiveWorkspace(dir) {
  if (dir) activeWorkspace = path.resolve(dir);
}

export function getActiveWorkspace() {
  return activeWorkspace;
}

/** Map key for a repo root (case-insensitive on Windows filesystems). */
function normKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function token() {
  return process.env.GITHUB_TOKEN || '';
}

/** Strips the token from any text before it reaches the UI or logs. */
function sanitize(text) {
  const t = token();
  return t ? String(text).split(t).join('***') : String(text);
}

async function gh(pathname) {
  const res = await fetch(`${API}${pathname}`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      'User-Agent': 'agentstudio',
      Accept: 'application/vnd.github+json'
    }
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/* ------------- Connections (persisted per repo root; no token) ------------ */

// File shape: { version: 2, connections: { "<normalized repo root>": conn } }
// Legacy single-connection files ({repo, branch, ...}) migrate automatically.
let connections = {};

export async function init() {
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(CONNECTION_PATH, 'utf-8'));
  } catch {
    raw = null;
  }
  if (raw && typeof raw === 'object' && raw.connections && typeof raw.connections === 'object') {
    connections = raw.connections;
  } else if (raw && typeof raw === 'object' && raw.repo) {
    // Legacy file from the single-repo panel — it belonged to the folder that
    // panel always synced: the parent workspace. Re-key it, keep it working.
    connections = { [normKey(WORKSPACE_DIR)]: raw };
    await saveConnection();
  } else {
    connections = {};
  }
  if (!token()) {
    // Token-transport connections cannot work without a token; SSH connections
    // authenticate with this machine's key and stay valid.
    let changed = false;
    for (const key of Object.keys(connections)) {
      if (connections[key]?.transport === 'token') {
        delete connections[key];
        changed = true;
      }
    }
    if (changed) await saveConnection();
  }
}

function saveConnection() {
  return fs.mkdir(path.dirname(CONNECTION_PATH), { recursive: true })
    .then(() => fs.writeFile(CONNECTION_PATH, JSON.stringify({ version: 2, connections }, null, 2), 'utf-8'))
    .catch(() => {});
}

/** Connection bound to the active workspace's repository root (async: resolves the repo). */
export async function getConnection() {
  const info = await resolveRepoInfo();
  return connections[normKey(info.root)] || null;
}

export async function connectRepo(repo, branch) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo || '')) {
    return { ok: false, error: 'Repository must look like owner/name (e.g. jlxam/Matwithpayment).' };
  }
  branch = (branch || '').trim() || 'main';
  const info = await resolveRepoInfo();

  // 1) Token path (REST API) — also gives us nice repo metadata.
  if (token()) {
    const me = await gh('/user');
    if (!me.ok) {
      return { ok: false, error: `Token invalid or expired (HTTP ${me.status}). Generate a new one at github.com/settings/tokens.` };
    }
    const repoRes = await gh(`/repos/${repo}`);
    if (repoRes.ok) {
      const entry = {
        repo: repoRes.data.full_name,
        branch,
        defaultBranch: repoRes.data.default_branch,
        private: !!repoRes.data.private,
        login: me.data.login,
        transport: 'token',
        connectedAt: new Date().toISOString(),
        lastPushAt: null,
        lastCommitSha: null
      };
      connections[normKey(info.root)] = entry;
      await saveConnection();
      return { ok: true, connection: entry };
    }
    if (repoRes.status !== 404) {
      return { ok: false, error: `GitHub error ${repoRes.status}: ${repoRes.data.message || 'unknown'}` };
    }
    // 404 → the token lacks access to this repo; fall through and try SSH.
  }

  // 2) SSH path — reads/writes private repos once this machine's key is
  //    registered with GitHub (no token scopes needed).
  const sshProbe = await sshRepoAccessible(repo);
  if (sshProbe.ok) {
    const entry = {
      repo,
      branch,
      transport: 'ssh',
      private: true,
      login: null,
      connectedAt: new Date().toISOString(),
      lastPushAt: null,
      lastCommitSha: null
    };
    connections[normKey(info.root)] = entry;
    await saveConnection();
    return { ok: true, connection: entry };
  }

  // Neither path worked — explain both options (with the SSH stderr detail).
  const sshDetail = (sshProbe.stderr || '').trim().split('\n')[0];
  return {
    ok: false,
    error: token()
      ? `Repository "${repo}" is not accessible: the token lacks access to it (grant the repo to your fine-grained token, or use a classic token with the "repo" scope), and SSH from this machine failed too${sshDetail ? ` — ${sshDetail}` : ''}.`
      : `Repository "${repo}" is not accessible: no GITHUB_TOKEN is configured, and SSH failed${sshDetail ? ` — ${sshDetail}` : ''}.`
  };
}

/** Disconnects the repository bound to the ACTIVE workspace only. */
export async function disconnectRepo() {
  const info = await resolveRepoInfo();
  delete connections[normKey(info.root)];
  await saveConnection();
  return { ok: true };
}

/* ------------------------------- Git plumbing ------------------------------ */

/** Runs git with an args ARRAY (never a shell string). */
async function git(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFilePromise('git', args, {
      cwd: opts.cwd || activeWorkspace,
      timeout: 120000,
      ...opts
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: sanitize(e.stderr || e.message) };
  }
}

async function exists(p) {
  return fs.stat(p).then(() => true).catch(() => false);
}

/**
 * Resolves how the ACTIVE workspace relates to git:
 *   { workspace, root, scope, mode: 'own' | 'inside' | 'new', needsInit }
 *  • own      — the folder has its own .git; sync it directly.
 *  • inside   — tracked by the nearest ancestor repo; sync that repo while
 *               staging ONLY this workspace's subtree (scope).
 *  • new      — brand-new folder with no own .git (and nothing tracked in the
 *               ancestor): first push `git init`s an independent repository.
 */
export async function resolveRepoInfo() {
  const ws = path.resolve(activeWorkspace);
  if (await exists(path.join(ws, '.git'))) {
    return { workspace: ws, root: ws, scope: '.', mode: 'own', needsInit: false };
  }
  let ancestor = null;
  let dir = path.dirname(ws);
  for (;;) {
    if (await exists(path.join(dir, '.git'))) {
      ancestor = dir;
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (!ancestor) return { workspace: ws, root: ws, scope: '.', mode: 'new', needsInit: true };
  const rel = path.relative(ancestor, ws);
  if (!rel) return { workspace: ws, root: ancestor, scope: '.', mode: 'own', needsInit: false };
  const scope = rel.split(path.sep).join('/');
  const ls = await git(['ls-files', '--', scope], { cwd: ancestor });
  const tracked = ls.ok && ls.stdout.trim().length > 0;
  if (tracked) return { workspace: ws, root: ancestor, scope, mode: 'inside', needsInit: false };
  // Untracked inside an existing tree → brand-new independent project.
  return { workspace: ws, root: ws, scope: '.', mode: 'new', needsInit: true };
}

/**
 * Non-interactive SSH for git over git@github.com.
 * On Windows we must use the Windows OpenSSH binary — it is the only one that
 * talks to the Windows ssh-agent service (where passphrase-protected keys
 * stay unlocked). Git-bash's bundled ssh cannot reach that agent.
 */
const WINDOWS_SSH = 'C:/Windows/System32/OpenSSH/ssh.exe';
const SSH_COMMAND = (process.platform === 'win32' && existsSync(WINDOWS_SSH))
  ? `${WINDOWS_SSH} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`
  : 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';

function sshEnv() {
  return { ...process.env, GIT_SSH_COMMAND: SSH_COMMAND };
}

/**
 * True if an SSH key on this machine can read the repo (git@github.com).
 * Returns { ok, stderr } so connect failures can explain themselves.
 */
async function sshRepoAccessible(repo) {
  const res = await git(['ls-remote', `git@github.com:${repo}.git`, 'HEAD'], { env: sshEnv() });
  return { ok: res.ok, stderr: res.stderr };
}

/** Files of a not-yet-initialized project, shown as pending "new" changes. */
async function listProjectFiles(root, max = 500) {
  const out = [];
  async function walk(dir, rel) {
    if (out.length >= max) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= max) break;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), r);
      else out.push(r);
    }
  }
  await walk(root, '');
  return out;
}

/**
 * Sync status for the panel: connection bound to this workspace, current
 * branch, changed files (scoped to this workspace's subtree) and a
 * shortstat line. For a brand-new unconnected/uninitialized project the
 * files are listed as `??` so the panel shows what WILL be committed.
 */
export async function getStatus() {
  const info = await resolveRepoInfo();
  const connection = connections[normKey(info.root)] || null;
  const base = {
    connected: !!connection,
    connection,
    workspace: info.workspace,
    repoRoot: info.root,
    mode: info.mode,
    needsInit: info.needsInit,
    scope: info.scope
  };
  if (!connection && !info.needsInit) return { ...base, changedFiles: [], shortstat: '', branch: null };

  if (info.needsInit) {
    // Brand-new project: show its files as pending `??` changes even before a
    // remote is connected, so the panel makes clear what WILL be committed.
    const files = await listProjectFiles(info.root);
    return {
      ...base,
      changedFiles: files.map((file) => ({ status: '??', file })),
      shortstat: '',
      branch: null
    };
  }

  const st = await git(['status', '--porcelain', '--', info.scope], { cwd: info.root });
  const changedFiles = st.ok
    ? st.stdout.split('\n').filter(Boolean).map(line => ({
        status: line.slice(0, 2).trim() || 'M',
        file: line.slice(3).trim()
      }))
    : [];
  const shortstat = await git(['diff', '--shortstat', '--', info.scope], { cwd: info.root });
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: info.root });

  return {
    ...base,
    changedFiles,
    shortstat: (shortstat.stdout || '').trim(),
    branch: branch.stdout.trim()
  };
}

/**
 * Commits the ACTIVE workspace and pushes it to the repository connected for
 * that workspace. Brand-new folders are `git init`-ed first as independent
 * repositories (own remote, never the parent repo's). Staging is scoped to
 * the workspace subtree. force = overwrite remote history.
 */
export async function pushChanges(message, force = false) {
  const info = await resolveRepoInfo();
  const key = normKey(info.root);
  const connection = connections[key] || null;
  if (!connection) {
    return {
      ok: false,
      error: 'No repository connected for this workspace.',
      hint: 'Connect a repository from the GitHub panel — it is bound to this workspace only.'
    };
  }
  const msg = (message || '').trim();
  if (!msg) return { ok: false, error: 'A commit message is required.' };

  // Brand-new project: initialize its OWN repository (independent of any
  // parent repo) before the first commit — never touches the main project.
  if (info.needsInit) {
    const branch = ((connection.branch || 'main').match(/[A-Za-z0-9._/-]+/) || ['main'])[0];
    const init = await git(['init', '-b', branch], { cwd: info.root });
    if (!init.ok) return { ok: false, error: `git init failed: ${init.stderr}` };
  }

  const doPush = async () => {
    const branch = connection.branch || 'main';
    // Token transport pushes over HTTPS with the PAT; SSH transport pushes
    // over git@github.com with this machine's key (no token involved).
    const push = connection.transport === 'ssh'
      ? await git(['push', ...(force ? ['--force'] : []), `git@github.com:${connection.repo}.git`, `HEAD:refs/heads/${branch}`], { cwd: info.root, env: sshEnv() })
      : await git(['push', ...(force ? ['--force'] : []), `https://${token()}@github.com/${connection.repo}.git`, `HEAD:refs/heads/${branch}`], { cwd: info.root });
    if (!push.ok) {
      const detail = (push.stdout + ' ' + push.stderr).trim();
      const hint = /non-fast-forward|rejected/i.test(detail)
        ? ' The remote has history this branch does not share — enable "Force push" to overwrite it.'
        : '';
      return { ok: false, error: `git push failed: ${detail}${hint}` };
    }
    const sha = await git(['rev-parse', '--short', 'HEAD'], { cwd: info.root });
    connection.lastPushAt = new Date().toISOString();
    connection.lastCommitSha = sha.stdout.trim();
    connections[key] = connection;
    await saveConnection();
    return { ok: true, message: `Pushed to ${connection.repo}@${branch}`, sha: connection.lastCommitSha };
  };

  // Unstage everything first so only this workspace's files are committed.
  // (A freshly `git init`-ed repo has an unborn HEAD — reset would fail there.)
  if (!info.needsInit) {
    const reset = await git(['reset'], { cwd: info.root });
    if (!reset.ok) return { ok: false, error: `git reset failed: ${reset.stderr}` };
  }

  const add = await git(['add', '--', info.scope], { cwd: info.root });
  if (!add.ok) return { ok: false, error: `git add failed: ${add.stderr}` };

  // Commit message goes through a temp file (-F) — no shell quoting issues.
  // os.tmpdir() keeps the file out of every repository entirely.
  const tmpMsg = path.join(os.tmpdir(), `agent-commit-msg-${Date.now()}-${process.pid}`);
  await fs.writeFile(tmpMsg, msg, 'utf-8');
  try {
    const commit = await git(['commit', '-F', tmpMsg], { cwd: info.root });
    if (!commit.ok) {
      // git prints several ordinary outcomes on STDOUT (e.g. "nothing to
      // commit") with exit code 1 — surface both streams.
      const detail = (commit.stdout + ' ' + commit.stderr).trim();
      if (/nothing (added )?to commit/i.test(detail)) {
        const head = await git(['rev-parse', '--verify', 'HEAD'], { cwd: info.root });
        if (!head.ok) return { ok: true, message: 'No changes to sync.' };
        // "Nothing to commit" ≠ "nothing to push" — the local branch may
        // still hold unpushed commits (e.g. made from the UI earlier).
        return await doPush();
      }
      return { ok: false, error: `git commit failed: ${detail}` };
    }
  } finally {
    await fs.unlink(tmpMsg).catch(() => {});
  }

  return await doPush();
}
