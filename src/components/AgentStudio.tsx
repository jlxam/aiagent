import React, { useState, useRef, useCallback, useEffect } from 'react';
import { sendAgentChat, sendAgentChatStream, uploadAgentFile, createAgentTask, updateAgentTask, completeAgentTask, fetchSessionHistory, listAgentSessions, type AgentAttachment, type AgentStepEvent, type SessionSummary, type TaskRow } from '../services/agentApi';
import { fetchApplications, toggleService, type OrchestratorApp } from '../services/orchestratorApi';
import { fetchGithubStatus, connectGithubRepo, disconnectGithub, pushGithubChanges, type GhStatus } from '../services/githubApi';
import { BACKEND_URL } from '../config';
import WorkspaceSelector from './WorkspaceSelector';

/** Fallback list if the backend health check is unreachable. */
const FALLBACK_MODELS = ['auto', 'qwen3:8b', 'qwen3-vl:8b', 'llama3.2-vision:latest', 'llama3.2:latest'];

const MOBILE_CONTEXT = `[MOBILE DEVELOPMENT MODE]
Target platforms: Android + iOS. Prefer React Native + Expo + TypeScript unless the existing workspace is already a native Android/iOS project. Keep one shared cross-platform codebase where practical. For Android, verify with the available Android SDK/emulator or Expo tooling. For iOS, verify the shared TypeScript/React Native code on this machine and clearly report if native Xcode/iOS verification requires macOS. Build incrementally, run typecheck/tests/builds, and inspect the resulting UI before claiming success.`;

const TODO_PHASES = [
  { id: 'discover', label: 'Inspect project, attachments, and requirements' },
  { id: 'plan', label: 'Plan the smallest safe implementation' },
  { id: 'implement', label: 'Implement the requested changes' },
  { id: 'verify', label: 'Run typecheck, build, tests, or runtime verification' },
  { id: 'preview', label: 'Refresh preview and validate the result' },
] as const;

/** Extensions we are willing to persist from generated code blocks. */
const WRITEABLE_EXTS = new Set(['html', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'svg']);

const LANG_TO_FILENAME: Record<string, string> = {
  html: 'index.html',
  css: 'styles.css',
  javascript: 'script.js',
  js: 'script.js',
  typescript: 'script.ts',
  ts: 'script.ts',
  json: 'data.json',
  markdown: 'README.md',
  md: 'README.md',
  svg: 'image.svg'
};

/** Strips <think>…</think> reasoning blocks (deepseek-r1) from full output. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Extracts fenced code blocks from model output and infers a filename for each:
 * an explicit hint (an HTML comment like <!-- index.html -->, a CSS/JS comment
 * naming the file, or a filename line right above the fence) wins; otherwise
 * the fence language tag maps to a default name. Returns [{ path, content }]
 * ready to write.
 */
