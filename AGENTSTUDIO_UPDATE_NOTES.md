# AgentStudio update — 2026-10-04

## Changes
- Added a real sequential task queue. New tasks can be entered and queued while another task is running.
- Queued tasks retain their text, selected model, workspace, and attachments.
- Failed tasks remain visible with Retry instead of disappearing.
- Added multi-file attachment support for images/screenshots, videos, ZIP/archive files, and common binary files.
- Added direct binary upload endpoint (`/api/agent/upload`) so large files are not sent as base64 JSON.
- Added attachment inspection/read/extract tools for the local agent.
- ZIP archives can be safely extracted into `.agent-imports` inside the active workspace.
- Videos are stored and sampled into a small number of frames with ffmpeg when available.
- Vision attachments automatically select an installed vision-capable model when one is available; otherwise the agent reports a clear model capability error.
- Strengthened the autonomous agent instructions so it inspects the workspace/attachments instead of repeatedly asking the user for information it can discover itself.
- Added one autonomous retry when the model responds with an unnecessary request for more information on an implementation task.
- Increased the server/client task window and added a one-time model fallback on Ollama timeout for non-visual tasks.
- Changed the primary local routing to `qwen3:8b` for coding/text and `qwen3-vl:8b` for visual tasks; `llama3.2-vision:latest` remains the local vision fallback.
- Added Ollama model capability discovery to the health endpoint.

## Files changed
- `src/components/AgentStudio.tsx`
- `src/services/agentApi.ts`
- `server/routes.js`
- `server/agentService.js`

## Validation
- `node --check server/agentService.js` — passed
- `node --check server/routes.js` — passed
- `node --check server.js` — passed
- Full `npm run build` could not be completed in this isolated environment because the uploaded project did not contain `node_modules` and the environment could not download the complete npm dependency set. The source JavaScript syntax checks passed.

## Install/run on Windows
After replacing the project source, run:

```bat
npm install
npm run build
npm start
```

For development:

```bat
npm run dev
```

Make sure Ollama is running and that `qwen3:8b` and `qwen3-vl:8b` are installed. `llama3.2-vision:latest` is recommended as the local vision fallback.

## 2026-10-04 — Persistent history, database-backed queue, reload recovery

Implemented in this update:

- Active session ID is persisted in browser localStorage and restored after refresh.
- Conversation history is loaded from the backend on startup instead of starting with an empty UI.
- MySQL schema is automatically migrated with session metadata, message task IDs/attachments, and a new `agent_tasks` table.
- Queue items are saved to MySQL immediately when submitted, before processing starts.
- Queue status (`queued`, `uploading`, `running`, `done`, `error`) is persisted and updated during processing.
- Interrupted `running`/`uploading` tasks are recovered to `queued` when a session is reopened, so they are not lost after a browser refresh.
- Saved threads are available through the Search threads panel and can be reopened.
- User task messages and attachment metadata are stored in the database.
- Deterministic build/preview/inspection replies are persisted too.
- MySQL indexes were added for session/message/task lookups to improve history and queue performance.
- File-store fallback remains available when MySQL is unavailable.
- File-store writes are debounced to reduce disk I/O during rapid queue/message updates.
- Model requests continue using the existing streaming heartbeat path and fast-model fallback behavior.

Validation:
- `node --check` passed for `server/db.js`, `server/routes.js`, and `server/agentService.js`.
- Full frontend build could not be completed in the isolated build environment because the ZIP does not include `node_modules` and dependency installation timed out. Run `npm install` followed by `npm run build` on the Windows development machine.


## 2026-10-04 v3 — autonomous editing, queue UX and fast preview
- Fixed `ENOTDIR: not a directory, scandir` when the model accidentally passes a file path to `list_files` or `search_files`.
- Added filesystem-tool recovery so path/type mistakes are fed back to the agent instead of terminating the task or prompting the user.
- Added explicit standing authorization in the agent system prompt: normal non-destructive edits, builds, tests and preview refreshes do not require confirmation.
- Expanded autonomy detection/retry for confirmation questions and clarification requests; the agent can retry autonomously up to two times within the tool budget.
- Removed persisted tool messages from the model's replayed conversation context because treating tool output as user messages caused unnecessary confirmation/clarification behavior.
- Reduced replayed history from 10 to 8 turns and clipped individual history entries for faster local Ollama inference.
- Added a best-effort fast preview refresh after each completed agent task. It first reloads an existing preview server and only starts/prepares preview when needed; it never blocks the queue.
- Queue composer remains usable while another task is running and the send button explicitly queues the task.

## 2026-10-04 v4 — mandatory SDLC engineering loop
- Added a mandatory five-phase SDLC contract to the agent: Comprehension/Context → Strategy/Plan → Implementation → Verification/Self-Correction → Preview/Handover.
- Added automatic discovery of optional workspace instructions: `project-instructions.md`, `AGENTS.md`, or `.agent-instructions.md` (first matching file, capped at 30,000 characters).
- Added `Agent13/project-instructions.md` with the requested autonomy, safety, TypeScript, port, error-handling, and verification rules.
- Added an SDLC progress event at task start so the UI can show the lifecycle instead of only generic thinking.
- Applied the same lifecycle/autonomy rules to the native Ollama tool path and the Gemma JSON-tool compatibility path.
- The agent is explicitly required to verify modified code before declaring completion and to self-correct verification failures.
- The agent is explicitly forbidden from repeatedly asking for confirmation for work already authorized by the user's task.
