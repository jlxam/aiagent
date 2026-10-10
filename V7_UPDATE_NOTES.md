# AgentStudio v7

## Changes
- Added deterministic short answers for project/package/framework/database questions (for example, `what is the project name?`).
- Attachment tasks now perform a server-side inspection pass before the model's first reasoning turn.
- Added automatic selection of an installed vision-capable Ollama model for image/video tasks when the selected model cannot process visuals.
- Added attachment tool names to the JSON compatibility parser.
- Implementation requests that produce only an explanation without executing a tool are treated as incomplete and retried automatically.
- Existing SDLC, autonomous execution, ENOTDIR recovery, queue, persistence and preview behavior retained.

## Validation
- `node --check server/agentService.js` passed.
- `node --check server/routes.js` passed.
- Full `npm run build` could not be completed in this environment because dependencies are not installed; `npm ci --ignore-scripts` timed out. Run `npm install` then `npm run build` on Windows.
