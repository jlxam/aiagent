// Typed client for the AgentStudio local agent API.
import { BACKEND_URL } from '../config';

export interface AgentAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video' | 'archive' | 'file';
  url?: string;
}

export interface AgentChatResponse {
  success: boolean;
  reply: string;
  toolExecuted: boolean;
  toolCall?: { name: string; args: { language?: string; code?: string; [key: string]: unknown } };
  codeExecuted?: string;
  stdout?: string;
  stderr?: string;
  status?: 'success' | 'error';
  error?: string;
  modelUsed?: string;
  fallbackUsed?: boolean;
  taskId?: string;
}

export interface HistoryRow {
  id?: number;
  session_id: string;
  role?: 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_json?: string | null;
  language?: string;
  code?: string;
  stdout?: string | null;
  stderr?: string | null;
  status?: 'success' | 'error';
  created_at?: string;
  executed_at?: string;
}

export interface SessionHistory {
  success: boolean;
  store?: 'mysql' | 'file';
  session: { session_id: string; created_at: string; workspace_path?: string | null } | null;
  messages: HistoryRow[];
  executions: HistoryRow[];
  tasks?: TaskRow[];
}

export interface TaskRow {
  id: string;
  session_id: string;
  prompt: string;
  model?: string | null;
  workspace_path?: string | null;
  attachments_json?: AgentAttachment[] | string | null;
  position?: number;
  status: 'queued' | 'uploading' | 'running' | 'done' | 'error';
  error_text?: string | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface SessionSummary {
  session_id: string;
  title: string;
  workspace_path?: string | null;
  created_at: string;
  updated_at?: string;
  message_count?: number;
  pending_tasks?: number;
}

export interface AgentStepEvent {
  kind: 'thinking' | 'sdlc' | 'list' | 'read' | 'write' | 'search' | 'run' | 'attachment' | 'preview';
  label: 'Thinking' | 'SDLC' | 'List' | 'Read' | 'Write' | 'Search' | 'Run' | 'Attachment' | 'Preview' | string;
  detail?: string;
  status: 'running' | 'done' | 'error';
}

export interface AgentStreamResult {
  steps: AgentStepEvent[];
  final?: Omit<AgentChatResponse, 'success'> & { success: boolean };
  error?: string;
}

export async function uploadAgentFile(sessionId: string, file: File): Promise<AgentAttachment> {
  const safeName = encodeURIComponent(file.name);
  const request = async (baseUrl: string) => fetch(`${baseUrl}/api/agent/upload?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': safeName,
      'X-Mime-Type': file.type || 'application/octet-stream'
    },
    body: file
  });

  // Normal path is same-origin so Vite can proxy it. If an older/stale Vite
  // proxy returns 404, retry directly against the known local backend. This
  // makes attachment upload resilient while the user is upgrading Agent17.
  let res = await request(BACKEND_URL);
  if ((!res.ok || res.status === 404) && BACKEND_URL !== 'http://127.0.0.1:3002') {
    // If Vite/proxy is stale or points at an older backend, retry the upload
    // directly against the local Agent API before surfacing an attachment error.
    res = await request('http://127.0.0.1:3002');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error || `Upload failed for ${file.name} (HTTP ${res.status}).`);
  }
  return data.attachment as AgentAttachment;
}

export async function sendAgentChatStream(
  sessionId: string,
  message: string,
  model: string | undefined,
  workspacePath: string | undefined,
  onStep: (step: AgentStepEvent) => void,
  attachments: AgentAttachment[] = [],
  taskId?: string
): Promise<AgentStreamResult> {
  const controller = new AbortController();
  // Inactivity guard, not a total-duration cap: the server emits a heartbeat
  // every 5s while a slow vision/video model is decoding frames, so the timer
  // is reset on every chunk and only fires if the connection goes silent.
  // Heavy turns can therefore run well past the old 8 minute ceiling.
  const IDLE_MS = 2 * 60_000;
  let timeoutId = window.setTimeout(() => controller.abort(), IDLE_MS);
  const bumpIdleTimer = () => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => controller.abort(), IDLE_MS);
  };
  try {
    const res = await fetch(`${BACKEND_URL}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message, model, workspacePath, attachments, taskId }),
      signal: controller.signal
    });
    if (!res.ok || !res.body) throw new Error(`stream unavailable (HTTP ${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const out: AgentStreamResult = { steps: [] };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'step' && ev.kind) {
          const step: AgentStepEvent = {
            kind: ev.kind,
            label: ev.label || ev.kind,
            detail: ev.detail,
            status: ev.status || 'done'
          };
          out.steps.push(step);
          onStep(step);
        } else if (ev.type === 'final') {
          out.final = ev;
        } else if (ev.type === 'error') {
          out.error = ev.error || 'Agent request failed.';
        }
      }
    }
    return out;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('The agent connection went silent for more than 2 minutes (no heartbeat from the local engine). The task may still be running — check the project before retrying.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function sendAgentChat(
  sessionId: string,
  message: string,
  model?: string,
  workspacePath?: string,
  attachments: AgentAttachment[] = [],
  taskId?: string
): Promise<AgentChatResponse> {
  const controller = new AbortController();
  // No heartbeats on this non-streaming route, so keep a generous fixed cap
  // that covers the worst server-side turn (vision budget + tool loop).
  const timeoutId = window.setTimeout(() => controller.abort(), 25 * 60_000);
  try {
    const res = await fetch(`${BACKEND_URL}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message, model, workspacePath, attachments, taskId }),
      signal: controller.signal
    });
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();
    let data: AgentChatResponse;
    if (contentType.includes('application/json')) {
      try {
        data = JSON.parse(raw) as AgentChatResponse;
      } catch {
        data = { success: false, reply: '', toolExecuted: false, error: `Backend returned invalid JSON (HTTP ${res.status}).` };
      }
    } else {
      const looksLikeHtml = /<!doctype html|<html[\s>]/i.test(raw);
      data = {
        success: false,
        reply: '',
        toolExecuted: false,
        error: looksLikeHtml
          ? `The Agent API returned an HTML page instead of JSON (HTTP ${res.status}). Restart LocalAgent so Vite proxies /api to the Node backend.`
          : (raw.slice(0, 500) || `Agent server returned HTTP ${res.status}.`)
      };
    }
    if (!res.ok && !data.error) data.error = `Agent server returned HTTP ${res.status}.`;
    return data;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('The agent connection stayed open for more than 25 minutes. The task may still be running on the local engine; check the project before retrying.');
    }
    throw new Error(`Cannot reach the LocalAgent backend at ${BACKEND_URL}. Start the backend with "npm start". ${error?.message || error}`);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function createAgentTask(input: { id: string; sessionId: string; prompt: string; model: string; workspacePath?: string; attachments?: AgentAttachment[]; position?: number }) {
  const res = await fetch(`${BACKEND_URL}/api/agent/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || `Unable to save task (HTTP ${res.status}).`);
  return data;
}

export async function completeAgentTask(taskId: string, sessionId: string, reply: string) {
  const res = await fetch(`${BACKEND_URL}/api/agent/tasks/${encodeURIComponent(taskId)}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, reply }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || `Unable to complete task (HTTP ${res.status}).`);
  return data;
}

export async function updateAgentTask(taskId: string, patch: Record<string, unknown>) {
  const res = await fetch(`${BACKEND_URL}/api/agent/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || `Unable to update task (HTTP ${res.status}).`);
  return data;
}

export async function listAgentSessions(search = ''): Promise<SessionSummary[]> {
  const res = await fetch(`${BACKEND_URL}/api/agent/sessions?limit=60&search=${encodeURIComponent(search)}`);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || `Unable to load sessions (HTTP ${res.status}).`);
  return data.sessions || [];
}

export async function fetchSessionHistory(sessionId: string): Promise<SessionHistory> {
  const res = await fetch(`${BACKEND_URL}/api/agent/history/${encodeURIComponent(sessionId)}`);
  const data: SessionHistory = await res.json();
  return data;
}
