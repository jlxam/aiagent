# AgentStudio v6 update

## Attachment workflow
- Attachments are valid tasks even when the text box is empty.
- Supports Attach button, drag & drop, and pasted screenshots/images.
- Multiple attachments can be queued with each task.
- Image/video tasks automatically prefer a vision-capable Ollama model when available.
- Attachments are uploaded by the queue worker before the agent starts; the real stored attachment IDs are then persisted to the task and chat history.

## Agent execution
- Implementation tasks are explicitly required to perform discovery before writing.
- The agent is instructed not to answer with configuration/project explanations when the user requested a code change.
- Added a second/third autonomous retry when a model asks for confirmation, asks for information it can inspect, or returns an explanation-only response without using tools.
- Gemma/JSON compatibility mode now retains conversation history and attachment context and has the same autonomous retry behavior.
- ENOTDIR/scandir path mistakes remain recoverable.

## Preview
- Preview refresh remains non-blocking and is triggered after agent work so the next queued task is not delayed by preview startup.

## Verification
- `node --check server/agentService.js` passed.
- `node --check server/routes.js` passed.
- Full `npm ci`/frontend build could not be completed in the packaging environment because dependency installation timed out; no node_modules directory is included in this ZIP.
