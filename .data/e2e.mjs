import { runAgentLoop } from '../server/agentService.js';
import * as db from '../server/db.js';
import fs from 'fs/promises';
await db.init();
const ws = 'D:/Antony/React3/Agent28/.data/e2e-ws';
const t0 = Date.now();
const ev = [];
try {
  const r = await runAgentLoop('e2e-1', 'inspect the project structure and add a contact form', 'auto', ws, e => ev.push(e), [], null);
  console.log('reply  :', String(r.reply).slice(0, 140));
  console.log('tool   :', JSON.stringify(r.toolCall));
  console.log('model  :', r.modelUsed);
} catch (e) { console.log('threw  :', String(e.message).slice(0,140)); }
console.log('elapsed:', Date.now() - t0, 'ms');
console.log('steps  :', ev.filter(e => e.type === 'step').map(e => `${e.kind}:${e.status}`).join(' '));
console.log('files  :', (await fs.readdir(ws)).join(', ') || '(none)');
process.exit(0);
