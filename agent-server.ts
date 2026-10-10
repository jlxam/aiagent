import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);
const app = express();
app.use(express.json());
app.use(cors());

// Workspace targets this LocalAgent folder
const WORKSPACE_DIR = __dirname;

// 1. Endpoint for the agent to write/update generated code files
app.post('/api/agent/write-file', async (req, res) => {
    const { filePath, content } = req.body;
    try {
        const fullPath = path.join(WORKSPACE_DIR, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        res.json({ success: true, message: `Successfully wrote ${filePath}` });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Endpoint to verify code builds properly
app.post('/api/agent/verify', async (req, res) => {
    try {
        const { stdout } = await execPromise('npm run build', { cwd: WORKSPACE_DIR });
        res.json({ success: true, output: stdout });
    } catch (error: any) {
        res.status(400).json({ success: false, error: error.stderr || error.message });
    }
});

// Health check for the Ollama engine
app.get('/api/agent/health', async (req, res) => {
    try {
        const r = await fetch('http://localhost:11434/api/tags');
        if (!r.ok) throw new Error(`Ollama responded with status: ${r.status}`);
        const data = await r.json();
        res.json({ success: true, models: (data.models || []).map((m: any) => m.name) });
    } catch (error: any) {
        res.status(502).json({ success: false, error: `Ollama unreachable: ${error.message}` });
    }
});

// 3. Streaming endpoint for local Ollama LLM execution (DeepSeek-R1 / Gemma / Llama)
// Ollama streams NDJSON (one JSON object per line). Lines can be SPLIT across TCP chunk
// boundaries, so we buffer across reads and only parse complete lines. Each token is then
// re-emitted to the browser as an SSE `data:` event.
app.post('/api/agent/generate', async (req, res) => {
    const { model = 'qwen3:8b', prompt, stream } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ success: false, error: 'A non-empty "prompt" is required.' });
    }

    const controller = new AbortController();
    // Listen on res (not req): in modern Node, req 'close' fires once the request
    // body is consumed, which would abort instantly.
    res.on('close', () => {
        if (!res.writableEnded) controller.abort();
    });

    try {
        const ollamaRes = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, stream: stream !== false }),
            signal: controller.signal
        });

        if (!ollamaRes.ok) {
            const errText = await ollamaRes.text().catch(() => '');
            throw new Error(`Ollama responded with status: ${ollamaRes.status} ${errText}`.trim());
        }

        if (stream === false) {
            const data = await ollamaRes.json();
            return res.json({ success: true, text: data.response || '' });
        }

        // --- SSE streaming mode ---
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const sendSSE = (obj: object) => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };

        const reader = (ollamaRes.body as any).getReader();
        const decoder = new TextDecoder();
        let buffer = '';   // accumulates partial NDJSON lines across chunks
        let fullText = '';
        let doneSent = false;

        const processLine = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed.response === 'string' && parsed.response.length > 0) {
                    fullText += parsed.response;
                    sendSSE({ text: parsed.response });
                }
                if (parsed.error) {
                    sendSSE({ error: parsed.error });
                }
                if (parsed.done) {
                    doneSent = true;
                    sendSSE({ done: true, text: fullText, total_duration: parsed.total_duration, eval_count: parsed.eval_count });
                }
            } catch {
                // Incomplete or unexpected line — skip rather than kill the stream.
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                processLine(line);
            }
        }

        buffer += decoder.decode();
        if (buffer.trim()) processLine(buffer);

        if (!res.writableEnded) {
            if (!doneSent) sendSSE({ done: true, text: fullText });
            res.end();
        }
    } catch (error: any) {
        const aborted = error?.name === 'AbortError';
        if (!aborted) {
            console.error('[Server Error in /api/agent/generate]:', error?.message);
        }
        if (!res.headersSent) {
            res.status(502).json({ success: false, error: error?.message });
        } else if (!res.writableEnded) {
            // NOTE: sendSSE is out of scope here (declared inside try), so write directly.
            res.write(`data: ${JSON.stringify({ error: aborted ? 'Client disconnected' : error?.message, done: true })}\n\n`);
            res.end();
        }
    }
});

app.listen(3002, () => console.log('LocalAgent bridge running on port 3002'));