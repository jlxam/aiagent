# Agent21 built-in Roo-style local agent

Agent21 now contains its own Roo-style autonomous coding workflow. **VS Code and the Roo Code extension are not required.**

## Local models

- `qwen3:8b` — text/coding/reasoning agent
- `qwen3-vl:8b` — screenshots and local video-frame visual debugging
- `llama3.2-vision:latest` — vision fallback
- `llama3.2:latest` — text fallback

## Recommended Ollama commands

```bat
ollama pull qwen3:8b
ollama pull qwen3-vl:8b
ollama pull llama3.2-vision:latest
```

If your existing Llama model has a different tag, keep it and the health screen will discover it automatically.

## How routing works

- Auto + normal text/coding task -> `qwen3:8b`
- Auto + screenshot/video -> `qwen3-vl:8b`
- If Qwen3-VL is unavailable -> installed vision model, preferably Llama 3.2 Vision
- No Gemini/API/cloud fallback exists in this build.

## Video handling

Agent21 stores the recording locally and uses FFmpeg to sample up to six representative timestamped frames. Those frames are passed to the local vision model together with the user's bug description. The model's visual report is then supplied to the coding agent before source inspection/editing.

## Agent workflow

1. Discover project structure
2. Inspect screenshot/video evidence when present
3. Read relevant source files
4. Implement the requested change
5. Run verification/build commands
6. Refresh the Agent21 preview when supported
7. Report exactly what was changed and verified
