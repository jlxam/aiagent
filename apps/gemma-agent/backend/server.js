import http from "node:http";

const PORT = Number(process.env.PORT || 5002);
const MODEL = process.env.OLLAMA_MODEL || "gemma2:9b";
const OLLAMA = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { success: true, model: MODEL, ollama: OLLAMA });
  if (req.method === "GET" && req.url === "/") return send(res, 200, { success: true, name: "Gemma Chat Bot", model: MODEL });
  if (req.method === "POST" && req.url === "/api/chat") {
    try {
      const input = await readBody(req);
      const prompt = String(input.prompt || "").trim();
      if (!prompt) return send(res, 400, { success: false, error: "prompt is required" });
      const r = await fetch(`${OLLAMA}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, prompt, stream: false }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, 502, { success: false, error: data.error || `Ollama HTTP ${r.status}` });
      return send(res, 200, { success: true, model: MODEL, reply: data.response || "" });
    } catch (e) { return send(res, 500, { success: false, error: e.message }); }
  }
  send(res, 404, { success: false, error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[App] Gemma Chat Bot backend on ${PORT} using ${MODEL}`));