function extractCodeBlocks(rawOutput: string): { path: string; content: string }[] {
  const text = stripThinking(rawOutput);
  const blocks: { path: string; content: string }[] = [];

  const resolveName = (lang: string, code: string, matchIndex: number): string | undefined => {
    const before = text.slice(0, matchIndex).trimEnd().split('\n');
    const lastLine = (before[before.length - 1] || '').trim();
    const firstLine = code.split('\n')[0].trim();

    // 1. HTML comment hint: <!-- index.html -->
    let name = /<!--\s*([\w./-]+)\s*-->/.exec(firstLine)?.[1];
    // 2. CSS/JS comment hint: /* styles.css */ or // script.js
    if (!name) name = /\*\s*([\w./-]+)\s*\*\//.exec(firstLine)?.[1];
    if (!name) name = /^\/\/\s*([\w./-]+)/.exec(firstLine)?.[1];
    // 3. Filename mentioned on the line just above the fence
    if (!name) name = /^[`*#\s]*(?:file:\s*)?([\w-]+\.[a-z]{2,4})[`*#:\s]*$/i.exec(lastLine)?.[1];
    // 4. Fall back to the fence language tag
    if (!name) name = LANG_TO_FILENAME[lang.toLowerCase()];
    // 5. Bare fence (no language tag): sniff the content — small local models
    // like llama3.2 often emit ``` without a tag. Only infer unambiguous docs.
    if (!name) {
      if (/^<!doctype html/i.test(code) || /^<html[\s>]/i.test(code)) return 'index.html';
      if (/^(:root|@media|@import|[.#]?[\w-]+\s*\{)/.test(code)) return 'styles.css';
      if (/^(\/\/|const |let |var |function |console\.)/.test(code)) return 'script.js';
    }
    return name;
  };

  const pushBlock = (lang: string, code: string, matchIndex: number) => {
    const codeTrimmed = code.trim();
    if (!codeTrimmed) return;
    const name = resolveName(lang, codeTrimmed, matchIndex);
    if (!name) return;
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (!WRITEABLE_EXTS.has(ext)) return;
    if (blocks.some(b => b.path === `generated/${name}`)) return;
    blocks.push({ path: `generated/${name}`, content: codeTrimmed + '\n' });
  };

  // Closed fences.
  const fence = /```([a-zA-Z0-9_]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    pushBlock(match[1], match[2], match.index);
  }

  // Unclosed trailing fence (model hit its token limit mid-code) — keep the
  // partial code rather than discarding the whole block.
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    const lastOpen = text.lastIndexOf('```');
    const after = text.slice(lastOpen + 3);
    const langMatch = /^([a-zA-Z0-9_]*)\n?/.exec(after);
    const lang = langMatch?.[1] || '';
    const code = langMatch ? after.slice(langMatch[0].length) : after;
    pushBlock(lang, code, lastOpen);
  }

  // Unfenced fallback: small local models sometimes skip fences entirely and
  // emit a bare HTML document. Only applies when NO fenced blocks were found,
  // so it can never steal content from properly fenced output.
  if (blocks.length === 0) {
    const doc = /<!doctype html[\s\S]*<\/html>|<html[\s\S]*<\/html>/i.exec(text);
    if (doc) blocks.push({ path: 'generated/index.html', content: doc[0] + '\n' });
  }

  return blocks;
}

const FONT = "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const DISPLAY_FONT = "Impact, Haettenschweiler, 'Arial Narrow Bold', 'Arial Narrow', sans-serif";
const MONO = "'JetBrains Mono', 'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, monospace";

/* ---------- Freebuff-style design tokens ---------- */
const C = {
  railBg: '#121315',
  sidebarBg: '#171819',
  feedBg: '#0e0f10',
  cardBg: '#1b1c1d',
  rowBg: '#252729',
  border: '#26262b',
  borderSoft: '#212126',
  text: '#f4f4f5',
  textMid: '#d4d4d8',
  textDim: '#a1a1aa',
  textFaint: '#71717a',
  green: '#4ade80',
  greenSoft: 'rgba(74, 222, 128, 0.12)',
  amber: '#eab308',
  blue: '#60a5fa',
  purple: '#c084fc',
  red: '#f87171',
  mint: '#86efac'
};

/** Timeline icons for the live agent process rows (Freebuff-style light stroke). */
const STEP_ICONS: Record<string, string> = {
  // concave sparkle + companion star — model reasoning ("Thinking" mark)
  thinking: 'M11.5 3.2c.5 4.4 2.5 6.6 7.3 7.6c-4.8 1-6.8 3.2-7.3 7.6c-.5-4.4-2.5-6.6-7.3-7.6c4.8-1 6.8-3.2 7.3-7.6ZM19.8 1.5c.2 2 .9 3 3 3.2c-2.1.2-2.8 1.2-3 3.2c-.2-2-.9-3-3-3.2c2.1-.2 2.8-1.2 3-3.2Z',
  // checklist with dots — the To-dos dropdown header
  todos: 'M8.5 6.5h12M8.5 12h12M8.5 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01',
  // connected nodes — SDLC lifecycle summary
  sdlc: 'M6 7h12M6 17h12M8 4h8v6H8zM8 14h8v6H8zM4 7h2M18 7h2M4 17h2M18 17h2',
  // open folder
  list: 'M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-8.6L9.6 4.6A1 1 0 0 0 8.9 4H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1Z',
  // document
  read: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Zm0 0v4h4M9 12h6M9 16h6',
  // pencil on square
  write: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  // magnifier
  search: 'M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z',
  // terminal prompt inside a rounded square — shell/verification runs
  run: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3.2 5.4L9.9 12l-2.7 2.6M12.6 15h4.4',
  // paperclip — uploaded screenshot/video/image
  attachment: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  // eye — preview refreshed
  preview: 'M2 12s3.64-7 10-7 10 7 10 7-3.64 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'
};

type LogEntry = { text: string; time: string };

/** Chat bubble in the feed (mirrors the agent_messages DB rows). */
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  time: string;
  attachments?: AgentAttachment[];
  taskId?: string;
}

interface QueuedTask {
  id: string;
  prompt: string;
  attachments: AgentAttachment[];
  localFiles: File[];
  model: string;
  project: WorkspaceProject;
  status: 'queued' | 'uploading' | 'running' | 'done' | 'error';
  error?: string;
}

/** Output of a tool execution (mirrors the execution_logs DB row). */
interface ExecutionOutput {
  code?: string;
  stdout?: string;
  stderr?: string;
  status?: 'success' | 'error';
  language?: string;
}

/** A real local project folder (listed live from disk by the backend). */
interface WorkspaceProject {
  id?: string;
  name: string;
  path: string;
  relativePath?: string;
}

/** Fallback if the workspace API is unreachable. */
const FALLBACK_PROJECTS: WorkspaceProject[] = [{ name: 'LocalAgent', path: '' }];

export default function AgentStudio() {
  // Session id — becomes the chat_sessions row in MySQL. “New session” mints
  // a fresh one; each browser tab starts with its own.
  const [sessionId, setSessionId] = useState(() => {
    try { return localStorage.getItem('localagent.activeSessionId') || ('session-' + Date.now()); } catch { return 'session-' + Date.now(); }
  });
  const [prompt, setPrompt] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [lightTheme, setLightTheme] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [taskQueue, setTaskQueue] = useState<QueuedTask[]>([]);
  const queueRef = useRef<QueuedTask[]>([]);
  const processingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  /** Live tool timeline for the in-flight request: Thinking / List / Read / Write… */
  const [agentSteps, setAgentSteps] = useState<AgentStepEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [executionOutput, setExecutionOutput] = useState<ExecutionOutput | null>(null);
  const [rightTab, setRightTab] = useState<'preview' | 'terminal'>('preview');
  const [storeMode, setStoreMode] = useState<'mysql' | 'file' | null>(null);

  /* ----- Orchestrator (app lifecycle dashboard) ----- */
  const [view, setView] = useState<'chat' | 'orchestrator'>('chat');
  const [orchApps, setOrchApps] = useState<OrchestratorApp[]>([]);
  const [orchErrors, setOrchErrors] = useState<Record<number, string>>({});
  const [orchBusy, setOrchBusy] = useState<Record<string, boolean>>({});
  const [orchLoadError, setOrchLoadError] = useState<string | null>(null);

  /* ----- Local workspace projects (sidebar tree, listed live from disk) ----- */
  const [projects, setProjects] = useState<WorkspaceProject[]>(FALLBACK_PROJECTS);
  const [activatingProjectId, setActivatingProjectId] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<WorkspaceProject | null>(() => {
    try { return JSON.parse(localStorage.getItem('localagent.activeProject') || 'null'); } catch { return null; }
  });

  /* ----- GitHub sync ----- */
  const [ghOpen, setGhOpen] = useState(false);
  const [ghStatus, setGhStatus] = useState<GhStatus | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [ghResult, setGhResult] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [repoInput, setRepoInput] = useState('jlxam/Matwithpayment');
  const [branchInput, setBranchInput] = useState('main');
  const [forcePush, setForcePush] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [sessionsToday, setSessionsToday] = useState(0);

  const [selectedModel, setSelectedModel] = useState('auto');
  const [availableModels, setAvailableModels] = useState<string[]>(FALLBACK_MODELS);
  const [modelInfo, setModelInfo] = useState<Record<string, { capabilities?: string[] }>>({});
  const [engineStatus, setEngineStatus] = useState<'checking' | 'warming' | 'online' | 'offline'>('checking');
  const [activeTab, setActiveTab] = useState<'build' | 'plan' | 'mission' | 'skills' | 'mobile'>('build');
  const [mobilePlatform, setMobilePlatform] = useState<'both' | 'android' | 'ios'>('both');
  const [todoOpen, setTodoOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('/preview');
  const [previewReady, setPreviewReady] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [sessionWrittenFiles, setSessionWrittenFiles] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sessionHistoryList, setSessionHistoryList] = useState<SessionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);

  const todoState = React.useMemo(() => {
    const doneKinds = new Set(agentSteps.filter(s => s.status === 'done').map(s => s.kind));
    const runningKinds = new Set(agentSteps.filter(s => s.status === 'running').map(s => s.kind));
    const completed = [
      doneKinds.has('list') || doneKinds.has('read') || doneKinds.has('search') || doneKinds.has('attachment'),
      doneKinds.has('thinking'),
      doneKinds.has('write'),
      doneKinds.has('run'),
      doneKinds.has('preview'),
    ];
    const running = [
      runningKinds.has('list') || runningKinds.has('read') || runningKinds.has('search') || runningKinds.has('attachment'),
      runningKinds.has('thinking'),
      runningKinds.has('write'),
      runningKinds.has('run'),
      runningKinds.has('preview'),
    ];
    return {
      items: TODO_PHASES.map((item, index) => ({ ...item, completed: completed[index], running: running[index] })),
      completedCount: completed.filter(Boolean).length,
    };
  }, [agentSteps]);

  // Guards setState calls after unmount. Reset to true on every (re)mount —
  // React 18 StrictMode runs setup→cleanup→setup in dev, so a plain cleanup
  // would leave the guard false forever and swallow the first health scan.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  /** Last session id whose workspace was restored. loadSession re-runs on
   *  every activeProject change (useCallback dep) — without this gate its
   *  session-workspace override would silently revert a fresh project
   *  selection back to the open session's folder, ping-ponging the backend
   *  across tabs. The workspace is only applied when the SESSION changes. */
  const lastRestoredSessionRef = useRef('');

  const log = useCallback((text: string) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setLogs(prev => [...prev, { text, time }]);
  }, []);

  useEffect(() => {
    try { localStorage.setItem('localagent.activeSessionId', sessionId); } catch {}
  }, [sessionId]);

  const loadSession = useCallback(async (id: string) => {
    setHistoryLoading(true);
    try {
      const data = await fetchSessionHistory(id);
      if (!data.success) return;
      const messages: ChatMessage[] = (data.messages || []).filter((m: any) => m.role === 'user' || m.role === 'assistant').map((m: any) => {
        let attachments: AgentAttachment[] = [];
        try { attachments = Array.isArray(m.attachments_json) ? m.attachments_json : JSON.parse(m.attachments_json || '[]'); } catch {}
        return { role: m.role, content: m.content || '', time: new Date(m.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), attachments };
      });
      if (aliveRef.current) {
        setChatMessages(messages);
        const sessionWorkspace = data.session?.workspace_path || data.tasks?.find((t: TaskRow) => t.workspace_path)?.workspace_path || '';
        const alreadyRestored = lastRestoredSessionRef.current === id;
        lastRestoredSessionRef.current = id;
        if (!alreadyRestored && sessionWorkspace && sessionWorkspace !== activeProject?.path) {
          const restoredProject = { name: sessionWorkspace.split(/[/\\]/).filter(Boolean).pop() || 'Project', path: sessionWorkspace };
          setActiveProject(restoredProject);
          try { localStorage.setItem('localagent.activeProject', JSON.stringify(restoredProject)); } catch {}
          const projectKey = restoredProject.name;
          setPreviewUrl(`/preview/${encodeURIComponent(projectKey)}/index.html`);
        }
        const restored = (data.tasks || []).filter((t: TaskRow) => ['queued','uploading','running','error'].includes(t.status));
        const makeTask = (t: TaskRow): QueuedTask => ({ id: t.id, prompt: t.prompt, attachments: Array.isArray(t.attachments_json) ? t.attachments_json : [], localFiles: [], model: t.model || selectedModel, project: activeProject || { name: (t.workspace_path || sessionWorkspace).split(/[/\\]/).filter(Boolean).pop() || 'Project', path: t.workspace_path || sessionWorkspace }, status: t.status === 'running' || t.status === 'uploading' ? 'queued' : t.status, error: t.error_text || undefined });
        const restoredTasks = restored.map(makeTask);
        setTaskQueue(restoredTasks);
        queueRef.current = restoredTasks;
      }
    } catch (e: any) {
      log(`[History] Unable to restore session: ${e.message || e}`);
    } finally { if (aliveRef.current) setHistoryLoading(false); }
  }, [activeProject, selectedModel, log]);

  useEffect(() => {
    void loadSession(sessionId);
    try { localStorage.setItem('localagent.activeSessionId', sessionId); } catch {}
  }, [sessionId, loadSession]);

  const refreshSessionList = useCallback(async (query = '') => {
    try {
      setHistoryLoading(true);
      setSessionHistoryList(await listAgentSessions(query));
    } catch (e: any) {
      log(`[History] Unable to load previous tasks: ${e.message || e}`);
    } finally {
      if (aliveRef.current) setHistoryLoading(false);
    }
  }, [log]);

  useEffect(() => { void refreshSessionList(); }, [refreshSessionList]);

  // Search the persisted MySQL/file-backed session index as the user types.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(() => { void refreshSessionList(searchQuery); }, 180);
    return () => window.clearTimeout(timer);
  }, [searchOpen, searchQuery, refreshSessionList]);

  const openPreviousSession = useCallback(async (id: string) => {
    if (!id) return;
    // Stop displaying the previous queue immediately; the persisted session
    // loader will restore only tasks belonging to the selected conversation.
    queueRef.current = [];
    setTaskQueue([]);
    setLogs([]);
    setExecutionOutput(null);
    setAgentSteps([]);
    setSessionId(id);
    try { localStorage.setItem('localagent.activeSessionId', id); } catch {}
    setSearchOpen(false);
    // If this is already the active session, force an immediate reload.
    if (id === sessionId) await loadSession(id);
  }, [loadSession, sessionId]);

  /** Sidebar “Daily” badge — sessions created today (live from the store). */
  const fetchDailyStats = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/agent/stats`);
      const data = await res.json();
      if (aliveRef.current && data.success) setSessionsToday(data.sessionsToday ?? 0);
    } catch { /* badge keeps its last value */ }
  }, []);

  useEffect(() => { fetchDailyStats(); }, [fetchDailyStats]);

  /** GitHub status loader (sidebar badge + sync panel). */
  const refreshGithubStatus = useCallback(async () => {
    try {
      const s = await fetchGithubStatus();
      if (!aliveRef.current) return;
      setGhStatus(s);
    } catch { /* keep last status */ }
  }, []);

  useEffect(() => { refreshGithubStatus(); }, [refreshGithubStatus]);

  const openGithubPanel = useCallback(() => {
    setGhError(null);
    setGhResult(null);
    setGhOpen(true);
    refreshGithubStatus();
  }, [refreshGithubStatus]);

  // Quick Action Pills and the composer "Suggestions" row are hidden by
  // default (user request). To restore, uncomment this array and the two
  // marked JSX blocks below.
  // const quickActions = [
  //   { label: 'Inspect project', prompt: 'Inspect this project and summarize the React, TypeScript, Node.js and database structure. Do not modify anything.' },
  //   { label: 'Run build', prompt: 'Run build and show the selected application in Preview.' },
  //   { label: 'Show preview', prompt: 'Show the selected project in Preview.' },
  //   { label: 'Find TODOs', prompt: 'Search this project for TODO and FIXME items and summarize the most relevant ones. Do not modify files.' },
  //   { label: 'Check agent workspace', prompt: 'Which project workspace is active? Report the project name and exact path.' },
  //   { label: 'Create Android + iOS app', prompt: 'Create or adapt this workspace into a React Native + Expo TypeScript application targeting Android and iOS. Follow the mobile SDLC and verify what can be verified locally.' },
  // ];

  /**
   * Pings the backend health endpoint to discover installed Ollama models, so
   * the dropdown always matches what the engine actually has (e.g.
   * deepseek-r1:7b is NOT installed here). Runs on mount and via the rail's
   * gear icon.
   */
  const scanEngine = useCallback(async () => {
    setEngineStatus('checking');
    try {
      const res = await fetch(`${BACKEND_URL}/api/agent/health`);
      if (!res.ok) throw new Error(`health ${res.status}`);
      const data = await res.json();
      if (!aliveRef.current) return;
      if (data.success && Array.isArray(data.models) && data.models.length > 0) {
        setAvailableModels(data.models);
        setModelInfo(data.modelInfo || {});
        setEngineStatus('warming');
        setStoreMode(data.store === 'mysql' ? 'mysql' : data.store === 'file' ? 'file' : null);
        const preferred = data.routing?.text || (data.models.includes('qwen3:8b') ? 'qwen3:8b' : data.models[0]);
        setSelectedModel(prev => prev === 'auto' ? 'auto' : (data.models.includes(prev) ? prev : preferred));
        log(`[Engine] Online — ${data.models.length} local Ollama models: ${data.models.join(', ')}`);
        log(`[Routing] Text/coding: ${data.routing?.text || 'auto'} · Vision: ${data.routing?.vision || 'not installed'} · Vision fallback: ${data.routing?.fallbackVision || 'not installed'}`);
        log(`[Engine] Warming ${preferred} in the background…`);
        log(`[DB] History store: ${data.store === 'mysql' ? 'MySQL (ai_studio_db)' : 'file fallback (install MySQL to persist to ai_studio_db)'}`);
        void fetch(`${BACKEND_URL}/api/agent/warmup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: preferred }) })
          .then(r => r.json())
          .then(w => {
            if (!aliveRef.current) return;
            if (w?.success) { setEngineStatus('online'); log(`[Engine] ${preferred} READY — first task can start immediately.`); }
            else { setEngineStatus('online'); log(`[Engine] Warm-up skipped/failed: ${w?.error || 'unknown error'} — model can still be started on demand.`); }
          })
          .catch(() => { if (aliveRef.current) { setEngineStatus('online'); log('[Engine] Warm-up request failed — model can still be started on demand.'); } });
      } else {
        setEngineStatus('offline');
        log('[Engine] Health check returned no local Ollama models.');
      }
    } catch {
      if (!aliveRef.current) return;
      setEngineStatus('offline');
      log('[Engine] Offline — is the backend (:3002) and Ollama (:11434) running?');
    }
  }, [log]);

  /** Loads registered apps + reconciled live statuses from the orchestrator. */
  const refreshOrchestrator = useCallback(async () => {
    try {
      const apps = await fetchApplications();
      if (!aliveRef.current) return;
      setOrchApps(apps);
      setOrchLoadError(null);
    } catch (e: any) {
      if (!aliveRef.current) return;
      setOrchLoadError(`Orchestrator API unreachable: ${e.message}`);
    }
  }, []);

  // Initial fetch so the sidebar badge shows live RUNNING counts.
  useEffect(() => { refreshOrchestrator(); }, [refreshOrchestrator]);

  /** Orchestrator cards filtered down to the active workspace only — the
   *  registered app whose service paths ARE the workspace wins first (e.g.
   *  "LocalAgent Studio" for D:\Antony\React3\Agent27), then a normalized
   *  name match ("LocalAgent" ↔ "LocalAgent Studio"), so the view never
   *  lists unrelated model cards. */
  const activeOrchApps = React.useMemo(() => {
    const normPath = (p: string) => (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wsPath = normPath(activeProject?.path || '');
    const wsName = normName((activeProject?.name || '').trim());
    if (!wsPath && !wsName) return [];
    if (wsPath) {
      const byPath = orchApps.filter(a => normPath(a.backend_path) === wsPath || normPath(a.frontend_path) === wsPath);
      if (byPath.length) return byPath;
    }
    if (!wsName) return [];
    return orchApps.filter(a => {
      const n = normName(a.name);
      return n === wsName || n.includes(wsName) || wsName.includes(n);
    });
  }, [orchApps, activeProject?.path, activeProject?.name]);

  // Poll while the orchestrator view is open (statuses are reconciled server-side).
  useEffect(() => {
    if (view !== 'orchestrator') return;
    refreshOrchestrator();
    const t = setInterval(refreshOrchestrator, 5000);
    return () => clearInterval(t);
  }, [view, refreshOrchestrator]);

  /** Lists the real project folders next to this workspace (live from disk). */
  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/workspace/projects`);
      if (!res.ok) throw new Error(`projects ${res.status}`);
      const data = await res.json();
      if (!aliveRef.current) return;
      if (data.success && Array.isArray(data.projects) && data.projects.length > 0) {
        setProjects(data.projects);
        setActiveProject(prev => {
          if (prev) {
            const matched = data.projects.find((p: WorkspaceProject) => (p.id || p.name).toLowerCase() === (prev.id || prev.name).toLowerCase());
            if (matched) return matched;
          }
          return null;
        });
      }
    } catch { /* keep fallback list */ }
  }, []);

  useEffect(() => {
    fetchProjects();
    const timer = window.setInterval(fetchProjects, 8000);
    return () => window.clearInterval(timer);
  }, [fetchProjects]);

  useEffect(() => {
    if (!activeProject?.path) return;
    const key = activeProject.id || activeProject.name;
    setPreviewUrl(`/preview/${encodeURIComponent(key)}/index.html`);
    // The iframe only renders once previewReady is true. Probe the preview right
    // after (re)activation so selecting a project shows it immediately instead of
    // leaving the middle panel stuck on “Sandbox Preview Idle” until Build /
    // Show preview is used.
    fetch(`/preview/${encodeURIComponent(key)}/index.html`, { method: 'HEAD', cache: 'no-store' })
      .then(p => { if (aliveRef.current && p.ok) setPreviewReady(true); })
      .catch(() => { /* stays Idle; Show preview / Build will retry */ });
    fetch(`${BACKEND_URL}/api/workspace/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeProject.id || activeProject.name, name: activeProject.name, relativePath: activeProject.relativePath, path: activeProject.path })
    }).catch(() => {});
  }, [activeProject?.id, activeProject?.name, activeProject?.path, activeProject?.relativePath]);

  /** Reconcile the UI with the backend's active workspace. The backend is
   *  the real agent/GitHub target, so on disagreement this ADOPTS the backend
   *  state instead of pushing — two open tabs that selected different folders
   *  otherwise fought every tick (observed as the backend flapping between
   *  Agent27 and LocalAgent). Fresh local selections are protected by a 10s
   *  guard so an in-flight activate POST is never reverted. */
  const lastLocalSelectRef = useRef(0);
  const reconcileBackendWorkspace = useCallback(async (project: WorkspaceProject | null) => {
    if (!project?.path) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/workspace`);
      if (!res.ok) return;
      const data = await res.json();
      const backendPath: string | undefined = data?.workspace?.path;
      if (!backendPath) return;
      const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      if (norm(backendPath) === norm(project.path)) return;
      if (Date.now() - lastLocalSelectRef.current < 10000) return; // local click in flight
      const fromList = projects.find(p => norm(p.path || '') === norm(backendPath));
      setActiveProject(fromList || { name: backendPath.split(/[\\/]/).filter(Boolean).pop() || 'Project', path: backendPath });
      log(`[Workspace] Backend workspace was ${backendPath}; UI synced to it.`);
    } catch { /* next tick retries */ }
  }, [log, projects]);

  useEffect(() => {
    void reconcileBackendWorkspace(activeProject);
    const timer = window.setInterval(() => { void reconcileBackendWorkspace(activeProject); }, 8000);
    return () => window.clearInterval(timer);
  }, [activeProject, reconcileBackendWorkspace]);

  /** Makes a local project the active AI workspace. The UI switches immediately; the backend then validates/resolves it. */
  const selectProject = useCallback(async (project: WorkspaceProject) => {
    if (!project.path) {
      log(`[Workspace] ${project.name} has no local path.`);
      return;
    }
    lastLocalSelectRef.current = Date.now(); // protect this click from adopt-reverts
    const key = project.id || project.name;
    // Optimistic activation makes the workspace usable immediately even if an older backend
    // is still restarting. The backend response, when available, replaces it with the canonical path.
    setActivatingProjectId(key);
    setActiveProject(project);
    try { localStorage.setItem('localagent.activeProject', JSON.stringify(project)); } catch {}
    setSessionId('session-' + Date.now());
    setChatMessages([]);
    setLogs([]);
    setSessionWrittenFiles([]);
    setExecutionOutput(null);
    setPrompt('');
    setPreviewReady(false);
    setPreviewUrl(`/preview/${encodeURIComponent(project.id || project.name)}/index.html`);
    setPreviewKey(k => k + 1);
    log(`[Workspace] ACTIVE → ${project.name}`);
    log(`[Workspace] Agent path → ${project.path}`);

    try {
      const res = await fetch(`${BACKEND_URL}/api/workspace/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: project.id || project.name, name: project.name, relativePath: project.relativePath })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.workspace?.path) {
        setActiveProject(data.workspace);
        setPreviewUrl(`/preview/${encodeURIComponent(data.workspace.id || data.workspace.name)}/index.html`);
        try { localStorage.setItem('localagent.activeProject', JSON.stringify(data.workspace)); } catch {}
        log(`[Workspace] Backend confirmed → ${data.workspace.path}`);
      } else {
        log(`[Workspace] Backend validation returned ${res.status}; continuing with the trusted project path.`);
      }
    } catch (e: any) {
      log(`[Workspace] Backend validation unavailable; continuing locally. ${e.message || e}`);
    } finally {
      if (aliveRef.current) setActivatingProjectId(null);
    }
  }, [log]);

  /** Opens a project's local folder in the OS file manager (Explorer). */
  const openProjectFolder = useCallback(async (project: WorkspaceProject) => {
    if (!project.path) {
      log(`[Files] No local path known for “${project.name}”.`);
      return;
    }
    try {
      const res = await fetch(`${BACKEND_URL}/api/workspace/open-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: project.path })
      });
      const data = await res.json();
      if (data.success) {
        log(`[Files] Opened ${project.name} in Explorer — ${project.path}`);
      } else {
        log(`[Files] Error: ${data.error}`);
      }
    } catch (e: any) {
      log(`[Files] Error: ${e.message || e}`);
    }
  }, [log]);

  /* ----- GitHub sync actions ----- */
  const handleGithubConnect = async () => {
    setGhBusy(true);
    setGhError(null);
    setGhResult(null);
    try {
      const r = await connectGithubRepo(repoInput.trim(), branchInput.trim());
      if (!r.success || r.error) {
        setGhError(r.error || 'Connect failed.');
        return;
      }
      log(`[GitHub] Connected ${r.connection?.repo} @ ${r.connection?.branch}`);
      await refreshGithubStatus();
    } catch (e: any) {
      setGhError(e.message || 'Connect failed.');
    } finally {
      setGhBusy(false);
    }
  };

  const handleGithubDisconnect = async () => {
    setGhBusy(true);
    try {
      await disconnectGithub();
      log('[GitHub] Repository disconnected.');
      setGhStatus(prev => (prev ? { ...prev, connected: false, connection: null, changedFiles: [] } : prev));
    } finally {
      setGhBusy(false);
    }
  };

  const handleGithubPush = async () => {
    setGhBusy(true);
    setGhError(null);
    setGhResult(null);
    try {
      const r = await pushGithubChanges(commitMsg.trim(), forcePush);
      if (!r.success || r.error) {
        setGhError(r.error || 'Push failed.');
        await refreshGithubStatus();
        return;
      }
      const line = r.nothingToCommit ? (r.message || 'Nothing to commit.') : `${r.message}${r.sha ? ` · ${r.sha}` : ''}`;
      setGhResult(line);
      setCommitMsg('');
      log(`[GitHub] ${line}`);
      await refreshGithubStatus();
    } catch (e: any) {
      setGhError(e.message || 'Push failed.');
    } finally {
      setGhBusy(false);
    }
  };

  /** Start/Stop one service of one registered app. */
  const handleOrchToggle = useCallback(async (app: OrchestratorApp, kind: 'backend' | 'frontend') => {
    const busyKey = `${app.id}_${kind}`;
    setOrchBusy(prev => ({ ...prev, [busyKey]: true }));
    try {
      const result = await toggleService(app.id, kind);
      if (result.error) {
        setOrchErrors(prev => ({ ...prev, [app.id]: result.error as string }));
      } else {
        setOrchErrors(prev => { const next = { ...prev }; delete next[app.id]; return next; });
        log(`[Orchestrator] ${app.name} · ${kind}: ${result.message || result.status}`);
      }
      await refreshOrchestrator();
    } catch (e: any) {
      setOrchErrors(prev => ({ ...prev, [app.id]: e.message || 'Toggle failed' }));
    } finally {
      setOrchBusy(prev => ({ ...prev, [busyKey]: false }));
    }
  }, [log, refreshOrchestrator]);

  /** Opens the app's frontend in a new browser tab (needs RUNNING frontend). */
  const launchApp = async (app: OrchestratorApp) => {
    if (app.frontend_status !== 'RUNNING') return;
    const url = `http://localhost:${app.frontend_port}`;
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store' });
    } catch {
      // The browser may block CORS checks; the actual tab can still load.
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Scan the engine and surface pre-existing generated files on mount.
  useEffect(() => {
    scanEngine();
    (async () => {
      try {
        const target = activeProject?.id || activeProject?.name;
        if (target) {
          const p = await fetch(`/preview/${encodeURIComponent(target)}/index.html`, { method: 'HEAD', cache: 'no-store' });
          if (aliveRef.current && p.ok) setPreviewReady(true);
        }
      } catch { /* sandbox stays idle */ }
    })();
  }, [scanEngine]);

  /** Reloads the sandbox iframe and logs it. Also revives an Idle panel when the
   * preview URL has become reachable again (e.g. backend or dev server restarted). */
  const reloadPreview = useCallback(() => {
    setPreviewKey(k => k + 1);
    log('[Preview] Sandbox reloaded from disk.');
    if (!previewUrl || previewUrl === '/preview') return;
    fetch(previewUrl, { method: 'HEAD', cache: 'no-store' })
      .then(p => { if (aliveRef.current) setPreviewReady(p.ok); })
      .catch(() => { /* keep current state */ });
  }, [log, previewUrl]);

  /** Clears the session: new sessionId, cleared chat/logs/output, engine re-scan. */
  const startNewSession = useCallback(() => {
    setLogs([]);
    setSessionWrittenFiles([]);
    setPrompt('');
    setChatMessages([]);
    setExecutionOutput(null);
    setSessionId('session-' + Date.now());
    try { localStorage.removeItem('localagent.activeSessionId'); } catch {}
    scanEngine();
    fetchDailyStats();
    log('[Session] New session started — history cleared.');
  }, [log, scanEngine, fetchDailyStats]);

  // Keep the chat feed pinned to the newest message while the agent works.
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [chatMessages, isBuilding, agentSteps]);

  /** Wall-clock start of the in-flight agent request, for the "Working for Ns" badge. */
  const workStartRef = useRef<number>(Date.now());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /** Prompt box grows with its content (64–220px) like the reference composer. */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 64), 220)}px`;
  }, [prompt]);

  /** Writes extracted code blocks via the backend's write-file endpoint. */
  const writeGeneratedFiles = async (rawOutput: string, project: WorkspaceProject | null = activeProject): Promise<string[]> => {
    const blocks = extractCodeBlocks(rawOutput);
    const written: string[] = [];
    for (const block of blocks) {
      try {
        const res = await fetch(`${BACKEND_URL}/api/agent/write-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: block.path, content: block.content, workspacePath: project?.path })
        });
        if (res.ok) written.push(block.path);
      } catch {
        // Non-fatal: skip this file, others still get written.
      }
    }
    return written;
  };

  const updateQueueTask = (id: string, patch: Partial<QueuedTask>) => {
    queueRef.current = queueRef.current.map(item => item.id === id ? { ...item, ...patch } : item);
    setTaskQueue(queueRef.current);
  };

  /** Upsert one row into the live status timeline. Used by the streamed backend
   *  steps (uploading/analyzing/writing) and by the local stages this UI owns
   *  (attachment upload, build verification, preview refresh), so every
   *  milestone stays visible while the task runs. */
  const pushStep = (step: AgentStepEvent) => {
    setAgentSteps(prev => {
      const idx = prev.findIndex(s => s.kind === step.kind && (s.detail || '') === (step.detail || ''));
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...step };
        return next;
      }
      return [...prev, { ...step }];
    });
  };

  const persistLocalAssistant = async (taskId: string, content: string) => {
    try { await completeAgentTask(taskId, sessionId, content); void refreshSessionList(); } catch (e: any) { log(`[History] Could not save agent reply: ${e.message || e}`); }
  };

  const fileKind = (file: File): AgentAttachment['kind'] => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (/\.(zip|tar|gz|tgz|7z|rar)$/i.test(file.name)) return 'archive';
    return 'file';
  };

  const isVisionModel = (name: string) => {
    const info = modelInfo[name];
    return Boolean(info?.capabilities?.some(c => /vision/i.test(c))) || /(vision|vl|llava|moondream|minicpm-v|gemma3)/i.test(name);
  };

  const refreshPreviewFast = useCallback(async (project: WorkspaceProject | null) => {
    if (!project?.id && !project?.name) return;
    const target = project.id || project.name;
    try {
      // First try the already-running preview: this is effectively instant and
      // avoids rebuilding the project just to show edits made by the agent.
      const currentPath = `/preview/${encodeURIComponent(target)}/index.html`;
      const probe = await fetch(`${currentPath}?v=${Date.now()}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
      if (probe?.ok) {
        setPreviewUrl(`${currentPath}?v=${Date.now()}`);
        setPreviewReady(true);
        setPreviewKey(k => k + 1);
        setRightTab('preview');
        return;
      }
      // If no preview server exists yet, ask the local backend to prepare one.
      // This is deterministic and does not consume an Ollama call.
      const res = await fetch(`${BACKEND_URL}/api/workspace/preview/${encodeURIComponent(target)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setPreviewUrl(`/preview/${encodeURIComponent(data.project?.id || target)}/index.html?v=${Date.now()}`);
        setPreviewReady(true);
        setPreviewKey(k => k + 1);
        setRightTab('preview');
      }
    } catch {
      // Preview is best-effort; never delay task completion because of it.
    }
  }, []);

  const processAgentTask = async (task: QueuedTask) => {
    const currentPrompt = task.prompt;
    let currentAttachments = task.attachments;
    const taskProject = task.project;
    const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setIsBuilding(true);
    setAgentSteps([]);
    workStartRef.current = Date.now();

    try {
      if (task.localFiles.length > 0 && currentAttachments.length === 0) {
        updateQueueTask(task.id, { status: 'uploading' });
        void updateAgentTask(task.id, { status: 'uploading' }).catch(() => {});
        const uploadDetail = `uploading media to Agent backend (${task.localFiles.length} file(s))`;
        pushStep({ kind: 'attachment', label: 'Attachment', detail: uploadDetail, status: 'running' });
        const uploaded: AgentAttachment[] = [];
        for (const file of task.localFiles) {
          log(`[Attachment] Uploading ${file.name} (${Math.ceil(file.size / 1024)} KB)…`);
          uploaded.push(await uploadAgentFile(sessionId, file));
        }
        pushStep({ kind: 'attachment', label: 'Attachment', detail: uploadDetail, status: 'done' });
        currentAttachments = uploaded;
        updateQueueTask(task.id, { attachments: uploaded, status: 'running' });
        void updateAgentTask(task.id, { attachments: uploaded, status: 'running' }).catch(() => {});
        setChatMessages(prev => prev.map(m => m.taskId === task.id ? { ...m, attachments: uploaded } : m));
      } else {
        updateQueueTask(task.id, { status: 'running' });
        void updateAgentTask(task.id, { status: 'running' }).catch(() => {});
      }
      log(`[Agent] Processing queued task with ${task.model}…`);
      // Local build/preview actions must never invoke Ollama. The quick-action
      // button used to send "Run build" through the agent, which could time out
      // even though building and previewing are deterministic workspace operations.
      const statusQuestion = currentPrompt.trim().toLowerCase();
      const wantsBuild = /\b(run|start|execute|do)\b.*\b(build|compile|type[- ]?check)\b/i.test(currentPrompt);
      const wantsPreview = /\b(preview|live preview|show preview|open preview|view preview|render preview)\b/i.test(currentPrompt);
      if (wantsBuild && wantsPreview || /^\s*(run build|build|run the build)\s*$/i.test(currentPrompt)) {
        const target = taskProject?.id || taskProject?.name;
        if (!target) throw new Error('Select a project folder before running the build.');
        log(`[Build] Building ${taskProject.name} and preparing its preview — no Ollama call.`);
        pushStep({ kind: 'sdlc', label: 'SDLC', detail: 'Verify → Preview', status: 'running' });
        pushStep({ kind: 'run', label: 'Run', detail: 'build / verification', status: 'running' });
        try {
          const buildRes = await fetch(`${BACKEND_URL}/api/workspace/build-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: target, name: taskProject.name, path: taskProject.path })
          });
          const buildData = await buildRes.json().catch(() => ({}));
          if (!buildRes.ok || !buildData.success) {
            throw new Error(buildData.error || `Build failed (HTTP ${buildRes.status}).`);
          }
          const url = `/preview/${encodeURIComponent(buildData.project?.id || taskProject.id || taskProject.name)}/index.html?v=${buildData.cacheBust || Date.now()}`;
          setPreviewUrl(url);
          setPreviewReady(true);
          setPreviewKey(k => k + 1);
          setRightTab('preview');
          pushStep({ kind: 'run', label: 'Run', detail: 'build / verification', status: 'done' });
          pushStep({ kind: 'preview', label: 'Preview', detail: 'updated', status: 'done' });
          pushStep({ kind: 'sdlc', label: 'SDLC', detail: 'Verify → Preview', status: 'done' });
          log(`[Build] ${buildData.staticProject ? 'Static project ready' : 'Build completed'}: ${taskProject.name}.`);
          log(`[Preview] Showing ${taskProject.name} in the middle panel → ${buildData.previewUrl}`);
          const buildReply = `${buildData.staticProject ? 'Static project is ready' : 'Build completed successfully'} for ${taskProject.name}.\n\nPreview is now open in the middle panel.`;
          setChatMessages(prev => [...prev, { role: 'assistant', content: buildReply, time: now() }]);
          await persistLocalAssistant(task.id, buildReply);
        } catch (err: any) {
          pushStep({ kind: 'run', label: 'Run', detail: 'build / verification', status: 'error' });
          pushStep({ kind: 'sdlc', label: 'SDLC', detail: 'Verify → Preview', status: 'error' });
          log(`[Build] Error: ${err.message || err}`);
          const buildError = `Build/preview error for ${taskProject.name}.\n\n${err.message || err}`;
          setChatMessages(prev => [...prev, { role: 'assistant', content: buildError, time: now() }]);
          void updateAgentTask(task.id, { status: 'error', error: buildError }).catch(() => {});
        }
        return;
      }

      // Preview commands are UI actions, not agent tasks. Never wake Ollama just
      // to display files that already exist in the active workspace.
      if (/\b(preview|live preview|show preview|open preview|view preview|render preview)\b/i.test(currentPrompt)
          && !/\b(create|write|modify|change|fix|implement)\b/i.test(currentPrompt)) {
        const target = taskProject?.id || taskProject?.name;
        if (!target) throw new Error('Select a project folder before opening preview.');
        pushStep({ kind: 'preview', label: 'Preview', detail: 'loading', status: 'running' });
        const previewRes = await fetch(`${BACKEND_URL}/api/workspace/preview/${encodeURIComponent(target)}`, { cache: 'no-store' });
        const previewData = await previewRes.json().catch(() => ({}));
        if (!previewRes.ok || !previewData.success) {
          pushStep({ kind: 'preview', label: 'Preview', detail: 'loading', status: 'error' });
          throw new Error(previewData.error || `Preview is unavailable (HTTP ${previewRes.status}).`);
        }
        const url = `/preview/${encodeURIComponent(previewData.project?.id || taskProject?.id || taskProject?.name)}/index.html?v=${Date.now()}`;
        setPreviewUrl(url);
        setPreviewReady(true);
        setPreviewKey(k => k + 1);
        setRightTab('preview');
        pushStep({ kind: 'preview', label: 'Preview', detail: 'loaded', status: 'done' });
        const answer = `Preview loaded for ${taskProject?.name}.`;
        setChatMessages(prev => [...prev, { role: 'assistant', content: answer, time: now() }]);
        await persistLocalAssistant(task.id, answer);
        log(`[Preview] Loaded ${taskProject?.name} without using Ollama → ${previewData.previewUrl}`);
        return;
      }

      if (/^(which|what).*(folder|project).*(opened|active|loaded|selected)|^(where).*(working|opened)/i.test(statusQuestion)) {
        const answer = `The active project is ${taskProject.name}.\nWorkspace: ${taskProject.path}`;
        setChatMessages(prev => [...prev, { role: 'assistant', content: answer, time: now() }]);
        await persistLocalAssistant(task.id, answer);
        log(`[Agent] Workspace status answered locally → ${taskProject.name}`);
        return;
      }

      // Read-only project inspection is deterministic and should not wait for Qwen3.
      if (/\b(inspect|structure|stack|tech stack)\b/i.test(currentPrompt) && /project|repo|repository|react|typescript|node|mysql|database/i.test(currentPrompt)) {
        const res = await fetch(`${BACKEND_URL}/api/workspace/inspect?path=${encodeURIComponent(taskProject.path)}`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Project inspection failed.');
        let packageSummary = '';
        try {
          const parsed = JSON.parse(data.keyFiles?.['package.json'] || '{}');
          const deps = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
          const pick = ['react','react-dom','typescript','vite','express','mysql2','@langchain/ollama'];
          const found = pick.filter(k => deps[k]).map(k => `${k}@${deps[k]}`);
          packageSummary = found.length ? `\nPackages: ${found.join(', ')}` : '';
        } catch {}
        const answer = `Project: ${taskProject.name}\nWorkspace: ${taskProject.path}\n\nDetected files: ${data.files.length}${packageSummary}\n\nTop files/folders:\n${data.files.slice(0, 35).join('\n')}`;
        setChatMessages(prev => [...prev, { role: 'assistant', content: answer, time: now() }]);
        await persistLocalAssistant(task.id, answer);
        log(`[Agent] Project inspection completed locally → ${taskProject.name}`);
        return;
      }

      // One agent turn = streamed NDJSON from /api/agent/chat/stream. Each tool
      // the model calls (Thinking / List / Read / Write / Search / Run) arrives as
      // a step event and is appended to the live icon timeline below the chat.
      let data: Awaited<ReturnType<typeof sendAgentChat>>;
      try {
        const streamed = await sendAgentChatStream(sessionId, currentPrompt, task.model, taskProject?.path, step => {
          pushStep(step);
        }, currentAttachments, task.id);
        if (streamed.error) throw new Error(streamed.error);
        if (!streamed.final?.success) {
          throw new Error(streamed.final?.error || streamed.error || 'Agent request failed.');
        }
        data = streamed.final as Awaited<ReturnType<typeof sendAgentChat>>;
      } catch (streamError: any) {
        // Older backend without the streaming route (or a transient stream
        // failure): fall back to the original single-shot endpoint.
        if (!/stream unavailable/i.test(String(streamError?.message))) throw streamError;
        data = await sendAgentChat(sessionId, currentPrompt, task.model, taskProject?.path, currentAttachments, task.id);
      }

      if (!data.success) {
        throw new Error(data.error || 'Agent request failed.');
      }

      setChatMessages(prev => [...prev, { role: 'assistant', content: stripThinking(data.reply || ''), time: now() }]);
      log(`[Agent] Reply received (${data.toolExecuted ? 'tool executed' : 'direct answer'})${data.modelUsed ? ` via ${data.modelUsed}` : ''}${data.fallbackUsed ? ' [fallback]' : ''}.`);

      // The tool ran in the sandbox → surface stdout/stderr in the Terminal tab.
      if (data.toolExecuted) {
        setExecutionOutput({
          code: data.codeExecuted,
          stdout: data.stdout,
          stderr: data.stderr,
          status: data.status,
          language: data.toolCall?.args?.language
        });
        setRightTab('terminal');
        log(`[Tool] execute_code · ${data.toolCall?.args?.language || '?'} → ${data.status || 'done'}`);
        if (taskProject?.id || taskProject?.name) {
          const previewPath = `/preview/${encodeURIComponent(taskProject.id || taskProject.name)}/index.html`;
          const probe = await fetch(previewPath, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
          if (probe?.ok) { setPreviewUrl(previewPath); setPreviewReady(true); setPreviewKey(k => k + 1); }
        }
      }

      // Status stage: verification milestone (the backend already reported the
      // Local visual-analysis stages; this one closes the run before preview).
      pushStep({ kind: 'run', label: 'Run', detail: 'build / verification', status: 'running' });
      let verifyStatus: 'done' | 'error' = 'done';

      // Compatibility fallback: only persist fenced code when the agent did not
      // already use workspace tools. Tool-driven writes are already on disk.
      const writtenFiles = data.toolExecuted ? [] : await writeGeneratedFiles(data.reply || '', taskProject);
      if (writtenFiles.length > 0) {
        setSessionWrittenFiles(prev => [...new Set([...prev, ...writtenFiles])]);
        log(`[Agent] Wrote generated files: ${writtenFiles.join(', ')}`);
        // Refresh the sandbox preview once the new files are on disk.
        setPreviewReady(true);
        setPreviewKey(k => k + 1);
        setRightTab('preview');

        // Verify the workspace still builds when files changed.
        log('[Agent] Code generated. Verifying build...');
        const verifyRes = await fetch(`${BACKEND_URL}/api/agent/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspacePath: taskProject?.path })
        });
        const verifyData = await verifyRes.json();
        if (verifyData.success) {
          log('[Agent] Build verified successfully!');
        } else {
          log(`[Agent] Build error: ${verifyData.error}`);
          verifyStatus = 'error';
        }
      } else if ((data.reply || '').includes('```')) {
        log('[Agent] No writable code blocks found in the response.');
      }
      pushStep({ kind: 'run', label: 'Run', detail: 'build / verification', status: verifyStatus });

      // Status stage: show the updated application. Preview stays best-effort,
      // but the milestone is now visible in the timeline instead of silent.
      pushStep({ kind: 'preview', label: 'Preview', detail: 'updated', status: 'running' });
      await refreshPreviewFast(taskProject);
      pushStep({ kind: 'preview', label: 'Preview', detail: 'updated', status: 'done' });
    } catch (error: any) {
      const message = error.message || String(error);
      // Do not leave half-finished milestones spinning after a failed task.
      setAgentSteps(prev => prev.map(s => s.status === 'running' ? { ...s, status: 'error' } : s));
      updateQueueTask(task.id, { status: 'error', error: message });
      void updateAgentTask(task.id, { status: 'error', error: message }).catch(() => {});
      log(`[Agent] Error: ${message}`);
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠ ${message}`,
        time: now()
      }]);
    } finally {
      setIsBuilding(false);
      void refreshSessionList();
    }
  };


  const drainTaskQueue = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const task = queueRef.current.find(item => item.status === 'queued' || item.status === 'uploading');
        if (!task) break;
        await processAgentTask(task);
        const latest = queueRef.current.find(item => item.id === task.id);
        if (latest?.status === 'error') {
          // Keep failed tasks visible so the user can retry/remove them.
          continue;
        }
        updateQueueTask(task.id, { status: 'done' });
        void updateAgentTask(task.id, { status: 'done', completedAt: new Date().toISOString() }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 400));
        queueRef.current = queueRef.current.filter(item => item.id !== task.id);
        setTaskQueue(queueRef.current);
      }
    } finally {
      processingRef.current = false;
      setIsBuilding(false);
    }
  };

  useEffect(() => {
    if (activeProject?.path && taskQueue.some(t => t.status === 'queued' || t.status === 'uploading') && !processingRef.current) {
      void drainTaskQueue();
    }
  }, [taskQueue.length, activeProject?.path]);

  const addPendingFiles = useCallback((incoming: File[]) => {
    if (!incoming.length) return;
    setPendingFiles(prev => {
      const seen = new Set(prev.map(f => `${f.name}:${f.size}:${f.lastModified}`));
      const next = [...prev];
      for (const file of incoming) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (!seen.has(key)) { seen.add(key); next.push(file); }
      }
      return next.slice(0, 12);
    });
  }, []);

  const handleRunAgent = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = prompt.trim();
    const hasFiles = pendingFiles.length > 0;
    // An attachment itself is a valid task. Never require placeholder text just
    // to get an image/screenshot/ZIP/video into the queue.
    const taskPrompt = text || 'Inspect the attached files and apply the requested changes to the active project. If the attachments are reference material, use them as the source of truth.';
    if (!text && !hasFiles || !activeProject?.path) {
      if (!activeProject?.path) log('[Workspace] Select a project folder before running the agent.');
      return;
    }

    const effectivePrompt = activeTab === 'mobile'
      ? `${MOBILE_CONTEXT}
Target platform selection: ${mobilePlatform === 'both' ? 'Android + iOS' : mobilePlatform === 'android' ? 'Android' : 'iOS'}.

USER REQUEST:
${taskPrompt}`
      : taskPrompt;
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const displayAttachments: AgentAttachment[] = pendingFiles.map((file, index) => ({
      id: `local-${taskId}-${index}`,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      kind: fileKind(file)
    }));
    const hasVisual = pendingFiles.some(file => file.type.startsWith('image/') || file.type.startsWith('video/'));
    const taskModel = selectedModel;
    if (hasVisual && selectedModel === 'auto') {
      log('[Queue] Auto mode — visual task will be routed to the best installed vision model.');
    } else if (hasVisual && !isVisionModel(selectedModel)) {
      const visionModel = availableModels.find(isVisionModel);
      if (visionModel) log(`[Queue] Visual attachment detected — auto-routing this task to ${visionModel}.`);
    }
    const task: QueuedTask = {
      id: taskId,
      prompt: effectivePrompt,
      attachments: [],
      localFiles: pendingFiles,
      model: taskModel,
      project: activeProject,
      status: 'queued'
    };

    queueRef.current = [...queueRef.current, task];
    setTaskQueue(queueRef.current);
    try {
      await createAgentTask({ id: taskId, sessionId, prompt: effectivePrompt, model: taskModel, workspacePath: activeProject.path, attachments: displayAttachments, position: queueRef.current.length - 1 });
      void refreshSessionList();
    } catch (e: any) {
      log(`[Queue] Database save failed: ${e.message || e}`);
      updateQueueTask(taskId, { status: 'error', error: e.message || String(e) });
      return;
    }
    setPrompt('');
    setPendingFiles([]);
    setChatMessages(prev => [...prev, {
      role: 'user',
      content: text || 'Attached files',
      attachments: displayAttachments,
      taskId,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }]);
    log(`[Queue] Added task ${queueRef.current.length}: ${effectivePrompt.slice(0, 100)}${hasFiles ? ` + ${pendingFiles.length} attachment(s)` : ''}`);
    void drainTaskQueue();
  };

  /* ---------- Icons (Freebuff-style, light 1.7 stroke) ---------- */
  const Ic = ({ d, size = 19, color = C.textFaint, sw = 1.7 }: { d: string; size?: number; color?: string; sw?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
  const Pencil = () => <Ic d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />;
  const Search = () => <Ic d="M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />;
  const Home = ({ color }: { color: string }) => <Ic d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" color={color} sw={1.9} />;
  const Gear = () => <Ic d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7.4 7.4 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.4 7.4 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7.4 7.4 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.4 7.4 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.06-.4.1-.8.1-1.2Z" />;
  const Box = () => <Ic d="M21 8 12 3 3 8v8l9 5 9-5V8ZM3.3 8.3 12 13l8.7-4.7M12 13v8" />;
  const Game = () => <Ic d="M6 12h4m-2-2v4m8-1h.01M18 11h.01M17.3 5H6.7a4.7 4.7 0 0 0-4.6 5.6l.9 4.7a3 3 0 0 0 5.2 1.4L9.5 15h5l1.3 1.7a3 3 0 0 0 5.2-1.4l.9-4.7A4.7 4.7 0 0 0 17.3 5Z" />;
  const Orch = () => <Ic d="M3 3h18v7H3zM3 14h18v7H3zM7 6.5h.01M7 17.5h.01" />;
  const DailyIc = () => <Ic d="M8 2v4M16 2v4M3 8h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />;
  const Github = ({ size = 16, color = C.textFaint }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .11-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23.96-.27 1.98-.4 3-.4s2.04.14 3 .4c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22 0 1.61-.02 2.9-.02 3.29 0 .32.22.7.83.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12Z" />
    </svg>
  );
  const Panel = () => <Ic d="M3 5h18v14H3zM9 5v14M3 9h6" size={18} />;
  const Folder = () => <Ic d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" size={16} color={C.textDim} />;
  const Chevron = () => <Ic d="M6 9l6 6 6-6" size={14} color={C.textFaint} sw={2} />;
  const FileIcon = () => <Ic d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" size={15} color={C.amber} sw={1.8} />;
  const Refresh = ({ size = 14, color = C.textFaint }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"></polyline>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
    </svg>
  );

  const navItem = (icon: React.ReactNode, label: string, badgeNode?: React.ReactNode, onClick?: () => void, active?: boolean): React.ReactNode => (
    <div
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', borderRadius: 10, fontSize: 15, fontWeight: 500, color: C.textMid, letterSpacing: '-0.2px', cursor: 'pointer', backgroundColor: active ? '#232329' : 'transparent' }}
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#1f1f24')}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = active ? '#232329' : 'transparent')}>
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {badgeNode}
    </div>
  );

  const badge = (text: string, variant: 'green' | 'amber' | 'blue' = 'green') => (
    <span style={{
      backgroundColor: variant === 'green' ? C.greenSoft : variant === 'amber' ? 'rgba(234, 179, 8, 0.12)' : 'rgba(96, 165, 250, 0.12)',
      color: variant === 'green' ? C.green : variant === 'amber' ? C.amber : C.blue,
      fontSize: 12, fontWeight: 600, padding: '2px 9px', borderRadius: 8
    }}>{text}</span>
  );

  /** Style for the Up/Stop service buttons on orchestrator cards. */
  const svcBtn = (busy: boolean, running: boolean): React.CSSProperties => ({
    backgroundColor: busy ? '#26262c' : running ? 'rgba(248, 113, 113, 0.10)' : C.greenSoft,
    color: busy ? C.textFaint : running ? C.red : C.green,
    border: 'none',
    borderRadius: 9,
    padding: '7px 12px',
    fontSize: 12.5,
    fontWeight: 600,
    letterSpacing: '-0.2px',
    cursor: busy ? 'default' : 'pointer'
  });

  /* ----- GitHub panel styles ----- */
  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', backgroundColor: '#1d1d22', border: `1px solid ${C.border}`,
    borderRadius: 10, padding: '9px 12px', fontSize: 13.5, color: C.text, outline: 'none', fontFamily: MONO
  };
  const errStyle: React.CSSProperties = {
    fontSize: 12.5, lineHeight: 1.5, color: C.red, backgroundColor: 'rgba(248, 113, 113, 0.07)',
    border: '1px solid rgba(248, 113, 113, 0.25)', borderRadius: 8, padding: '8px 11px', wordBreak: 'break-word'
  };
  const okStyle: React.CSSProperties = {
    fontSize: 12.5, color: C.green, backgroundColor: C.greenSoft, borderRadius: 8, padding: '8px 11px'
  };
  const mintBtn = (disabled: boolean): React.CSSProperties => ({
    backgroundColor: disabled ? '#2a2a30' : C.mint, color: disabled ? C.textFaint : '#0b3d1f',
    border: 'none', borderRadius: 11, padding: '11px 16px', fontSize: 13.5, fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer'
  });
  const iconBtn: React.CSSProperties = {
    background: 'transparent', border: 'none', color: C.textFaint, fontSize: 14, cursor: 'pointer', padding: '4px 6px', borderRadius: 6
  };

  // Live thread title: derived from the session's first user message.
  const threadTitle = chatMessages.length > 0
    ? (chatMessages[0].content.trim().length > 38
      ? chatMessages[0].content.trim().slice(0, 38) + '…'
      : chatMessages[0].content.trim())
    : 'Landing Page UI Refactoring';

  return (
    <div className={lightTheme ? "agent-theme-light" : "agent-theme-dark"} style={{ display: 'flex', height: '100vh', width: '100vw', backgroundColor: C.feedBg, color: C.text, fontFamily: FONT, overflow: 'hidden' }}>

      {/* ===== 1. ICON RAIL ===== */}
     <div style={{ display: navigationOpen ? 'flex' : 'none', width: 64, backgroundColor: C.railBg, borderRight: `1px solid ${C.borderSoft}`, flexDirection: 'column', alignItems: 'center', padding: '14px 0', gap: 6, flexShrink: 0 }}>
        <button type="button" title="Agent chat" onClick={() => setView('chat')} style={{ width: 40, height: 40, borderRadius: 11, backgroundColor: '#26262c', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8, border: 'none', cursor: 'pointer' }}>
          <Home color="#ffffff" />
        </button>
        {[<Gear key="g" />, <Box key="b" />, <Game key="gm" />].map((icon, i) => (
          <button key={i} type="button"
            title={i === 0 ? 'Re-scan local engine' : i === 1 ? 'Reload sandbox preview' : 'Open agent tools'}
            onClick={() => (i === 0 ? scanEngine() : i === 1 ? reloadPreview() : (setView('chat'), setActiveTab('skills')))}
            style={{ width: 40, height: 40, borderRadius: 11, background: 'transparent', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            onMouseEnter={e => { if (i !== 2) e.currentTarget.style.backgroundColor = '#1d1d22'; }}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}>
            {icon}
          </button>
        ))}
        <div style={{ marginTop: 'auto', paddingBottom: 4 }}>
          <Panel />
        </div>
      </div>

      {/* ===== 2. SIDEBAR ===== */}
      <div style={{ display: navigationOpen ? 'flex' : 'none', width: 292, backgroundColor: C.sidebarBg, borderRight: `1px solid ${C.borderSoft}`, flexDirection: 'column', padding: '18px 14px 12px', flexShrink: 0 }}>
        {/* Logotype */}
        <div className="agent-display-font" style={{ fontSize: 25, color: '#ffffff', padding: '2px 6px', marginBottom: 16 }}>
          AgentStudio
        </div>

        {/* Engine banner (amber, Freebuff-style) */}
        <button type="button" onClick={() => void scanEngine()} title="Check Ollama, refresh installed models and warm Qwen3" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: engineStatus === 'online' ? 'rgba(74, 222, 128, 0.07)' : engineStatus === 'offline' ? 'rgba(248, 113, 113, 0.07)' : 'rgba(234, 179, 8, 0.07)', border: `1px solid ${engineStatus === 'online' ? 'rgba(74, 222, 128, 0.25)' : engineStatus === 'offline' ? 'rgba(248, 113, 113, 0.25)' : 'rgba(234, 179, 8, 0.28)'}`, borderRadius: 12, padding: '10px 12px', marginBottom: 18, cursor: 'pointer', textAlign: 'left', boxShadow: '0 8px 24px rgba(0,0,0,0.16)' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: engineStatus === 'online' ? C.green : engineStatus === 'offline' ? C.red : C.amber, letterSpacing: '-0.2px' }}>
            Local Engine · {engineStatus === 'online' ? `${availableModels.length} MODELS READY` : engineStatus === 'warming' ? 'WARMING MODEL…' : engineStatus === 'offline' ? 'OFFLINE' : 'CHECKING…'}
          </span>
          <span style={{ fontSize: 14, color: engineStatus === 'online' ? C.green : C.amber }}>↻</span>
        </button>

        {/* Menu */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 20 }}>
          {navItem(<Pencil />, 'New session', undefined, startNewSession)}
          {navItem(<DailyIc />, 'Daily', badge(String(sessionsToday), sessionsToday > 0 ? 'green' : 'amber'), () => log(`[Stats] ${sessionsToday} session(s) created today.`))}
          {navItem(
            <Github size={19} color={C.textFaint} />,
            'GitHub sync',
            ghStatus?.connected
              ? badge(ghStatus.changedFiles.length > 0 ? `${ghStatus.changedFiles.length} NEW` : 'SYNCED', ghStatus.changedFiles.length > 0 ? 'green' : 'blue')
              : badge('OFF', 'amber'),
            openGithubPanel
          )}
          {navItem(<Box />, 'Sandbox preview', badge(previewReady ? 'LIVE' : 'IDLE'), reloadPreview)}
          {navItem(<Search />, 'Previous tasks', badge(sessionHistoryList.length ? String(sessionHistoryList.length) : '0', sessionHistoryList.length ? 'blue' : 'amber'), () => setSearchOpen(o => !o), searchOpen)}
          {navItem(
            <Orch />,
            'App orchestrator',
            orchApps.some(a => a.backend_status === 'RUNNING' || a.frontend_status === 'RUNNING')
              ? badge(`${orchApps.reduce((n, a) => n + (a.backend_status === 'RUNNING' ? 1 : 0) + (a.frontend_status === 'RUNNING' ? 1 : 0), 0)} UP`)
              : undefined,
            () => setView(v => (v === 'orchestrator' ? 'chat' : 'orchestrator')),
            view === 'orchestrator'
          )}
        </div>

        {/* Previous tasks / chat history. History is backed by MySQL (or the
            JSON fallback) and therefore survives browser reloads and restarts. */}
        {searchOpen && (
          <div style={{ marginBottom: 14, background: '#141417', border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '10px 10px 8px', borderBottom: `1px solid ${C.borderSoft}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7 }}>
                <div style={{ fontSize: 13.5, fontWeight: 750, color: C.text }}>Previous tasks</div>
                <button type="button" onClick={() => void refreshSessionList(searchQuery)} title="Refresh history" style={{ ...iconBtn, color: C.textDim }}>↻</button>
              </div>
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search previous tasks…"
                style={{ width: '100%', boxSizing: 'border-box', backgroundColor: '#1d1d22', border: `1px solid ${C.border}`, borderRadius: 9, padding: '8px 10px', fontSize: 12.5, color: C.text, outline: 'none', fontFamily: FONT }}
              />
            </div>
            <div style={{ maxHeight: 270, overflowY: 'auto', padding: 5 }}>
              {historyLoading && sessionHistoryList.length === 0 && (
                <div style={{ padding: '14px 10px', fontSize: 12, color: C.textFaint }}>Loading history…</div>
              )}
              {!historyLoading && sessionHistoryList.length === 0 && (
                <div style={{ padding: '14px 10px', fontSize: 12, color: C.textFaint }}>No previous tasks found.</div>
              )}
              {sessionHistoryList.map((session) => {
                const active = session.session_id === sessionId;
                const when = session.updated_at || session.created_at;
                const time = when ? new Date(when).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                return (
                  <button
                    key={session.session_id}
                    type="button"
                    onClick={() => void openPreviousSession(session.session_id)}
                    style={{ width: '100%', textAlign: 'left', border: `1px solid ${active ? 'rgba(96,165,250,0.35)' : 'transparent'}`, background: active ? 'rgba(96,165,250,0.08)' : 'transparent', borderRadius: 9, padding: '9px 9px', cursor: 'pointer', color: C.text, marginBottom: 2 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ width: 6, height: 6, borderRadius: 99, background: active ? C.blue : C.textFaint, flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: active ? 700 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.title || 'New session'}
                      </span>
                      {session.message_count ? <span style={{ fontSize: 10.5, color: C.textFaint }}>{session.message_count}</span> : null}
                    </div>
                    <div style={{ marginTop: 4, paddingLeft: 13, display: 'flex', justifyContent: 'space-between', gap: 8, color: C.textFaint, fontSize: 10.5 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.workspace_path || 'No workspace'}</span>
                      <span style={{ flexShrink: 0 }}>{time}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Projects tree — filtered live by the search box when open */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px', marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14.5, color: C.text, fontWeight: 700, letterSpacing: '-0.2px' }}>Projects</div>
              <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>Select a folder to give the agent a workspace</div>
            </div>
            <button type="button" title="Refresh projects" onClick={() => void fetchProjects()} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: '#1d1d22', color: C.textDim, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <Refresh size={13} color={C.textDim} />
            </button>
          </div>

          {/* Workspace Switcher — type any folder path to move the agent to a
              brand-new or existing app; each workspace stays fully isolated. */}
          <WorkspaceSelector
            activePath={activeProject?.path}
            onSwitched={(workspace) => { void selectProject(workspace); }}
          />

          {projects.filter(p =>
            !searchQuery.trim() || p.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
          ).map(project => (
            <React.Fragment key={project.id || project.name}>
              {/* Project row — loads the real local folder as the active AI workspace */}
              <div
                onClick={() => selectProject(project)}
                title={project.path ? `Load ${project.name} as the active AI workspace` : `Load ${project.name}`}
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px', fontSize: 15, fontWeight: 500, color: C.textMid, letterSpacing: '-0.2px', cursor: 'pointer', borderRadius: 8 }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#1f1f24')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}>
                <Chevron />
                <Folder />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
                {(activeProject?.id || activeProject?.name) === (project.id || project.name) ? (
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.green, backgroundColor: C.greenSoft, borderRadius: 6, padding: '3px 6px', flexShrink: 0 }}>ACTIVE</span>
                ) : activatingProjectId === (project.id || project.name) ? (
                  <svg className="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.amber} strokeWidth="2.2"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>
                ) : (
                  <span style={{ fontSize: 11, color: C.textFaint, flexShrink: 0 }}>USE</span>
                )}
              </div>
              {project.name === 'LocalAgent' ? (
                <div style={{ paddingLeft: 34, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div
                    onClick={startNewSession}
                    style={{ padding: '7px 10px', fontSize: 15, color: C.textDim, letterSpacing: '-0.2px', cursor: 'pointer', borderRadius: 8 }}
                    onMouseEnter={e => (e.currentTarget.style.color = C.text)}
                    onMouseLeave={e => (e.currentTarget.style.color = C.textDim)}
                  >
                    New thread
                  </div>
                  <div
                    onClick={(e) => { e.stopPropagation(); void openProjectFolder(project); }}
                    title={`Open ${project.name} in Explorer — ${project.path}`}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', fontSize: 15, fontWeight: 500, color: C.text, backgroundColor: (activeProject?.id || activeProject?.name) === (project.id || project.name) ? '#2c2c33' : '#26262c', borderRadius: 10, letterSpacing: '-0.2px', cursor: 'pointer', gap: 8 }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{threadTitle}</span>
                    {isBuilding ? (
                      <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.textFaint} strokeWidth="2.4" strokeLinecap="round">
                        <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                      </svg>
                    ) : (
                      <span style={{ fontSize: 10.5, color: C.textFaint, flexShrink: 0 }}>↗</span>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ paddingLeft: 34 }}>
                  <div
                    onClick={(e) => { e.stopPropagation(); void openProjectFolder(project); }}
                    title={`Open ${project.name} in Explorer — ${project.path}`}
                    style={{ padding: '7px 10px', fontSize: 14.5, color: C.textFaint, letterSpacing: '-0.2px', cursor: 'pointer', borderRadius: 8 }}
                    onMouseEnter={e => (e.currentTarget.style.color = C.textDim)}
                    onMouseLeave={e => (e.currentTarget.style.color = C.textFaint)}
                  >
                    Open folder ↗
                  </div>
                </div>
              )}
            </React.Fragment>
          ))}
          {searchQuery.trim() && projects.every(p => !p.name.toLowerCase().includes(searchQuery.trim().toLowerCase())) && (
            <div style={{ padding: '8px 10px', fontSize: 14, color: C.textFaint, letterSpacing: '-0.2px' }}>No projects match “{searchQuery.trim()}”.</div>
          )}
        </div>

        {/* Footer */}
        <div style={{ borderTop: `1px solid ${C.borderSoft}`, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 14, color: C.textDim, letterSpacing: '-0.2px' }}>Local Engine</span>
            <span style={{
              fontSize: 14, fontWeight: 700,
              color: engineStatus === 'online' ? C.green : engineStatus === 'offline' ? C.red : C.amber
            }}>
              {engineStatus === 'online' ? `${availableModels.length} models` : engineStatus === 'offline' ? 'Offline' : '…'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11.5, color: C.textFaint }}>Workspace</span>
            <span title={activeProject?.path || 'No active project'} style={{ fontSize: 11.5, fontWeight: 700, color: activeProject ? C.green : C.textFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeProject?.name || 'None selected'}
            </span>
          </div>
        </div>
      </div>

      {/* ===== 3. AGENT FEED / ORCHESTRATOR (right column: chat + send box) ===== */}
      <div style={{ order: 1, flex: 1.05, backgroundColor: C.feedBg, display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>

        {view === 'orchestrator' ? (
          <>
            {/* Orchestrator header */}
            <div style={{ height: 50, backgroundColor: '#121215', borderBottom: `1px solid ${C.borderSoft}`, display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px', flexShrink: 0 }}>
              <span style={{ fontSize: 14.5, fontWeight: 700, color: C.text, letterSpacing: '-0.2px' }}>AI Local Agent Orchestrator</span>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', color: C.textFaint }}>
                {activeOrchApps.length} APP{activeOrchApps.length === 1 ? '' : 'S'} ACTIVE (FILTERED)
              </span>
              <button
                type="button"
                onClick={refreshOrchestrator}
                style={{ marginLeft: 'auto', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, padding: '5px 12px', fontSize: 12, color: C.textDim, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Refresh size={12} />
                Refresh
              </button>
            </div>

            {/* App cards grid — filtered to the active workspace's app only */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 460px))', gap: 14, alignContent: 'start' }}>
              {orchLoadError && (
                <div style={{ gridColumn: '1 / -1', backgroundColor: 'rgba(248, 113, 113, 0.08)', border: '1px solid rgba(248, 113, 113, 0.3)', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, color: C.red }}>
                  {orchLoadError}
                </div>
              )}
              {activeOrchApps.map((app) => {
                const isSelfApp = app.name === 'LocalAgent Studio' && Number(app.backend_port) === 3002;
                return (
                <div key={app.id} style={{ backgroundColor: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 11 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.text, letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</span>
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.8px', padding: '3px 9px', borderRadius: 7, flexShrink: 0, backgroundColor: 'rgba(96, 165, 250, 0.12)', border: '1px solid rgba(96, 165, 250, 0.30)', color: C.blue }}>
                      ACTIVE PROJECT
                    </span>
                  </div>

                  {(['backend', 'frontend'] as const).map((kind) => {
                    const status = kind === 'backend' ? app.backend_status : app.frontend_status;
                    const port = kind === 'backend' ? app.backend_port : app.frontend_port;
                    const color = status === 'RUNNING' ? C.green : status === 'ERROR' ? C.red : C.textFaint;
                    return (
                      <div key={kind} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.rowBg, border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: '8px 12px' }}>
                        <span style={{ fontSize: 12.5, color: C.textDim, textTransform: 'capitalize', fontWeight: 500 }}>{kind}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', color }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: color }} />
                          {status} · PORT {port}
                        </span>
                      </div>
                    );
                  })}

                  {orchErrors[app.id] && (
                    <div style={{ fontSize: 11.5, lineHeight: 1.5, color: C.red, backgroundColor: 'rgba(248, 113, 113, 0.07)', border: '1px solid rgba(248, 113, 113, 0.25)', borderRadius: 8, padding: '7px 10px', wordBreak: 'break-word' }}>
                      {orchErrors[app.id]}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto', alignItems: 'center' }}>
                    <button
                      type="button"
                      disabled={isSelfApp || !!orchBusy[`${app.id}_backend`]}
                      title={isSelfApp ? 'This is the AgentStudio backend currently serving this page.' : undefined}
                      onClick={() => { if (!isSelfApp) void handleOrchToggle(app, 'backend'); }}
                      style={svcBtn(!!orchBusy[`${app.id}_backend`], app.backend_status === 'RUNNING')}
                    >
                      {isSelfApp ? 'Current Backend' : app.backend_status === 'RUNNING' ? 'Stop Backend' : 'Up Backend'}
                    </button>
                    <button
                      type="button"
                      disabled={isSelfApp || !!orchBusy[`${app.id}_frontend`]}
                      title={isSelfApp ? 'This is the AgentStudio frontend currently serving this page.' : undefined}
                      onClick={() => { if (!isSelfApp) void handleOrchToggle(app, 'frontend'); }}
                      style={svcBtn(!!orchBusy[`${app.id}_frontend`], app.frontend_status === 'RUNNING')}
                    >
                      {isSelfApp ? 'Current Frontend' : app.frontend_status === 'RUNNING' ? 'Stop Frontend' : 'Up Frontend'}
                    </button>
                    <button
                      type="button"
                      disabled={app.frontend_status !== 'RUNNING'}
                      onClick={() => launchApp(app)}
                      style={{
                        marginLeft: 'auto',
                        backgroundColor: app.frontend_status === 'RUNNING' ? C.mint : '#2a2a30',
                        color: app.frontend_status === 'RUNNING' ? '#0b3d1f' : C.textFaint,
                        border: 'none',
                        borderRadius: 9,
                        padding: '7px 13px',
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: app.frontend_status === 'RUNNING' ? 'pointer' : 'default'
                      }}
                    >
                      Launch App 🚀
                    </button>
                  </div>
                </div>
                );
              })}
              {activeOrchApps.length === 0 && !orchLoadError && (
                <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: C.textFaint, fontSize: 13, padding: 30 }}>No active orchestrator configuration found for this workspace.</div>
              )}
            </div>
          </>
        ) : (
          <>

        {/* Tab bar */}
        <div style={{ height: 50, backgroundColor: '#121215', borderBottom: `1px solid ${C.borderSoft}`, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', flexShrink: 0 }}>
          <button type="button" onClick={() => setNavigationOpen(v => !v)} aria-expanded={navigationOpen} title={navigationOpen ? 'Hide navigation' : 'Show navigation'} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#232329', border: `1px solid ${C.border}`, borderRadius: 9, padding: '6px 10px', color: C.textMid, cursor: 'pointer', fontSize: 12 }}>
            <span aria-hidden="true">{navigationOpen ? '▾' : '☰'}</span><span>Menu</span>
          </button>
          <button type="button" onClick={() => setLightTheme(v => !v)} title="Toggle light/dark appearance" aria-label="Toggle light/dark appearance" style={{ marginLeft: 0, background: '#232329', border: `1px solid ${C.border}`, borderRadius: 9, padding: '6px 10px', color: C.textMid, cursor: 'pointer', fontSize: 12 }}>
            {lightTheme ? '☀ Light' : '☾ Dark'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 9, backgroundColor: '#232329', borderRadius: 10, padding: '6px 12px', maxWidth: 320 }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, color: C.textMid, letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {threadTitle}
            </span>
            <Refresh size={13} />
          </div>
          <span style={{ fontSize: 17, color: C.textFaint, cursor: 'pointer' }}>+</span>
          {activeProject && (
            <div title={activeProject.path} style={{ display: 'flex', alignItems: 'center', gap: 7, maxWidth: 360, backgroundColor: C.greenSoft, border: '1px solid rgba(74, 222, 128, 0.20)', borderRadius: 16, padding: '5px 11px', color: C.green, fontSize: 11.5, fontWeight: 700 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: C.green }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeProject.name}</span>
            </div>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* GitHub pill (AI-Studio-style header action) */}
            <button
              type="button"
              onClick={openGithubPanel}
              title="GitHub sync — connect a repo, review changes, push"
              style={{ display: 'flex', alignItems: 'center', gap: 7, backgroundColor: '#232329', border: `1px solid ${ghStatus?.connected ? 'rgba(74, 222, 128, 0.35)' : C.border}`, borderRadius: 18, padding: '5px 13px', fontSize: 12, fontWeight: 600, color: C.textMid, cursor: 'pointer', letterSpacing: '-0.2px' }}
            >
              <Github size={13} color={C.textMid} />
              GitHub
              <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: ghStatus?.connected ? C.green : C.textFaint }} />
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', color: engineStatus === 'online' ? C.green : engineStatus === 'offline' ? C.red : C.amber }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: engineStatus === 'online' ? C.green : engineStatus === 'offline' ? C.red : C.amber }} />
              {engineStatus === 'online' ? 'ACTIVE' : engineStatus === 'warming' ? 'WARMING' : engineStatus === 'offline' ? 'OFFLINE' : 'CHECKING'}
            </div>
          </div>
        </div>

        {/* Feed */}
        <div style={{ flex: 1, padding: '22px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Event log — hidden behind a dropdown toggle; click to inspect entries */}
          {logs.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button type="button" onClick={() => setLogOpen(v => !v)} aria-expanded={logOpen} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'transparent', border: 0, padding: '2px 2px', cursor: 'pointer', width: 'fit-content', textAlign: 'left' }}>
                <Ic d={logOpen ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} size={13} color={C.textFaint} sw={2} />
                <span style={{ fontSize: 12, fontWeight: 650, color: C.textDim, letterSpacing: '-0.1px' }}>Event log</span>
                <span style={{ fontSize: 11, fontFamily: MONO, color: '#777780' }}>{logs.length}</span>
              </button>
              {logOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {logs.map((entry, index) => (
                    <div key={index} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                      <span style={{
                        fontSize: 14, fontFamily: MONO, letterSpacing: '-0.15px',
                        color: entry.text.includes('Success') ? C.green : entry.text.includes('Error') || entry.text.includes('error') ? C.red : C.textDim
                      }}>
                        {entry.text}
                      </span>
                      <span style={{ fontSize: 12, fontFamily: MONO, color: '#777780', flexShrink: 0 }}>{entry.time}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Chat bubbles — user right, agent left (mirrors agent_messages rows) */}
          {chatMessages.map((m, index) => (
            <div key={index} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '82%',
                backgroundColor: m.role === 'user' ? 'rgba(96, 165, 250, 0.10)' : C.cardBg,
                border: m.role === 'user' ? '1px solid rgba(96, 165, 250, 0.30)' : `1px solid ${C.border}`,
                borderRadius: 14,
                padding: '10px 14px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 5 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.9px', color: m.role === 'user' ? C.blue : C.green }}>
                    {m.role === 'user' ? 'YOU' : 'AGENT'}
                  </span>
                  <span style={{ fontSize: 12, fontFamily: MONO, color: '#777780' }}>{m.time}</span>
                </div>
                {m.attachments && m.attachments.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 8 }}>
                    {m.attachments.map((a) => (
                      <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.05)', border: `1px solid ${C.borderSoft}`, fontSize: 11.5, color: C.textMid }}>
                        <span>{a.kind === 'image' ? '🖼️' : a.kind === 'video' ? '🎬' : a.kind === 'archive' ? '🗜️' : '📎'}</span>
                        <span style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      </div>
                    ))}
                  </div>
                )}
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 15, lineHeight: 1.7, fontFamily: m.role === 'user' ? FONT : MONO, color: m.role === 'user' ? '#f0f0f4' : '#eeeeF2' }}>
                  {m.content}
                </pre>
              </div>
            </div>
          ))}

          {/* Agent working indicator */}
          {isBuilding && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#b9b9c2', fontSize: 13.5, letterSpacing: '-0.1px', marginBottom: 4 }}>
                <svg className="spin" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2.4" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                </svg>
                Working
                {agentSteps.length > 0 && (
                  <span style={{ fontSize: 11.5, color: C.textFaint, fontFamily: MONO }}>
                    for {Math.max(1, Math.round((Date.now() - workStartRef.current) / 1000))}s
                  </span>
                )}
              </div>
              {/* Live tool timeline: icon + title (Thinking/List/Read/Write/Search/Run) + detail */}
              {agentSteps.map((s, i) => {
                const busy = s.status === 'running';
                const failed = s.status === 'error';
                // Bright icons/labels vs dim details, per the reference feed.
                const iconColor = failed ? C.red : busy ? C.blue : '#b9b9c2';
                const statusText = failed ? 'Failed' : busy ? '…' : s.kind === 'run' ? 'Success' : '';
                return (
                  <div key={`${s.kind}-${s.detail || ''}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0 5px 2px' }}>
                    <span style={{ position: 'relative', display: 'inline-flex', width: 18, justifyContent: 'center', flexShrink: 0 }}>
                      {busy ? (
                        <svg className="spin" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2.2" strokeLinecap="round">
                          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                        </svg>
                      ) : (
                        <Ic d={STEP_ICONS[s.kind] || STEP_ICONS.run} size={15} color={iconColor} sw={1.8} />
                      )}
                      {/* timeline connector tick below the icon (not on the last row) */}
                      {i < agentSteps.length - 1 && (
                        <span style={{ position: 'absolute', top: 17, left: '50%', transform: 'translateX(-50%)', width: 1.5, height: 10, background: '#34353b', borderRadius: 2 }} />
                      )}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 650, color: C.text, minWidth: 62, letterSpacing: '-0.1px' }}>{s.label}</span>
                    {s.detail ? (
                      <span style={{ fontSize: 12.5, color: C.textDim, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {s.detail}
                      </span>
                    ) : null}
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      {statusText ? (
                        <span style={{ fontSize: 11, fontFamily: MONO, color: failed ? C.red : busy ? C.blue : C.green }}>{statusText}</span>
                      ) : null}
                      <Ic d="M9 6l6 6-6 6" size={13} color={C.textFaint} sw={2} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div ref={chatEndRef} />

          {/* Freebuff-style To-dos: five SDLC milestones, collapsed by the dropdown control. */}
          {(isBuilding || agentSteps.length > 0) && (
            <div style={{ backgroundColor: '#1b1c1d', border: `1px solid ${C.border}`, borderRadius: 14, padding: '10px 12px', boxShadow: '0 10px 28px rgba(0,0,0,0.16)' }}>
              <button type="button" onClick={() => setTodoOpen(v => !v)} aria-expanded={todoOpen} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 0, padding: '2px 2px 8px', color: C.text, cursor: 'pointer', textAlign: 'left' }}>
                <Ic d={STEP_ICONS.todos} size={15} color="#b9b9c2" sw={1.8} />
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.1px', flex: 1, fontFamily: FONT, color: C.text }}>To-dos</span>
                <span style={{ fontSize: 11.5, color: C.textDim, fontFamily: MONO }}>{todoState.completedCount}/{todoState.items.length} done</span>
                <Ic d={todoOpen ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} size={14} color={C.textFaint} sw={2} />
              </button>
              {todoOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2 }}>
                  {todoState.items.map((item) => (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, minHeight: 22 }}>
                      <span style={{ width: 17, height: 17, borderRadius: 999, border: `1px solid ${item.completed ? 'rgba(134,239,172,0.65)' : '#4a4a52'}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1, fontSize: 10, color: item.completed ? C.green : 'transparent', background: item.completed ? 'rgba(134,239,172,0.06)' : 'transparent' }}>
                        {item.completed ? '✓' : ''}
                      </span>
                      <span style={{ fontSize: 12.5, lineHeight: 1.45, color: item.completed ? '#8a8a92' : C.text, textDecoration: item.completed ? 'line-through' : 'none' }}>
                        {item.label}
                      </span>
                      {item.running && !item.completed ? <span className="spin" style={{ width: 7, height: 7, border: `1px solid ${C.blue}`, borderTopColor: 'transparent', borderRadius: 999, marginTop: 5, flexShrink: 0 }} /> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Quick Action Pills — hidden by default; uncomment to restore.
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {quickActions.map((action, i) => (
              <button key={i} type="button" title={action.prompt} onClick={() => setPrompt(action.prompt)} style={{ backgroundColor: C.rowBg, border: `1px solid ${C.borderSoft}`, borderRadius: 18, padding: '7px 15px', fontSize: 13.5, color: '#d4d4d9', cursor: 'pointer', fontWeight: 600, letterSpacing: '-0.2px' }}>
                {action.label}
              </button>
            ))}
          </div>
          */}

          {/* Changed Files Card — real files the agent wrote this session */}
          {sessionWrittenFiles.length > 0 && (
            <div style={{ backgroundColor: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: C.text, letterSpacing: '-0.2px' }}>
                  Agent changed {sessionWrittenFiles.length} file{sessionWrittenFiles.length === 1 ? '' : 's'}
                </span>
                <span style={{ fontSize: 12, color: C.green, fontFamily: MONO, fontWeight: 600 }}>✓ saved</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {sessionWrittenFiles.map((path) => (
                  <div key={path} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, fontFamily: MONO, padding: '9px 12px', borderRadius: 10, backgroundColor: C.rowBg, border: `1px solid ${C.borderSoft}` }}>
                    <span style={{ color: '#b8b8be', display: 'flex', alignItems: 'center', gap: 9 }}>
                      <FileIcon />
                      {path}
                    </span>
                    <span style={{ color: C.green, fontWeight: 600 }}>saved</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Task queue — stays usable while another task is running */}
        {taskQueue.length > 0 && (
          <div style={{ margin: '0 14px 10px', padding: '10px 12px', backgroundColor: '#17181a', border: `1px solid ${C.border}`, borderRadius: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: C.textMid, letterSpacing: '0.5px' }}>
                TASK QUEUE · {taskQueue.length}
              </span>
              <span style={{ fontSize: 11, color: C.textFaint }}>runs sequentially</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {taskQueue.map((task, index) => (
                <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8, backgroundColor: task.status === 'running' ? 'rgba(96,165,250,0.08)' : C.rowBg }}>
                  <span style={{ width: 21, height: 21, borderRadius: 999, border: `1px solid ${task.status === 'error' ? 'rgba(248,113,113,0.45)' : task.status === 'running' ? 'rgba(96,165,250,0.45)' : C.border}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 10.5, color: task.status === 'error' ? C.red : task.status === 'running' ? C.blue : C.textFaint }}>{index + 1}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.textMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.prompt}</span>
                  {(task.attachments.length || task.localFiles.length) > 0 && <span title="Attachments" style={{ fontSize: 12 }}>📎 {task.attachments.length || task.localFiles.length}</span>}
                  <span style={{ fontSize: 10.5, color: task.status === 'error' ? C.red : task.status === 'running' ? C.blue : C.textFaint, textTransform: 'uppercase' }}>{task.status}</span>
                  {task.status === 'error' && (
                    <button type="button" onClick={() => { updateQueueTask(task.id, { status: 'queued', error: undefined }); void updateAgentTask(task.id, { status: 'queued', error: null }).catch(() => {}); log(`[Queue] Retrying task ${index + 1}…`); void drainTaskQueue(); }} title="Retry task" aria-label="Retry task" style={{ border: 0, background: 'transparent', color: C.blue, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Retry</button>
                  )}
                  {(task.status === 'queued' || task.status === 'error') && (
                    <button type="button" onClick={() => { queueRef.current = queueRef.current.filter(q => q.id !== task.id); setTaskQueue(queueRef.current); void updateAgentTask(task.id, { status: 'done', error: 'Removed from queue by user.' }).catch(() => {}); log(`[Queue] Removed task ${index + 1}.`); }} title="Close / remove task" aria-label="Close / remove task" style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, background: 'transparent', color: C.textFaint, cursor: 'pointer', fontSize: 16, lineHeight: 1, borderRadius: 6 }}>×</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Prompt Box */}
        <div style={{ padding: 14, backgroundColor: C.feedBg, flexShrink: 0 }}>
          {/* Suggestions — hidden behind a dropdown toggle so the composer stays clean */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button type="button" onClick={() => setSuggestionsOpen(open => !open)} aria-expanded={suggestionsOpen} title="Show prompt suggestions" style={{ background: 'transparent', border: 0, padding: '5px 4px', color: C.textFaint, fontSize: 11.5, fontWeight: 650, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Suggestions
              <span aria-hidden="true" style={{ fontSize: 9, display: 'inline-block', transform: suggestionsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }}>▼</span>
            </button>
            {suggestionsOpen && [
              'Inspect this project and explain its structure',
              'Find and fix bugs, then run tests',
              'Build a React Native Android/iOS starter'
            ].map((suggestion) => (
              <button key={suggestion} type="button" onClick={() => { setPrompt(suggestion); setSuggestionsOpen(false); }} style={{ background: C.cardBg, border: `1px solid ${C.border}`, color: C.textMid, borderRadius: 16, padding: '5px 10px', fontSize: 11.5, cursor: 'pointer' }}>
                {suggestion}
              </button>
            ))}
          </div>
          <form onSubmit={handleRunAgent} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={(e) => { e.preventDefault(); addPendingFiles(Array.from(e.dataTransfer.files || [])); }} onPaste={(e) => { const files = Array.from(e.clipboardData.files || []).filter(f => f.type.startsWith('image/') || f.type.startsWith('video/')); if (files.length) { e.preventDefault(); addPendingFiles(files); } }} style={{ backgroundColor: '#1b1b20', border: '1px solid #34343c', borderRadius: 20, padding: '14px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pendingFiles.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {pendingFiles.map((file, index) => (
                  <div key={`${file.name}-${file.lastModified}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', borderRadius: 9, backgroundColor: C.rowBg, border: `1px solid ${C.borderSoft}` }}>
                    {file.type.startsWith('image/') ? (
                      <img src={URL.createObjectURL(file)} alt="" onLoad={(e) => URL.revokeObjectURL((e.currentTarget as HTMLImageElement).src)} style={{ width: 30, height: 30, objectFit: 'cover', borderRadius: 6 }} />
                    ) : <span>{fileKind(file) === 'video' ? '🎬' : fileKind(file) === 'archive' ? '🗜️' : '📎'}</span>}
                    <span style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, color: C.textMid }}>{file.name}</span>
                    <button type="button" onClick={() => setPendingFiles(prev => prev.filter((_, i) => i !== index))} title="Remove attachment" style={{ border: 0, background: 'transparent', color: C.textFaint, cursor: 'pointer', fontSize: 14 }}>×</button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*,.zip,.tar,.gz,.tgz,.7z,.rar"
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                addPendingFiles(files);
                e.currentTarget.value = '';
              }}
            />
            {pendingFiles.length > 0 && <div style={{ fontSize: 11, color: C.textFaint }}>Attachments ready — you can send now, or add more by Attach, drag & drop, or paste a screenshot.</div>}
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleRunAgent();
                }
              }}
              placeholder={activeProject ? "Make changes, add new features, ask for anything" : "Select a project folder first…"}
              aria-label="Task prompt"
              style={{ backgroundColor: 'transparent', border: 'none', color: C.text, fontSize: 16, outline: 'none', minHeight: 64, resize: 'none', fontFamily: FONT, lineHeight: 1.5, letterSpacing: '-0.2px', wordBreak: 'break-word' }}
            />

            {/* Composer actions — round attach (left) and round send (right), like the reference prompt card */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', minWidth: 0 }}>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach images, screenshots, ZIPs or videos"
                  aria-label="Attach files"
                  style={{ width: 36, height: 36, borderRadius: 12, border: '1px solid #34343c', backgroundColor: 'transparent', color: C.textMid, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ pointerEvents: 'none' }}>
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
                <div style={{ position: 'relative' }}>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    aria-label="Model"
                    style={{ appearance: 'none', WebkitAppearance: 'none', backgroundColor: 'transparent', color: C.textDim, border: 'none', padding: '6px 24px 6px 6px', fontSize: 13, outline: 'none', fontWeight: 500, letterSpacing: '-0.2px', cursor: 'pointer', fontFamily: FONT, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    <option value="auto" style={{ backgroundColor: '#1b1b20', color: C.textMid }}>Auto</option>
                    {availableModels.filter(m => m !== 'auto').map((m) => (
                      <option key={m} value={m} style={{ backgroundColor: '#1b1b20', color: C.textMid }}>{m}</option>
                    ))}
                  </select>
                  <span style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: C.textFaint, fontSize: 11 }}>▾</span>
                </div>
              </div>

              <button
                type="button"
                aria-label={isBuilding ? 'Queue message' : 'Send message'}
                title={isBuilding ? 'Queue task' : 'Send task'}
                onClick={() => { void handleRunAgent(); }}
                disabled={(!prompt.trim() && pendingFiles.length === 0) || !activeProject?.path}
                style={{
                  backgroundColor: ((!prompt.trim() && pendingFiles.length === 0) || !activeProject?.path) ? 'transparent' : C.mint,
                  border: ((!prompt.trim() && pendingFiles.length === 0) || !activeProject?.path) ? '1px solid #34343c' : 'none',
                  borderRadius: '50%',
                  width: 38,
                  height: 38,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: ((!prompt.trim() && pendingFiles.length === 0) || !activeProject?.path) ? 'default' : 'pointer',
                  opacity: ((!prompt.trim() && pendingFiles.length === 0) || !activeProject?.path) ? 0.7 : 1
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={(!prompt.trim() && pendingFiles.length === 0) || !activeProject?.path ? '#a1a1aa' : '#0b3d1f'} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }}>
                  <line x1="12" y1="19" x2="12" y2="5"></line>
                  <polyline points="5 12 12 5 19 12"></polyline>
                </svg>
              </button>
            </div>
          </form>

          {/* Mode pills + mobile target — below the prompt card */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingLeft: 2 }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {(['build', 'plan', 'mission', 'skills', 'mobile'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  style={{
                    backgroundColor: activeTab === tab ? '#f4f4f5' : 'transparent',
                    color: activeTab === tab ? '#18181b' : '#8a8a90',
                    border: 'none',
                    borderRadius: 8,
                    padding: '5px 13px',
                    fontSize: 12.5,
                    fontWeight: activeTab === tab ? 600 : 500,
                    textTransform: 'capitalize',
                    cursor: 'pointer',
                    letterSpacing: '-0.2px'
                  }}
                >
                  {tab}
                </button>
              ))}
              {activeTab === 'mobile' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 4, paddingLeft: 9, borderLeft: `1px solid ${C.borderSoft}` }}>
                  <span style={{ fontSize: 11.5, color: C.textFaint, fontWeight: 700 }}>Target</span>
                  <div style={{ position: 'relative' }}>
                    <select
                      value={mobilePlatform}
                      onChange={(e) => setMobilePlatform(e.target.value as 'both' | 'android' | 'ios')}
                      aria-label="Mobile target platform"
                      style={{ appearance: 'none', WebkitAppearance: 'none', backgroundColor: '#202126', color: C.textMid, border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: '5px 23px 5px 8px', fontSize: 11.5, outline: 'none', cursor: 'pointer', fontFamily: FONT }}
                    >
                      <option value="both">Android + iOS</option>
                      <option value="android">Android</option>
                      <option value="ios">iOS</option>
                    </select>
                    <span style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: C.textFaint, fontSize: 9 }}>▾</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
          </>
        )}
      </div>

      {/* ===== 4. SANDBOX PREVIEW (middle column: live preview + terminal) ===== */}
      <div style={{ order: 2, flex: 1.45, backgroundColor: '#0b0b0d', display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>

        {/* Browser chrome */}
        <div style={{ height: 50, padding: '0 14px', borderBottom: `1px solid ${C.borderSoft}`, display: 'flex', alignItems: 'center', gap: 12, backgroundColor: '#121215', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#3f3f46' }}></div>
            <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#3f3f46' }}></div>
            <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#3f3f46' }}></div>
          </div>

          <div style={{ flex: 1, backgroundColor: '#1b1b20', border: `1px solid ${C.borderSoft}`, borderRadius: 9, padding: '6px 13px', fontSize: 12, color: C.textDim, display: 'flex', alignItems: 'center', gap: 9 }}>
            <Ic d="M3 11h18M7 11V7a5 5 0 0 1 10 0v4" size={12} />
            <input
              type="text"
              value={previewUrl}
              readOnly
              style={{ background: 'transparent', border: 'none', color: C.textMid, fontSize: 12, width: '100%', outline: 'none', fontFamily: MONO }}
            />
          </div>

          {/* Preview | Terminal tab switch */}
          <div style={{ display: 'flex', backgroundColor: '#1b1b20', border: `1px solid ${C.borderSoft}`, borderRadius: 9, padding: 2, gap: 2, flexShrink: 0 }}>
            {(['preview', 'terminal'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setRightTab(t)}
                style={{
                  border: 'none',
                  borderRadius: 7,
                  padding: '5px 13px',
                  fontSize: 11.5,
                  fontWeight: 600,
                  letterSpacing: '0.3px',
                  textTransform: 'capitalize',
                  cursor: 'pointer',
                  fontFamily: FONT,
                  backgroundColor: rightTab === t ? '#2e2e35' : 'transparent',
                  color: rightTab === t ? C.text : C.textFaint
                }}
              >
                {t}
              </button>
            ))}
          </div>

          <button
            type="button"
            title="Reload preview"
            onClick={reloadPreview}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 5, borderRadius: 7 }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#1d1d22')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <Refresh size={14} />
          </button>

          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: previewReady ? C.green : C.textFaint, fontWeight: 700, letterSpacing: '0.5px' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: previewReady ? C.green : C.textFaint }} />
            {previewReady ? 'LIVE' : 'IDLE'}
          </span>
        </div>

        {/* Right-pane content: sandbox terminal OR live preview served at /preview */}
        <div style={{ flex: 1, backgroundColor: '#08080a', position: 'relative', overflow: 'hidden' }}>
          {rightTab === 'terminal' ? (
            <div style={{ height: '100%', overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 16, fontFamily: MONO }}>
              {!executionOutput ? (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textFaint, flexDirection: 'column', gap: 12, fontFamily: FONT }}>
                  <div style={{ width: 52, height: 52, borderRadius: 15, backgroundColor: C.cardBg, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Ic d="M4 17l6-5-6-5M12 19h8" size={20} color={C.green} sw={1.8} />
                  </div>
                  <p style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: '8px 0 0', letterSpacing: '-0.2px' }}>Sandbox Terminal Idle</p>
                  <p style={{ fontSize: 12.5, margin: 0, maxWidth: 360, textAlign: 'center', letterSpacing: '-0.2px' }}>
                    No code executed yet. Ask the agent to perform a code-based task — stdout/stderr streams here.
                  </p>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.8px', color: C.textDim }}>EXECUTION OUTPUT</span>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', color: executionOutput.status === 'error' ? C.red : C.green }}>
                      {executionOutput.status === 'error' ? '✗ ERROR' : '✓ SUCCESS'}{executionOutput.language ? ` · ${executionOutput.language}` : ''}
                    </span>
                  </div>

                  {executionOutput.code && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, letterSpacing: '0.8px', marginBottom: 6 }}>EXECUTED CODE</div>
                      <pre style={{ margin: 0, backgroundColor: '#101015', border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: 12, color: '#9cdcfe', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {executionOutput.code}
                      </pre>
                    </div>
                  )}

                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, letterSpacing: '0.8px', marginBottom: 6 }}>STDOUT</div>
                    <pre style={{ margin: 0, backgroundColor: '#000000', border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: 12, color: '#4af626', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {executionOutput.stdout || '(Empty)'}
                    </pre>
                  </div>

                  {executionOutput.stderr && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, letterSpacing: '0.8px', marginBottom: 6 }}>STDERR</div>
                      <pre style={{ margin: 0, backgroundColor: '#000000', border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: 12, color: '#f44336', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {executionOutput.stderr}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : previewReady ? (
            <iframe
              key={previewKey}
              src={previewUrl}
              title="Sandbox Preview"
              onLoad={() => log(`[Preview] iframe loaded: ${previewUrl}`)}
              onError={() => { setPreviewReady(false); log(`[Preview] iframe failed to load: ${previewUrl}`); }}
              style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#ffffff' }}
            />
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textFaint, flexDirection: 'column', gap: 14 }}>
              <div style={{ width: 58, height: 58, borderRadius: 16, backgroundColor: C.cardBg, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Ic d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" size={22} color={C.blue} sw={1.8} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: '0 0 4px 0', letterSpacing: '-0.2px' }}>Sandbox Preview Idle</p>
                <p style={{ fontSize: 12.5, margin: 0, color: C.textFaint, letterSpacing: '-0.2px' }}>Generated UI will render here automatically after the agent writes files.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ===== GitHub sync panel ===== */}
      {ghOpen && (
        <div
          onClick={() => setGhOpen(false)}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: 480, maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto', backgroundColor: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 24px 64px rgba(0, 0, 0, 0.55)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 15.5, fontWeight: 700, color: C.text, letterSpacing: '-0.2px' }}>
                <Github size={17} color={C.text} />
                GitHub sync
              </span>
              <button type="button" onClick={() => setGhOpen(false)} style={{ background: 'transparent', border: 'none', color: C.textFaint, fontSize: 16, cursor: 'pointer', padding: 4 }}>✕</button>
            </div>

            {!ghStatus?.connected ? (
              <>
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.6px', color: C.textFaint, marginBottom: 6 }}>REPOSITORY (OWNER/NAME)</div>
                  <input value={repoInput} onChange={e => setRepoInput(e.target.value)} placeholder="jlxam/Matwithpayment" style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.6px', color: C.textFaint, marginBottom: 6 }}>BRANCH</div>
                  <input value={branchInput} onChange={e => setBranchInput(e.target.value)} placeholder="main" style={inputStyle} />
                </div>
                {ghError && <div style={errStyle}>{ghError}</div>}
                <button type="button" disabled={ghBusy} onClick={handleGithubConnect} style={mintBtn(ghBusy)}>
                  Connect repository
                </button>
              </>
            ) : (
              <>
                {/* Repository chip */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, backgroundColor: C.rowBg, border: `1px solid ${C.borderSoft}`, borderRadius: 12, padding: '10px 14px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 14, fontWeight: 600, color: C.text, overflow: 'hidden' }}>
                    <Github size={15} color={C.textMid} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ghStatus.connection!.repo}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.4px', backgroundColor: C.greenSoft, color: C.green, borderRadius: 6, padding: '2px 8px', flexShrink: 0 }}>● {ghStatus.connection!.branch}</span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <button type="button" title="Open on GitHub" onClick={() => window.open(`https://github.com/${ghStatus.connection!.repo}/tree/${ghStatus.connection!.branch}`, '_blank')} style={iconBtn}>↗</button>
                    <button type="button" title="Disconnect" onClick={handleGithubDisconnect} style={iconBtn}>⏏</button>
                  </span>
                </div>

                {/* Sync status */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.6px', color: C.textFaint }}>SYNC STATUS</span>
                  <span style={{ fontSize: 11.5, color: C.textFaint }}>
                    {ghStatus.connection!.lastPushAt ? `Last pushed ${new Date(ghStatus.connection!.lastPushAt).toLocaleString()}` : 'Never pushed'}
                  </span>
                </div>
                <div style={{
                  backgroundColor: C.rowBg, borderRadius: 12, padding: '11px 14px', fontSize: 13, color: C.textMid, letterSpacing: '-0.2px',
                  border: `1px solid ${ghStatus.changedFiles.length > 0 ? 'rgba(234, 179, 8, 0.3)' : C.borderSoft}`
                }}>
                  {ghStatus.changedFiles.length > 0
                    ? `Changes in AgentStudio are ready to be pushed (${ghStatus.changedFiles.length})`
                    : 'Everything is in sync — no local changes.'}
                </div>

                {/* Commit message */}
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.6px', color: C.textFaint, marginBottom: 6 }}>COMMIT MESSAGE</div>
                  <input
                    value={commitMsg}
                    onChange={e => setCommitMsg(e.target.value)}
                    placeholder="e.g. Add agent chat loop and orchestrator"
                    style={inputStyle}
                  />
                </div>

                {/* Changed files (expandable) */}
                <div style={{ backgroundColor: C.rowBg, border: `1px solid ${C.borderSoft}`, borderRadius: 12, overflow: 'hidden' }}>
                  <button
                    type="button"
                    onClick={() => setShowFiles(o => !o)}
                    style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'transparent', border: 'none', padding: '10px 14px', fontSize: 13, color: C.textMid, cursor: 'pointer' }}
                  >
                    <span>
                      {ghStatus.changedFiles.length} changed file{ghStatus.changedFiles.length === 1 ? '' : 's'}{ghStatus.shortstat ? ` · ${ghStatus.shortstat}` : ''}
                    </span>
                    <span style={{ color: C.textFaint }}>{showFiles ? '▾' : '▸'}</span>
                  </button>
                  {showFiles && (
                    <div style={{ maxHeight: 180, overflowY: 'auto', borderTop: `1px solid ${C.borderSoft}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {ghStatus.changedFiles.map((f, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: MONO, padding: '4px 6px', borderRadius: 6 }}>
                          <span style={{ width: 20, flexShrink: 0, color: f.status.includes('D') ? C.red : f.status.includes('?') ? C.amber : C.green, fontWeight: 700 }}>
                            {f.status}
                          </span>
                          <span style={{ color: '#b8b8be', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file}</span>
                        </div>
                      ))}
                      {ghStatus.changedFiles.length === 0 && (
                        <div style={{ fontSize: 12, color: C.textFaint, padding: '4px 6px' }}>No changes.</div>
                      )}
                    </div>
                  )}
                </div>

                {ghError && <div style={errStyle}>{ghError}</div>}
                {ghResult && !ghError && <div style={okStyle}>{ghResult}</div>}

                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: C.textFaint, cursor: 'pointer' }}>
                  <input type="checkbox" checked={forcePush} onChange={e => setForcePush(e.target.checked)} />
                  Force push (overwrite remote history)
                </label>

                <button
                  type="button"
                  disabled={ghBusy || ghStatus.changedFiles.length === 0 || !commitMsg.trim()}
                  onClick={handleGithubPush}
                  style={mintBtn(ghBusy || ghStatus.changedFiles.length === 0 || !commitMsg.trim())}
                >
                  ↑ Push changes to GitHub
                </button>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
