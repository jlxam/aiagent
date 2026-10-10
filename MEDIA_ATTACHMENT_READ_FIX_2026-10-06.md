# Media attachment read fix — 2026-10-06

## Fixed issues

1. Visual read-only requests such as `read attached image and print text` now stop after the Qwen3-VL visual pass. They no longer get routed to qwen3:8b for a second attachment/tool lookup.
2. Attachment tools now accept the real upload id **and** the attachment filename/stored filename. This prevents `Unknown attachment: screenshot.png` when a local model echoes the filename instead of the generated id.
3. If a user explicitly supplies a Windows absolute path and its basename exactly matches a known uploaded attachment, the attachment resolver can use that file as a controlled recovery path.
4. The frontend retries attachment uploads directly against `127.0.0.1:3002` when the Vite proxy/backend path returns an error.
5. The visual prompt now has a dedicated OCR/text-extraction mode and tells Qwen3-VL to print only readable text/URLs without inventing missing characters.
6. Coding/debug tasks with visual evidence continue to qwen3:8b after Qwen3-VL analysis. The code no longer switches the coding model back to a vision model after the visual pass.

## Expected flows

### Image OCR

Upload image + `read attached image and print text` -> Qwen3-VL -> direct answer.

### Video OCR

Upload MP4 + `read video and print visible text/URL` -> FFmpeg/FFprobe -> timestamped frames -> Qwen3-VL per frame -> direct answer.

### Visual bug fix

Upload screenshot/video + `find the bug and fix it` -> Qwen3-VL evidence -> qwen3:8b source investigation/edit/verify.

No Gemini/cloud API is used.

## Later the same day — queries that paste a file path instead of uploading

The acceptance queries below used to fail because nothing was uploaded, so the
turn had no attachment and fell through to the text model:

```text
Image test:D:\Antony\Temp\refscrsh.png
Read the attached image with Qwen3-VL.
Extract the exact URL visible in the image.
Print ONLY the URL.

Video test:D:\Antony\Temp\vid.mp4
Read the attached video with Qwen3-VL.
Inspect all extracted video frames.
Find the URL visible on screen.
Print the exact URL and the timestamp where it appears.
```

What changed in `server/agentService.js`:

1. `collectMessageAttachments()` scans the **user's own message** for absolute
   paths (Windows `D:\...`, POSIX `/...`, quoted paths with spaces) and joins
   them to the turn as attachments with `sourcePath`. The file is read in place,
   no upload copy is made, and only the message text is scanned — model tool
   arguments never create a `sourcePath`, so this is not an arbitrary-read
   primitive. Media paths that do not exist are reported back in the message
   instead of being guessed at.
2. `resolveAttachment()` opens `sourcePath` attachments directly, so the normal
   image/video pipeline (sniffing, FFmpeg frames, one-frame-per-request vision
   calls) works unchanged for user-typed paths.
3. `isVisualReadOnlyRequest()` now ignores negated instructions (`Do not guess
   or modify the URL`) and headings such as `Image test:` when deciding whether
   the task is read-only. Both queries above now classify as read-only, so the
   answer comes straight from Qwen3-VL and never enters the coding loop.
4. Read-only visual prompts state the output format literally (`Print ONLY the
   URL` → nothing else), single-image answers carry no frame banner, and a
   multi-frame video answer is merged into one reply (URL + timestamp) by a
   final Qwen3-VL call. If that merge cannot finish, the per-frame headers are
   stripped as a fallback.
5. `Unknown attachment` tool errors are recoverable in both tool loops, so a
   model that echoes a filename cannot abort the turn.

Regression checks: `node scripts/check-media.mjs` (scenarios `message-path`,
`visual-readonly`) and `node scripts/check-agent-e2e.mjs` (scenario 3 renders a
screenshot containing a URL, then runs the query with no upload).
