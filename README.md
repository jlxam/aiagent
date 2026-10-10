# Agent25 — Local Qwen3-VL Full-Stack Coding & QA Agent

## What this application is
Agent25 is a standalone local AI coding agent. It uses Ollama for all LLM inference, a Node/Express backend for tools and workspace operations, and React/Vite for the Agent UI. VS Code, Cline, Roo Code, Gemini, OpenAI, or any cloud model are **not required**.

## Architecture

```text
Browser / Agent UI (React + Vite)
        |
        | /api and /preview
        v
Local Agent Backend (Node + Express :3002)
        |
        +--> Ollama :11434
        |      +--> qwen3:8b       (coding/reasoning)
        |      +--> qwen3-vl:8b    (images/video)
        |      +--> llama3.2:latest (text fallback)
        |      +--> llama3.2-vision:latest (vision fallback)
        |
        +--> FFmpeg / FFprobe (video frame extraction)
        |
        +--> Active workspace (read/write/build/test/preview)
```

## Preconditions — fresh machine setup

### Required software

1. **Windows 11 64-bit** (the current project is tuned for the supplied Windows 11 / 8-core / 16 GB+ system).
2. **Node.js 20.19+ or a current supported LTS release**. `node --version` must work in a new terminal.
3. **npm** (installed with Node.js). `npm --version` must work.
4. **Ollama** running locally. `ollama --version` must work and `http://localhost:11434` must be reachable.
5. **FFmpeg and FFprobe** on PATH for video analysis. Alternatively set `FFMPEG_PATH` and `FFPROBE_PATH` in `.env`.
6. **A browser** such as Chrome/Edge for the Agent UI and preview.

### Required local AI models

Run:

```powershell
ollama pull qwen3:8b
ollama pull qwen3-vl:8b
ollama pull llama3.2:latest
ollama pull llama3.2-vision:latest
ollama list
```

The required primary pair is:

- `qwen3:8b` — coding, reasoning, planning, debugging, tool use.
- `qwen3-vl:8b` — screenshot/image/video visual analysis and OCR.

The Llama models are local fallbacks. They are recommended for resilience but are not the primary pair.

### Verify FFmpeg

```powershell
ffmpeg -version
ffprobe -version
```

If these commands fail, install FFmpeg and restart the terminal, or set full paths in `.env`:

```text
FFMPEG_PATH=C:\path\to\ffmpeg.exe
FFPROBE_PATH=C:\path\to\ffprobe.exe
```

### Optional MySQL

MySQL is **optional**. The application falls back to a local file store when MySQL is unavailable. If MySQL is configured, set `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DATABASE` in `.env`.

## First-time installation

```powershell
cd <Agent25-folder>
npm install
copy .env.example .env
```

Confirm `.env` contains:

```text
OLLAMA_BASE_URL=http://localhost:11434
AGENT_MODEL=auto
AGENT_VISION_MODEL=qwen3-vl:8b
AGENT_TEXT_MODEL=qwen3:8b
AGENT_VISION_FALLBACK_MODEL=llama3.2-vision:latest
AGENT_FALLBACK_MODEL=llama3.2:latest
ROO_AGENT_ENABLED=true
ROO_AGENT_MODE=autonomous
ROO_AGENT_VERIFY=true
ROO_AGENT_PREVIEW=true
```

Then start:

```powershell
npm run dev
```

The frontend is intended to start on `http://localhost:5173`. If 5173 is occupied, the current Vite setting may move to the next port because `strictPort` is currently false. The backend is `http://127.0.0.1:3002` and Ollama is `http://localhost:11434`.

## AI system prompt configuration

The permanent agent system prompt is stored in:

```text
agent-system-prompt.md
```

`server/agentService.js` loads this file and injects it into the Ollama system message. This is the correct place to customize autonomous behavior, SDLC rules, visual-analysis rules, verification requirements, and model policy.

`project-instructions.md` remains the project-specific instruction layer.

`roo-agent.config.json` remains the machine-readable model/agent configuration.

## Mobile Android/iOS development

The Agent UI now includes a **Mobile** mode with an Android + iOS / Android / iOS target selector. In Mobile mode the agent receives explicit React Native + Expo + TypeScript guidance and follows a mobile-specific verification policy. See `MOBILE_DEVELOPMENT.md`.

On Windows, Android can be built/tested when the Android SDK/Gradle/Expo tooling is installed. iOS source can be developed, but native Xcode build/simulator/signing verification requires macOS. The agent must report that limitation rather than claiming an unverified iOS build.

## Processing timeline UI

While a task is running, the Agent UI displays a live Freebuff-style timeline with icons for:

- Thinking — model reasoning/tool decision
- List — project/file discovery
- Read — file inspection
- Search — code search
- Write — source changes
- Run — build/test/command execution
- Attachment — image/video/media processing
- Preview — preview refresh
- SDLC — Discover → Plan → Implement → Verify → Preview

A green check means the event actually completed; a spinner means it is running; a red X means that event failed. The UI must not present a successful verification merely because the model returned text.

## Visual debugging flow

```text
Image
  -> qwen3-vl:8b
  -> observed visual evidence
  -> qwen3:8b
  -> source investigation
  -> implementation
  -> verification
  -> preview

Video
  -> FFprobe
  -> FFmpeg timestamped frames
  -> qwen3-vl:8b (one frame/request)
  -> visual evidence
  -> qwen3:8b
  -> implementation
  -> verification
  -> preview
```

## Evaluation suite

Use `AI_CODING_AGENT_EVALUATION_SUITE.md` to test the five requested scenarios separately. Do not paste all five modules into the permanent system prompt; doing so would cause normal user requests to be mixed with unrelated evaluation tasks.

Run it with the automated harness:

