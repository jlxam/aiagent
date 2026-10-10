# Agent26 Project Instructions

## Local AI architecture
- This application is a standalone local AI coding agent. VS Code and external coding-agent extensions are not required.
- Ollama is the only model provider.
- `qwen3:8b` is the primary text/coding agent.
- `qwen3-vl:8b` is the primary local vision model for screenshots and video evidence.
- `llama3.2-vision` is the local vision fallback.
- There is no Gemini, OpenAI, or other cloud fallback.

## Mandatory SDLC loop
1. Discover: inspect project structure, configuration, source, logs, and attachments.
2. Plan: determine the smallest safe change.
3. Implement: edit only relevant files.
4. Verify: run the smallest relevant build/typecheck/test/runtime check and self-correct failures.
5. Preview: refresh the Agent26 preview when supported.

## Visual debugging
- For screenshots, inspect the image before editing.
- For videos, use the locally extracted timestamped frames as evidence; do not pretend that a frame is a full video timeline.
- Report observed facts separately from hypotheses.
- Include visible errors, UI state transitions, and useful timestamps when available.

## Autonomy
- The user's requested development task authorizes normal non-destructive workspace operations.
- Do not ask for confirmation for ordinary edits, builds, tests, or preview refreshes.
- Never ask the user to paste source that the agent can read from the active workspace.

## Safety
- Keep all writes inside the active workspace.
- Never expose secrets, tokens, passwords, or private credentials.
- Preserve existing architecture and avoid unrelated rewrites.


## System prompt configuration
- The permanent autonomous system prompt is stored in `agent-system-prompt.md` and loaded by `server/agentService.js`.
- The five-module evaluation suite is stored separately in `AI_CODING_AGENT_EVALUATION_SUITE.md`; do not execute all five modules for ordinary tasks.
- `roo-agent.config.json` records the local Ollama models and system/evaluation prompt file names.


## Mobile development
- Mobile mode is enabled for Android and iOS development.
- Prefer React Native + Expo + TypeScript for new cross-platform apps unless the active workspace already uses another mobile stack.
- Preserve existing native Android/iOS architecture when present.
- Android verification must use a real Android/Expo/Gradle check when the required tooling is installed.
- iOS native build/simulator verification requires macOS/Xcode; on Windows, verify shared source and report the native limitation honestly.
- See `MOBILE_DEVELOPMENT.md` for the supported workflow and prerequisites.
