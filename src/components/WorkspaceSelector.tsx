import React, { useEffect, useState } from 'react';
import { BACKEND_URL } from '../config';

/** Shape returned by GET/POST /api/workspace — structurally matches the
 * WorkspaceProject list entries used by AgentStudio's selectProject(). */
export interface WorkspaceSwitchResult {
  id?: string;
  name: string;
  path: string;
  relativePath?: string;
}

interface WorkspaceSelectorProps {
  /** The workspace AgentStudio currently has active (kept in sync live). */
  activePath?: string;
  /** Called after a successful switch so the parent can run its full
   * selectProject flow (session reset, preview, persistence). */
  onSwitched?: (workspace: WorkspaceSwitchResult) => void;
}

/** Design tokens mirrored from AgentStudio's Freebuff-style palette. */
const C = {
  card: '#1b1c1d',
  inputBg: '#0e0f10',
  border: '#26262b',
  text: '#f4f4f5',
  textDim: '#a1a1aa',
  textFaint: '#71717a',
  blue: '#60a5fa',
  red: '#f87171',
  buttonBg: '#1d1d22'
};

/**
 * Workspace Switcher — type (or pick) a folder path and move the whole agent
 * workspace there. Every app lives in its own directory, so switching keeps
 * projects completely isolated: agent writes, previews, and terminal runs all
 * target only the active workspace path.
 */
export default function WorkspaceSelector({ activePath, onSwitched }: WorkspaceSelectorProps) {
  const [workspace, setWorkspace] = useState('');
  const [inputPath, setInputPath] = useState('');
  const [createIfMissing, setCreateIfMissing] = useState(true);
  const [status, setStatus] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  // Initial value from the backend (before any project is selected).
  useEffect(() => {
    let alive = true;
    fetch(`${BACKEND_URL}/api/workspace`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (!alive || !data?.workspace?.path) return;
        setWorkspace(data.workspace.path);
        setInputPath((prev) => prev || data.workspace.path);
      })
      .catch(() => { /* backend not up yet — parent selection fills this in */ });
    return () => { alive = false; };
  }, []);

  // Track the active project chosen from the sidebar list.
  useEffect(() => {
    if (!activePath) return;
    setWorkspace(activePath);
    setInputPath(activePath);
  }, [activePath]);

  const handleSwitch = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = inputPath.trim();
    if (!target || busy) return;
    setBusy(true);
    setStatus('Switching workspace…');
    setStatusIsError(false);
    try {
      const res = await fetch(`${BACKEND_URL}/api/workspace/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPath: target, create: createIfMissing })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.workspace?.path) {
        setWorkspace(data.workspace.path);
        setInputPath(data.workspace.path);
        setStatus(`Active → ${data.workspace.name}`);
        setStatusIsError(false);
        onSwitched?.(data.workspace);
        window.setTimeout(() => setStatus(''), 3000);
      } else {
        setStatus(`Error: ${data.error || `HTTP ${res.status}`}`);
        setStatusIsError(true);
      }
    } catch {
      setStatus('Failed to connect to backend.');
      setStatusIsError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: `1px solid ${C.border}`, background: C.card, borderRadius: 9, padding: '8px 8px 9px', marginBottom: 9 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, letterSpacing: '0.2px', marginBottom: 6 }}>
        Active Workspace
      </div>
      <div
        title={workspace || 'No workspace selected'}
        style={{ fontSize: 10.5, color: C.textFaint, fontFamily: "ui-monospace, 'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 6 }}
      >
        {workspace || '—'}
      </div>
      <form onSubmit={handleSwitch} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          type="text"
          value={inputPath}
          onChange={(e) => setInputPath(e.target.value)}
          placeholder="Enter folder path (e.g. D:/Antony/React3/AppTwo)"
          spellCheck={false}
          style={{ width: '100%', boxSizing: 'border-box', background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 11.5, color: C.text, outline: 'none' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: C.textFaint, cursor: 'pointer', flex: 1, minWidth: 0 }}>
            <input
              type="checkbox"
              checked={createIfMissing}
              onChange={(e) => setCreateIfMissing(e.target.checked)}
              style={{ accentColor: C.blue, margin: 0, flexShrink: 0 }}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Create if missing</span>
          </label>
          <button
            type="submit"
            disabled={busy || !inputPath.trim()}
            style={{ background: busy ? C.buttonBg : C.blue, color: busy ? C.textDim : '#0e0f10', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 11.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer', flexShrink: 0 }}
          >
            {busy ? 'Switching…' : 'Switch Folder'}
          </button>
        </div>
      </form>
      {status ? (
        <div style={{ fontSize: 10.5, marginTop: 6, color: statusIsError ? C.red : C.blue, wordBreak: 'break-word' }}>
          {status}
        </div>
      ) : null}
    </div>
  );
}
