# Agent17 V13 — Persistent Previous Task / Chat History

## What changed
- Added a **Previous tasks** panel in the left sidebar.
- The panel loads persisted sessions from `GET /api/agent/sessions` (MySQL primary, JSON fallback).
- Users can search previous sessions/tasks and click any entry to reopen it.
- Selecting a previous session reloads its persisted messages, attachments, workspace, and unfinished task queue.
- Reloading the browser keeps the active session ID and restores the conversation from the database.
- Switching between historical sessions no longer requires starting a new session.
- The selected historical session is highlighted.
- The history list shows task title, workspace, message count, and last updated time.

## Existing persistence retained
The existing MySQL tables remain the source of truth:
- `chat_sessions`
- `agent_messages`
- `agent_tasks`
- `execution_logs`

No destructive database migration is required for V13.

## Run
```powershell
npm install
npm run build
npm run dev
```

Then open `http://localhost:5173`.
