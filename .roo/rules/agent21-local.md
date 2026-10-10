# Agent21 Local Roo-style Agent Rules

- Runtime: Agent21's built-in local agent; VS Code is not required.
- Provider: Ollama on http://localhost:11434.
- Text/coding model: qwen3:8b.
- Vision model: qwen3-vl:8b.
- Vision fallback: llama3.2-vision:latest.
- Never use cloud LLM APIs, Gemini, or external model fallbacks.
- For screenshots/video, perform local visual analysis before editing source files.
- For video, use locally extracted timestamped frames as evidence.
- For implementation requests: inspect -> plan -> edit -> verify -> preview.
- Use workspace tools instead of asking the user to paste files.
- Do not claim a fix without running an appropriate verification step.
- Never expose secrets.

- Permanent system prompt: agent-system-prompt.md.
- Evaluation scenarios: AI_CODING_AGENT_EVALUATION_SUITE.md; use them only when explicitly testing the agent.