```powershell
npm run test:eval             # all 5 modules end-to-end via the real agent API
npm run test:eval -- --modules 1,4  # subset
npm run test:eval:self        # prove the checks detect each seeded defect (no model)
```

Each module seeds a disposable workspace under `.data/`, runs one agent task
(local qwen3 only), applies a deterministic verifier (typecheck, jsdom
interaction, hydration, live Express requests, vision-evidence rows), and allows
one corrective retry with the failing checks fed back. Results land in
`EVALUATION_RESULTS.md`.

## Important files

| File | Purpose |
|---|---|
| `agent-system-prompt.md` | Permanent autonomous coding/QA/SDLC system prompt |
| `AI_CODING_AGENT_EVALUATION_SUITE.md` | Five-module evaluation scenarios |
| `roo-agent.config.json` | Ollama/model/agent configuration |
| `.env` / `.env.example` | Runtime model, timeout, media settings |
| `server/agentService.js` | Agent loop, tools, prompts, media/vision routing |
| `server/routes.js` | Agent/workspace API routes |
| `server.js` | Express backend + preview server |
| `src/components/AgentStudio.tsx` | Main Agent UI + processing timeline |
| `src/services/agentApi.ts` | Browser-to-agent API client and streaming events |
| `vite.config.ts` | Frontend port and `/api`/`/preview` proxy |
| `project-instructions.md` | Project-specific agent rules |
| `.roo/rules/agent21-local.md` | Local-agent operating rules |
| `scripts/check-vision.mjs` | Image/video vision smoke test |
| `scripts/check-agent-e2e.mjs` | End-to-end agent test |

## Verification commands

```powershell
npm run build
node scripts/check-vision.mjs "C:\path\to\image.png"
node scripts/check-vision.mjs "C:\path\to\bug-video.mp4"
npm run test:e2e
npm run test:eval:self
npm run test:eval
```

A task is considered successful only when the relevant real verification passes.


## Current project structure (Agent27)

```text
Agent27/
├── src/
│   ├── App.tsx                         # React app root
│   ├── main.tsx                        # Browser entry point
│   ├── index.css                       # Global styles and appearance switch
│   ├── config.ts                       # Frontend API routing configuration
│   ├── components/
│   │   ├── AgentStudio.tsx              # Main UI: navigation dropdown, prompt, timeline, queue, preview, theme toggle
│   │   └── WorkspaceSelector.tsx        # Workspace/folder selector
│   └── services/
│       ├── agentApi.ts                  # Agent task, stream, attachment, history API
│       ├── githubApi.ts                 # GitHub connection/status/actions
│       └── orchestratorApi.ts           # App orchestrator controls
├── server.js                           # Express backend entry point
├── server/
│   ├── routes.js                       # Main API endpoints
│   ├── agentService.js                 # Agent loop, model routing, tools, attachment/vision processing
│   ├── db.js                           # Persistent store/database integration
│   ├── githubRoutes.js                 # GitHub API routes
│   ├── githubService.js                # GitHub operations
│   ├── orchestratorRoutes.js           # Orchestrator endpoints
│   └── orchestratorStore.js            # Orchestrator state
├── agent-system-prompt.md              # Main system behavior and SDLC instructions
├── roo-agent.config.json               # Local model and agent configuration
├── .env / .env.example                 # Runtime environment settings (keep secrets out of source control)
├── scripts/                            # Config, media, mobile and evaluation checks
├── MOBILE_DEVELOPMENT.md               # Android/iOS development guidance
├── AI_CODING_AGENT_EVALUATION_SUITE.md # Five-module evaluation scenarios
├── vite.config.ts                      # Frontend dev server and /api + /preview proxy
├── dev.js                              # Starts the local frontend/backend development processes
└── package.json                        # Scripts and dependencies
```

## Current UI layout and customization

- **Two primary work areas:** the agent prompt/feed on the left and sandbox preview/terminal on the right.
- **Navigation is collapsed by default.** Use the **Menu** button in the agent header to reveal/hide the icon rail, project list, previous sessions, sandbox shortcut, GitHub, and App Orchestrator navigation.
- **Suggestions** are displayed directly above the prompt composer. Select a suggestion to populate the prompt; it does not submit automatically.
- **Light/Dark** toggles the dark-first interface palette. Because most legacy controls use inline color styles, light mode uses a reversible color transform; review any third-party embedded content in both modes.
- Customize the layout, prompt suggestions, navigation controls, and theme toggle in `src/components/AgentStudio.tsx`; global appearance behavior is in `src/index.css`.

## Current local LLM and agent design

- **Ollama** (`http://localhost:11434`) runs inference locally; the application does not require Gemini or a cloud LLM when cloud fallback is disabled.
- **`qwen3:8b`** is the primary text/coding/reasoning model configured by `AGENT_TEXT_MODEL`.
- **`qwen3-vl:8b`** is the primary visual model configured by `AGENT_VISION_MODEL`, intended for screenshots and sampled video frames.
- **`llama3.2:latest`** and **`llama3.2-vision:latest`** are optional text and vision fallbacks, if installed and enabled in `.env`.
- **`server/agentService.js`** implements the server-side agent flow; `agent-system-prompt.md` defines the agent's system behavior; `roo-agent.config.json` and `.env` provide runtime model settings.
- **Frontend dev server:** `vite.config.ts` currently requests port `5173` and allows Vite to choose another port if 5173 is occupied (`strictPort: false`).
- **Backend:** `server.js` serves the local API, typically on port `3002`. Vite forwards `/api` and `/preview` to that backend.

### Quick verification

```powershell
npm install
npm run test:config
npm run test:mobile
npm run build
```

A successful config check does not replace the production build or live verification. For Android native builds, install the Android SDK/JDK; for native iOS builds and Simulator verification, use macOS with Xcode.
