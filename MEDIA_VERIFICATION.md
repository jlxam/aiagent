# Agent23 local image/video verification

## Models

- `qwen3:8b` — coding/reasoning
- `qwen3-vl:8b` — screenshot/image/video-frame analysis
- `llama3.2-vision:latest` — vision fallback
- No cloud/Gemini route is used.

## Windows prerequisites

From the same Command Prompt used to start Agent23:

```bat
ollama list
ffmpeg -version
ffprobe -version
```

The recommended models are:

```bat
ollama pull qwen3:8b
ollama pull qwen3-vl:8b
```

## Direct vision smoke test

Before testing the UI, bypass the browser and test the exact local media pipeline:

```bat
node scripts/check-vision.mjs "C:\path\to\screenshot.png"
node scripts/check-vision.mjs "C:\path\to\bug-video.mp4"
```

Expected final line:

```text
VISION SMOKE TEST: PASS
```

For video, the script reports the number of extracted frames and analyzes them one at a time. This avoids sending a large multi-image request to Qwen3-VL on a 16 GB RAM machine.

## Regression checks

```bat
node scripts/check-media.mjs
```

For a real Ollama-backed end-to-end check:

```bat
node scripts/check-agent-e2e.mjs
```

## Start Agent23

```bat
npm install
npm run build
npm start
```

Or:

```bat
npm run dev
```

After changing `.env`, restart Agent23 so the server reloads the settings.

## Expected visual routing

Image:

```text
image -> qwen3-vl:8b -> visual evidence -> qwen3:8b -> coding/project work
```

Video:

```text
mp4 -> ffprobe -> ffmpeg -> timestamped JPG frames
    -> qwen3-vl:8b (one frame per request)
    -> combined visual evidence -> qwen3:8b
```

If Qwen3-VL fails, Agent23 tries `llama3.2-vision:latest` as the local fallback. It never switches to Gemini or another cloud API.
