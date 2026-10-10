# Agent21 local image/video processing + Ollama timeouts

## What was fixed

### 1. Ollama timeouts raised well beyond 120 seconds

- Local vision remains Ollama-only; no Gemini/cloud route is used.
- Every model call timeout now comes from `parseTimeoutMs()`, and **`0` removes the
  limit entirely** (the abort timer is never armed, so the call waits until the
  model answers).

| Setting | Old | New | Purpose |
| --- | --- | --- | --- |
| `OLLAMA_TIMEOUT_MS` | 120 000 | **300 000** (5 min) | default per model call |
| `AGENT_MODEL_TIMEOUT_MS` | 120 000 | **300 000** (5 min) | fallback for the default per-call timeout |
| `OLLAMA_VISION_TIMEOUT_MS` | *n/a (capped at 180 s)* | **600 000** (10 min) | heavy vision/video analysis — shared budget across vision-candidate retries |
| `AGENT_TOTAL_TIMEOUT_MS` | 600 000 | **900 000** (15 min) | whole tool loop |
| browser (`sendAgentChat`) | hard 8 min abort | **25 min** | non-streaming route has no heartbeats |
| browser (`sendAgentChatStream`) | hard 8 min abort | **2 min of silence** | heartbeat-aware: reset on every chunk, so long turns survive |

- Set `OLLAMA_VISION_TIMEOUT_MS=0` (or `OLLAMA_TIMEOUT_MS=0`) for "run until the
  model answers".
- The vision candidate loop shares one budget: a hung vision model cannot stack
  its latency on top of the fallback candidates.

### 2. Efficient video frame sampling with graceful fallbacks

`extractVideoFrames()` in `server/agentService.js`:

1. **Single sequential pass** — one decode with `fps=1/<step>` (step =
   clip duration ÷ frame count, i.e. *one frame every few seconds*),
   `scale=<width>:-2`, `-frames:v <count>`, `-nostdin`. Bounded by
   `AGENT_FFMPEG_TIMEOUT_MS` (default 90 s).
2. **Seek fallback** — if the pass fails, times out, or FFmpeg dies, evenly
   spaced `-ss <timestamp>` fast seeks are tried instead (each bounded by
   `AGENT_FFMPEG_SEEK_TIMEOUT_MS`, default 20 s), which survives long clips and
   machines too slow for a full decode.
3. **Typed errors** — `FFMPEG_MISSING`, `FFMPEG_TIMEOUT`, `FFMPEG_FAILED`, with
   the FFmpeg stderr tail included in the message.

`prepareImageFrames()` never throws for media problems. It returns
`{ images, notes }`:

- FFmpeg missing → a **metadata note** (duration/resolution/codec/size from
  ffprobe, or just the file size) and the agent continues instead of crashing.
- FFmpeg present but failing/timing out → same fallback note.
- Unsupported image containers (SVG/TIFF/BMP) → converted to PNG via FFmpeg
  when available, otherwise a note explaining the expected formats.
- Images that Ollama decodes directly (JPEG/PNG/WebP/GIF) take a
  dependency-free path, so screenshots work with no FFmpeg installed.

When notes exist and no frames could be produced, the agent turn records a
`local_media_metadata_fallback` tool row and carries on with source inspection,
stating plainly that frame-level analysis was not possible.

### 3. Media kind is read from the file bytes

Browsers often upload screen recordings as `application/octet-stream` and
screenshots as `text/plain`, which previously skipped visual processing
entirely. `sniffMediaKind()` / `normalizeAttachmentKind()` inspect the first
bytes (JPEG/PNG/GIF/WEBP/BMP/TIFF, MP4/MOV `ftyp`, Matroska/WebM, AVI, HEIC)
and correct `kind`/`mimeType` before the visual-task decision is made.

## Verifying

```bash
# media pipeline + timeout regression checks (no model calls, ~30 s)
node scripts/check-media.mjs

# real end-to-end agent turns over HTTP (needs Ollama + models, minutes)
node scripts/check-agent-e2e.mjs
```

Restart the backend (`restart-localagent.bat` or `npm start`) after changing
`.env` — timeout values are read at process start.

## Windows requirement for video frames

Install FFmpeg and make sure both commands work from the same Command Prompt
used to start Agent21:

```bat
ffmpeg -version
ffprobe -version
```

Then run `restart-localagent.bat` from this extracted Agent21 folder, or:

```bat
winget install Gyan.FFmpeg
```

Without FFmpeg the app still works: screenshots are analyzed normally and
videos are handled through the metadata fallback described above. Diagnostics:
`GET /api/agent/media/diagnostics`.

## Recommended local models

```text
qwen3:8b                 text/coding agent
qwen3-vl:8b              primary screenshot/video vision
llama3.2-vision:latest   local vision fallback
```


## 2026-10-06 — Vision reliability fix

The visual path now sends **one image per Ollama `/api/chat` request** instead of placing many video frames in one `images` array. This avoids known Qwen3-VL/Ollama multi-image rendering/context problems and makes each video frame independently auditable. Video frames are timestamped in their attachment labels and then passed as textual evidence to the Qwen3 8B coding agent.

A new smoke test is available:

```bat
node scripts/check-vision.mjs path\to\image.png
node scripts/check-vision.mjs path\to\bug.mp4
```

The smoke test uses the same one-image-at-a-time Ollama request shape as Agent23.
