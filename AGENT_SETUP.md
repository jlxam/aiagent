# LocalAgent – optimized setup (2026-10-02)

## Recommended Ollama models for this 16 GB RAM PC

The UI discovers installed Ollama models automatically. The default/primary agent is:

```bat
ollama pull qwen3:8b
```

Recommended roles:

- `qwen3:8b` — primary coding/task agent with native tools
- `deepseek-r1:8b` — deeper reasoning; the app falls back to compatibility mode if native tools are rejected by the installed Ollama build
- `llama3.2:latest` — lightweight tool-capable alternative

Gemma 2 can remain installed for chat, but it is not required for the coding agent.

## Start

From `D:\Antony\React3\LocalAgent`:

```bat
npm install
npm start
```

In a second terminal:

```bat
npm run dev
```

Or use `restart-localagent.bat` to stop stale listeners on ports 3002/5173 and start both processes from the extracted folder.

Open `http://localhost:5173`.

## Project loading

The Projects list is refreshed automatically every 8 seconds and also has a manual refresh button. Click the **project row/name** to make that folder the active AI workspace.

Activation is optimistic: the UI immediately switches to the selected project and stores its path locally, then the backend validates/resolves the canonical path. This prevents an older backend returning a temporary 404 from leaving the previous project active.

The **Open folder ↗** action only opens Windows Explorer and does not change the active workspace. It stops event bubbling so it cannot accidentally select the wrong project.

New folders added beside LocalAgent are picked up automatically by the project poll/refresh.

## Agent execution

Tools are scoped to the selected workspace:

- `inspect_project` — fast project overview + key config files in one call
- `search_files`
- `list_files`
- `read_file`
- `write_file`
- `execute_code` (Python/JavaScript)
- `run_command` (npm/Node/build/test commands)

Qwen3/Llama/DeepSeek first use native tool calling. DeepSeek automatically falls back to the JSON compatibility protocol if native tools are rejected.

## Performance improvements

- Qwen3 8B is preferred when installed.
- The selected primary model is warmed in the background after engine health detection.
- Ollama keep-alive increased to 30 minutes to avoid repeated model reloads.
- Context is capped at 3072 tokens for this CPU-only 16 GB machine.
- Output budget is limited to 1024 tokens for Qwen/Llama and 1536 for DeepSeek.
- Model is configured for 8 CPU threads.
- Recent history is limited to 2 rows for task calls.
- Tool rounds are capped at 4; each native turn accepts at most 2 tool calls.
- `inspect_project` reduces the common list/read/list/read tool chain to one call.
- Simple workspace-status questions are answered locally without waking Ollama.
- The browser waits up to 180 seconds for a real task, with a clearer timeout message.

## Orchestrator safety

The built-in **LocalAgent Studio** card is the server currently serving this page. Its Backend/Frontend controls are therefore shown as **Current Backend/Current Frontend** and cannot accidentally stop the application from underneath itself. Other registered applications keep their Up/Stop controls.

## Bottom-left sidebar

The old visible **History store** label was removed from the primary navigation because it is implementation detail rather than a user action. The footer now shows the active workspace, which is more useful when multiple projects are loaded.

## 2026-10-02 timeout/UI fix
- Qwen3:8b uses Ollama thinking-disabled mode for fast agent/tool routing on CPU-only systems.
- DeepSeek-R1 retains thinking mode for deeper reasoning.
- Qwen3 context/prediction limits were reduced for the 16 GB CPU configuration.
- The engine now warms the preferred model before normal use.
- Read-only project inspection is handled locally through `/api/workspace/inspect`, avoiding an LLM load for simple repository-overview questions.
- Right-side logs/chat typography was increased and brightened.
- Added the supplied play-button favicon at `public/favicon.png`.
