// Typed client for the GitHub sync API (connect repo, status, push).
import { BACKEND_URL } from '../config';

export interface GhChangedFile {
  status: string;
  file: string;
}

export interface GhConnection {
  repo: string;
  branch: string;
  defaultBranch?: string;
  private?: boolean;
  login?: string;
  connectedAt: string;
  lastPushAt: string | null;
  lastCommitSha: string | null;
}

export interface GhStatus {
  success: boolean;
  connected: boolean;
  connection: GhConnection | null;
  changedFiles: GhChangedFile[];
  shortstat?: string;
  branch?: string | null;
  error?: string;
}

export interface GhActionResult {
  success: boolean;
  connection?: GhConnection;
  message?: string;
  sha?: string;
  nothingToCommit?: boolean;
  error?: string;
}

/** GET /api/github/status — connection + local changed files. */
export async function fetchGithubStatus(): Promise<GhStatus> {
  const res = await fetch(`${BACKEND_URL}/api/github/status`);
  return res.json();
}

/** POST /api/github/connect — validate + remember owner/name and branch. */
export async function connectGithubRepo(repo: string, branch: string): Promise<GhActionResult> {
  const res = await fetch(`${BACKEND_URL}/api/github/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, branch })
  });
  return res.json();
}

/** POST /api/github/disconnect — forget the connected repo. */
export async function disconnectGithub(): Promise<GhActionResult> {
  const res = await fetch(`${BACKEND_URL}/api/github/disconnect`, { method: 'POST' });
  return res.json();
}

/** POST /api/github/push — commit the workspace subtree and push. */
export async function pushGithubChanges(message: string, force: boolean): Promise<GhActionResult> {
  const res = await fetch(`${BACKEND_URL}/api/github/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, force })
  });
  return res.json();
}
