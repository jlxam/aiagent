#!/usr/bin/env node
/**
 * AI Coding Agent Evaluation Suite runner.
 *
 *   node scripts/check-eval-suite.mjs                 # run all 5 modules
 *   node scripts/check-eval-suite.mjs --modules 1,4   # run a subset
 *   node scripts/check-eval-suite.mjs --keep          # keep workspaces
 *   node scripts/check-eval-suite.mjs --self-test     # prove the checks
 *                                                      # discriminate (no model)
 *
 * Each module is an independent user task against a disposable workspace:
 * seed files -> agent turn (local qwen3 stack over the real agent routes) ->
 * deterministic verification (typecheck, jsdom interaction, hydration, HTTP
 * route behavior, vision-evidence rows in history). --self-test runs the same
 * verifiers against the unfixed seed fixtures and asserts they FAIL, proving
 * the checks actually detect the defects they claim to detect.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  ROOT, makeWorkspace, writeWs, readWs, hasWs, listFiles,
  typecheck, nodeCheck, loadComponent, setupDom, click, typeInto,
  hydrationCheck, makeErrorLogPng, makeCheckoutFlowMp4, Report
} from './eval-helpers.mjs';

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const MODULES = (argValue('--modules', '1,2,3,4,5').split(',').map(s => s.trim()).filter(Boolean));
const KEEP = argv.includes('--keep');
const SELF_TEST = argv.includes('--self-test');
if (SELF_TEST) console.log('SELF-TEST: verifying that each module\'s checks FAIL against the unfixed seed fixtures.');
process.env.AGENT_MAX_TOOL_STEPS = process.env.AGENT_MAX_TOOL_STEPS || '12';
// CPU-only qwen3 turns can legitimately run past the production 15-minute
// budget when a module needs every tool step; the evaluation must not fail a
// module merely for the machine being slow. Still bounded at 30 minutes.
process.env.AGENT_TOTAL_TIMEOUT_MS = process.env.AGENT_TOTAL_TIMEOUT_MS || '1800000';

const only = id => MODULES.includes(String(id));

// --------------------------------------------------------------------------
// Agent transport (same pattern as check-agent-e2e.mjs)
// --------------------------------------------------------------------------
const db = await import('../server/db.js');
await db.init();

const app = express();
app.use(express.json({ limit: '10mb' }));
const { default: agentRouter } = await import('../server/routes.js');
app.use('/api/agent', agentRouter);
const listener = await new Promise(resolve => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${listener.address().port}`;

async function agentTurn({ sessionId, message, workspace, attachments = [] }) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/agent/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, model: 'auto', workspacePath: workspace, attachments })
  });
  const text = await res.text();
  const events = text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return {
    steps: events.filter(e => e.type === 'step'),
    final: events.find(e => e.type === 'final') || null,
    error: events.find(e => e.type === 'error') || null,
    elapsed: Date.now() - started
  };
}

async function historyRows(sessionId) {
  const res = await fetch(`${BASE}/api/agent/history/${encodeURIComponent(sessionId)}`);
  const data = await res.json().catch(() => ({}));
  return data.messages || [];
}

const visionInspected = rows =>
  rows.some(m => String(m.tool_call_json || '').includes('local_visual_analysis'));

const isLocalModel = name => {
  const s = String(name || '').toLowerCase();
  return (s.includes('qwen') || s.includes('llama')) && !/gemini|gpt|claude|openai|gemini/.test(s);
};

// --------------------------------------------------------------------------
// Seed fixtures (the unfixed inputs from AI_CODING_AGENT_EVALUATION_SUITE.md)
// --------------------------------------------------------------------------

const M1_ENTRY = 'src/UserTable.tsx';
const M1_SEED = `// TODO: Add proper types for User and Column props
export function UserTable({ data }: { data: any[] }) {
  // TODO: Implement sorting state and sorting logic here
  return (
    <div className="p-4">
      {/* TODO: Render table rows dynamically based on sorted data */}
    </div>
  );
}
`;

const M2_APP = `import express from 'express';
import { db } from './db.js';

const app = express();
app.use(express.json());

app.post('/api/users', async (req, res) => {
  const { name, email } = req.body;
  const user = await db.query(\`INSERT INTO users (name, email) VALUES ('\${name}', '\${email}')\`);
  res.json({ success: true, user });
});

export default app;
`;

const M2_DB = `// Test double for the harness: records every query and can simulate an
// unreachable database. The agent must keep this module and its interface.
export const db = {
  async query(sql, params = []) {
    globalThis.__dbCalls = globalThis.__dbCalls || [];
    globalThis.__dbCalls.push({ sql, params });
    if (globalThis.__dbFail) throw new Error('ECONNREFUSED database unreachable');
    return { rows: [{ id: globalThis.__dbCalls.length }], rowCount: 1 };
  }
};
export default db;
`;

const M3_ENTRY = 'src/DarkModeToggle.tsx';

const M4_ENTRY = 'src/components/LiveTimestamp.tsx';
const M4_SEED = `// Client component: hydrated by React after the server renders it.
export default function LiveTimestamp() {
  return (
    <p className="timestamp" data-testid="timestamp">
      Last updated: {new Date().toString()}
    </p>
  );
}
`;

const M5_ENTRY = 'src/CheckoutWizard.tsx';
const M5_SEED = `import { useState } from 'react';

const STEPS = ['Cart', 'Shipping', 'Payment'];

export default function CheckoutWizard() {
  const [step, setStep] = useState(1);
  const [postalCode, setPostalCode] = useState('');

  const next = () => {
    if (step === 2 && !postalCode.trim()) {
      // BUG: silent failure - loops back to Step 1 with no feedback.
      setStep(1);
      return;
    }
    setStep(s => Math.min(s + 1, STEPS.length));
  };

  return (
    <div className="checkout-wizard" data-testid="wizard">
      <p data-testid="step-indicator">Step {step} of {STEPS.length}: {STEPS[step - 1]}</p>
      {step === 2 && (
        <label>
          Postal code
          <input
            data-testid="postal-input"
            value={postalCode}
            onChange={e => setPostalCode(e.target.value)}
          />
        </label>
      )}
      <div data-testid="error-message" role="alert" />
      {step > 1 && (
        <button data-testid="back-button" onClick={() => setStep(s => Math.max(s - 1, 1))}>Back</button>
      )}
      {step < STEPS.length && (
        <button data-testid="next-button" onClick={next}>Next</button>
      )}
      {step === STEPS.length && (
        <button data-testid="place-order-button">Place order</button>
      )}
    </div>
  );
}
`;

// --------------------------------------------------------------------------
// Task messages (each module is a separate user task, per the suite doc)
// --------------------------------------------------------------------------

const TASKS = {
  1: {
    title: 'Incomplete Code Completion (UserTable)',
    message: `Task — Incomplete Code Completion. Complete the TypeScript React component at ${M1_ENTRY} (it contains TODO stubs).

Requirements:
- Define and export a User type ({ id: number; name: string; email: string }) and a Column type. Remove every \`any\`.
- Implement sorting state: clicking a column header sorts ascending, clicking again toggles descending.
- Render all rows dynamically from the sorted data inside a real <table>.

Automated verification contract (do not change these identifiers):
- Keep the named export \`UserTable\` in ${M1_ENTRY}.
- Each sortable column header must be a <button data-testid={\`sort-\${key}\`}> with key in id | name | email.
- Each body row must be <tr data-testid="user-row">.

Verify the result actually compiles (TypeScript is available in this repo) before you report success.`
  },
  2: {
    title: 'Failing Code Diagnosis & Refactoring (Express route)',
    message: `Task — Failing Code Diagnosis & Refactoring. The Express route in app.js crashes on malformed JSON payloads and when the database is unreachable, and it builds SQL by string interpolation (SQL injection).

Refactor app.js so that:
1. Malformed JSON bodies return HTTP 400 and never kill the process.
2. Missing name/email or an invalid email format returns HTTP 400 with a JSON body like { success: false, error: "..." }.
3. The INSERT uses a parameterized query — pass values as query parameters, never interpolate request data into SQL.
4. Database failures are caught and returned as HTTP 500 with a JSON error body; the process stays alive.
5. Valid input returns 2xx with { success: true, ... }.

Constraints for automated verification (do not break them):
- Keep app.js as an ES module with \`export default app\`, and do NOT call app.listen() in it — the harness mounts the app.
- Keep ./db.js and its \`db.query(sql, params)\` interface exactly; it is a test double, do not modify it.
- Do not install packages; express is already available.

Run a real verification (syntax check at minimum) before reporting success.`
  },
  3: {
    title: 'New Code Architecture (Dark Mode Toggle with persistence)',
    message: `Task — New Code Architecture & Development. Build a modular Dark Mode Toggle component with persistent state from scratch using React and Tailwind CSS in this workspace.

Requirements:
- Create ${M3_ENTRY} with \`export default function DarkModeToggle\`.
- State logic must live in its own module (e.g. src/useTheme.ts) — keep UI and state separated.
- Toggling applies/removes the \`dark\` class on document.documentElement and persists the choice in localStorage key \`theme\` ("dark" | "light"); the stored choice is restored on mount.
- The control must be accessible: <button data-testid="theme-toggle" aria-pressed={...}>.

Automated verification contract: file path ${M3_ENTRY}, default export, data-testid="theme-toggle", documentElement class \`dark\`, localStorage key \`theme\`.

Verify it compiles before reporting success, and include short instructions on how to validate the toggle in a preview environment.`
  },
  4: {
    title: 'Bug Resolution via Screenshot (React hydration error)',
    message: `Task — Bug Resolution via Image/Error Log Analysis. Attached screenshot shows a React hydration error:

Error: Text content does not match server-rendered HTML.
Hydration failed because the server rendered text did not match the client.

The visible cause is a dynamic timestamp rendered on the server versus the client in ${M4_ENTRY}.

Inspect the attached screenshot first, then fix ${M4_ENTRY} so hydration produces no mismatch — use a useEffect-driven timestamp, deterministic rendering, or suppressHydrationWarning only if you can justify it. Keep \`export default\` and the data-testid="timestamp" attribute, and the component must still display a timestamp after mount.

Hydration is verified automatically with server-render + client hydration, so run a real check before reporting success.`
  },
  5: {
    title: 'Dynamic Failure Analysis via Video (checkout wizard loop)',
    message: `Task — Dynamic Failure Analysis via Video Recording. Attached screen recording shows a multi-step checkout wizard where clicking "Next" on Step 2 silently fails and loops back to Step 1 whenever the postal code field is empty.

Inspect the attached video frames first, then fix ${M5_ENTRY}:
- On Step 2, Next with an empty/invalid postal code must NOT reset to Step 1. Stay on Step 2 and show a clear inline validation error in the existing [data-testid="error-message"] element (role="alert"), and mark the input aria-invalid.
- A valid postal code advances to Step 3.
- Keep every existing data-testid (wizard, step-indicator, postal-input, next-button, back-button, error-message).

Verify the corrected flow before reporting success.`
  }
};

// Every task runs in a disposable, pre-seeded workspace. The agent must
// modify files in place — scaffolding or wiping the workspace (seen live:
// `npx create-react-app .` after a conflict warning deleted the seed) makes
// the module unmeasurable instead of measuring the intended skill.
const WORKSPACE_RULES = `\n\nWorkspace rules: this workspace is pre-seeded for the task. Edit the existing files in place. Do not delete or overwrite unrelated files, do not reinitialize or re-scaffold the project (no create-react-app, npm init, npm create), and do not run commands that empty the workspace.`;
for (const t of Object.values(TASKS)) t.message += WORKSPACE_RULES;

// --------------------------------------------------------------------------
// Deterministic verifiers — each returns nothing and registers checks on the
// report. `run` receives an optional agent turn result for evidence checks.
// --------------------------------------------------------------------------

function checkLocalModel(report, run, label = 'agent used a local model') {
  const used = run?.final?.modelUsed || '';
  report.check(isLocalModel(used), `${label} (modelUsed=${used || 'n/a'})`);
}

function checkTurnCompleted(report, run, label = 'agent turn completed without error') {
  if (!run) return;
  const detail = run.error
    ? ` — ${String(run.error.error || '').replace(/\s+/g, ' ').slice(0, 160)}`
    : '';
  report.check(!run.error, `${label}${detail}`);
}

function checkDiscoveryBeforeWrite(report, run, label = 'agent discovered before writing') {
  if (!run) return;
  const kinds = run.steps.filter(s => s.status === 'done').map(s => s.kind);
  const firstWrite = kinds.indexOf('write');
  const discoveryKinds = ['list', 'read', 'search', 'attachment'];
  const firstDiscovery = kinds.findIndex(k => discoveryKinds.includes(k));
  const discovered = firstDiscovery >= 0 && (firstWrite < 0 || firstDiscovery < firstWrite);
  report.check(discovered, label);
}

function checkRanVerification(report, run, label = 'agent ran a real verification command') {
  if (!run) return;
  const ranTool = run.steps.some(s => s.kind === 'run' && s.status === 'done');
  report.check(ranTool, label, { soft: true });
}

// ---- Module 1 -------------------------------------------------------------
function verifyM1(report, workspace, run) {
  if (!hasWs(workspace, M1_ENTRY)) {
    report.check(false, `${M1_ENTRY} exists`);
    // Still report turn-level evidence so a destroyed workspace does not
    // silently swallow the local-model / turn-health checks.
    checkLocalModel(report, run);
    checkTurnCompleted(report, run);
    checkDiscoveryBeforeWrite(report, run);
    checkRanVerification(report, run);
    return;
  }
  report.check(true, `${M1_ENTRY} exists`);
  const src = readWs(workspace, M1_ENTRY);
  report.check(!/TODO:/.test(src), 'no TODO comments remain');
  report.check(!/:\s*any\b|any\[\]|<any>/.test(src), 'no `any` types remain (User/Column typed)');

  const tc = typecheck(workspace);
  report.check(tc.ok, `TypeScript strict typecheck passes${tc.ok ? '' : ` — ${tc.output.split('\n')[0]}`}`);
  report.meta('typecheck', tc.ok ? 'pass' : tc.output.slice(0, 400));

  let exportsMod;
  try { exportsMod = loadComponent(workspace, M1_ENTRY); }
  catch (e) { report.check(false, `component loads: ${e.message}`); return; }
  const UserTable = exportsMod.UserTable || exportsMod.default;
  report.check(typeof UserTable === 'function', 'named export UserTable is a component');

  const DATA = [
    { id: 3, name: 'Charlie', email: 'charlie@example.com' },
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: 'bob@example.com' }
  ];

  return (async () => {
    const React = await import('react');
    const dom = await setupDom();
    try {
      await React.act(async () => {
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(dom.container);
        root.render(React.createElement(UserTable, { data: DATA }));
        dom.container._root = root;
      });
      const rows = [...dom.container.querySelectorAll('[data-testid="user-row"]')];
      report.check(rows.length === DATA.length, `rows render from data (${rows.length}/${DATA.length})`);

      const orderOf = () => [...dom.container.querySelectorAll('[data-testid="user-row"]')]
        .map(r => (r.textContent.match(/Charlie|Alice|Bob/) || [''])[0]);
      const header = dom.container.querySelector('[data-testid="sort-name"]');
      report.check(!!header, 'sortable header button data-testid="sort-name" present');
      if (header && rows.length === DATA.length) {
        await click(React, dom.window, header);
        const first = orderOf();
        const sortedAsc = JSON.stringify(first) === JSON.stringify(['Alice', 'Bob', 'Charlie']);
        const sortedDesc = JSON.stringify(first) === JSON.stringify(['Charlie', 'Bob', 'Alice']);
        report.check(sortedAsc || sortedDesc, `first click sorts name column (got ${first.join(',')})`);
        await click(React, dom.window, header);
        const second = orderOf();
        report.check(JSON.stringify(second) === JSON.stringify([...first].reverse()),
          `second click toggles direction (got ${second.join(',')})`);
      }
    } catch (e) {
      report.check(false, `interactive render: ${e.message}`);
    } finally {
      try { dom.container._root?.unmount(); } catch { /* ignore */ }
      dom.cleanup();
    }
    checkLocalModel(report, run);
    checkTurnCompleted(report, run);
    checkDiscoveryBeforeWrite(report, run);
    checkRanVerification(report, run);
  })();
}

// ---- Module 2 -------------------------------------------------------------
async function importFresh(file) {
  const bust = `${pathToFileURLSafe(file)}?v=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return await import(bust);
}
function pathToFileURLSafe(file) {
  return new URL(`file:///${file.replace(/\\/g, '/')}`).href;
}

function verifyM2(report, workspace) {
  const appFile = path.join(workspace, 'app.js');
  const dbFile = path.join(workspace, 'db.js');
  if (!fs.existsSync(appFile)) { report.check(false, 'app.js exists'); return; }
  report.check(true, 'app.js exists');

  const syntax = nodeCheck(appFile);
  report.check(syntax.ok, `app.js passes node --check${syntax.ok ? '' : ` — ${syntax.output.split('\n')[0]}`}`);

  const src = fs.readFileSync(appFile, 'utf8');
  report.check(!/VALUES\s*\(\s*['"]?\$\{/.test(src) && !/INSERT[^;]*\$\{name\}/.test(src),
    'no request data interpolated into SQL');
  report.check(/\?\s*[,)]|\$\d|@p\d|:\w+\s*[,)]/.test(src) && /query\(/.test(src),
    'parameterized query used');
  report.check(/status\(\s*4\d\d|sendStatus\(\s*4\d\d|statusCode\s*=\s*4\d\d/.test(src),
    'input validation returns 4xx');
  report.check(/try\s*\{[\s\S]*catch|\.catch\(/.test(src), 'database errors are caught');
  report.check(/required|invalid|valid email|email format|@/.test(src) && /email/.test(src),
    'email/name validation present');

  // ---- runtime behavior ----
  return (async () => {
    globalThis.__dbCalls = [];
    globalThis.__dbFail = false;
    let server = null;
    let mounted = null;
    try {
      const mod = await importFresh(appFile);
      mounted = mod.default?.default || mod.default || mod.app;
      if (typeof mounted !== 'function' || typeof mounted.listen !== 'function') {
        report.check(false, 'app.js default export is a mountable Express app');
        return;
      }
      server = mounted.listen(0, '127.0.0.1');
      await new Promise(r => server.once('listening', r));
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = (body, headers = {}) => fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body
      });

      // 1. malformed JSON must be handled, not fatal
      const bad = await post('{"name": ').catch(() => null);
      report.check(!!bad && bad.status >= 400 && bad.status < 500,
        `malformed JSON returns 4xx (got ${bad ? bad.status : 'crash'})`);

      // 2. missing fields -> 400
      const missing = await post(JSON.stringify({ name: 'Ada' })).catch(() => null);
      report.check(!!missing && missing.status === 400,
        `missing email returns 400 (got ${missing ? missing.status : 'crash'})`);

      // 3. invalid email format -> 400
      const badEmail = await post(JSON.stringify({ name: 'Ada', email: 'not-an-email' })).catch(() => null);
      report.check(!!badEmail && badEmail.status === 400,
        `invalid email format returns 400 (got ${badEmail ? badEmail.status : 'crash'})`);

      // 4. valid -> 2xx AND parameterized (raw values never in the SQL text)
      globalThis.__dbCalls = [];
      const injection = "Robert'); DROP TABLE users;--";
      const okRes = await post(JSON.stringify({ name: injection, email: 'ada@example.com' })).catch(() => null);
      const calls = globalThis.__dbCalls || [];
      report.check(!!okRes && okRes.status >= 200 && okRes.status < 300,
        `valid input returns 2xx (got ${okRes ? okRes.status : 'crash'})`);
      report.check(calls.length > 0, 'the route executed a database query');
      const last = calls[calls.length - 1];
      if (last) {
        report.check(!String(last.sql).includes(injection) && !String(last.sql).includes("'); DROP"),
          'SQL injection payload stays out of the SQL text');
        report.check(Array.isArray(last.params) && last.params.some(p => String(p).includes(injection)),
          'payload passed as a bound query parameter');
      }

      // 5. db failure -> 5xx JSON, process alive afterwards
      globalThis.__dbFail = true;
      const failRes = await post(JSON.stringify({ name: 'Ada', email: 'ada@example.com' })).catch(() => null);
      globalThis.__dbFail = false;
      let jsonBody = null;
      try { jsonBody = await failRes?.clone?.().json(); } catch { jsonBody = null; }
      report.check(!!failRes && failRes.status >= 500 && failRes.status < 600 && jsonBody,
        `db failure returns 5xx JSON (got ${failRes ? failRes.status : 'crash'})`);
      const alive = await post(JSON.stringify({ name: 'Ada', email: 'ada@example.com' })).catch(() => null);
      report.check(!!alive && alive.status >= 200 && alive.status < 300,
        `process still healthy after db failure (got ${alive ? alive.status : 'crash'})`);
    } catch (e) {
      report.check(false, `route runtime harness: ${e.message}`);
    } finally {
      if (server) { try { server.close(); } catch { /* ignore */ } }
      globalThis.__dbFail = false;
    }
  })();
}

// ---- Module 3 -------------------------------------------------------------
function verifyM3(report, workspace) {
  if (!hasWs(workspace, M3_ENTRY)) { report.check(false, `${M3_ENTRY} exists`); return; }
  report.check(true, `${M3_ENTRY} exists`);

  const files = listFiles(workspace);
  report.check(files.some(f => /useTheme|theme\.(ts|tsx)|useDarkMode/i.test(f)),
    'state logic lives in its own module (UI/state separated)');

  const tc = typecheck(workspace);
  report.check(tc.ok, `TypeScript strict typecheck passes${tc.ok ? '' : ` — ${tc.output.split('\n')[0]}`}`);
  report.meta('typecheck', tc.ok ? 'pass' : tc.output.slice(0, 400));

  let mod;
  try { mod = loadComponent(workspace, M3_ENTRY); }
  catch (e) { report.check(false, `component loads: ${e.message}`); return; }
  const Toggle = mod.default || mod.DarkModeToggle;
  report.check(typeof Toggle === 'function', 'default export DarkModeToggle is a component');

  return (async () => {
    const React = await import('react');
    const dom = await setupDom();
    try {
      dom.window.localStorage.clear();
      dom.document.documentElement.className = '';
      await React.act(async () => {
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(dom.container);
        root.render(React.createElement(Toggle));
        dom.container._root = root;
      });
      const btn = dom.container.querySelector('[data-testid="theme-toggle"]');
      report.check(!!btn, 'toggle control data-testid="theme-toggle" present');
      if (!btn) return;
      report.check(btn.hasAttribute('aria-pressed') || btn.hasAttribute('aria-label') || btn.getAttribute('role') === 'switch',
        'control is accessible (aria-pressed/aria-label/role)');

      const darkOn = () => dom.document.documentElement.classList.contains('dark');
      const stored = () => dom.window.localStorage.getItem('theme');
      report.check(!darkOn(), 'initial state is light');

      await click(React, dom.window, btn);
      report.check(darkOn(), 'click adds `dark` class to documentElement');
      report.check(stored() === 'dark', `choice persisted to localStorage.theme (got ${JSON.stringify(stored())})`);
      report.check(btn.getAttribute('aria-pressed') === 'true', 'aria-pressed reflects toggled state');

      // "reload": unmount and mount a fresh root against the same window
      await React.act(async () => { dom.container._root.unmount(); });
      dom.document.documentElement.className = '';
      await React.act(async () => {
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(dom.container);
        root.render(React.createElement(Toggle));
        dom.container._root = root;
      });
      report.check(darkOn(), 'persisted theme restored after remount (survives reload)');

      const btn2 = dom.container.querySelector('[data-testid="theme-toggle"]');
      if (btn2) {
        await click(React, dom.window, btn2);
        report.check(!darkOn() && stored() === 'light', 'toggling back stores light and removes dark class');
      }
    } catch (e) {
      report.check(false, `interactive render: ${e.message}`);
    } finally {
      try { dom.container._root?.unmount(); } catch { /* ignore */ }
      dom.cleanup();
    }
  })();
}

// ---- Module 4 -------------------------------------------------------------
function verifyM4(report, workspace, run, rows) {
  if (!hasWs(workspace, M4_ENTRY)) {
    report.check(false, `${M4_ENTRY} exists`);
    report.check(visionInspected(rows), 'screenshot inspected by local vision model (local_visual_analysis row)');
    checkLocalModel(report, run);
    checkTurnCompleted(report, run);
    checkDiscoveryBeforeWrite(report, run, 'agent inspected evidence before editing');
    checkRanVerification(report, run);
    return;
  }
  report.check(true, `${M4_ENTRY} exists`);
  report.check(visionInspected(rows), 'screenshot inspected by local vision model (local_visual_analysis row)');

  const tc = typecheck(workspace);
  report.check(tc.ok, `TypeScript strict typecheck passes${tc.ok ? '' : ` — ${tc.output.split('\n')[0]}`}`);
  report.meta('typecheck', tc.ok ? 'pass' : tc.output.slice(0, 400));

  let mod;
  try { mod = loadComponent(workspace, M4_ENTRY); }
  catch (e) { report.check(false, `component loads: ${e.message}`); return; }
  const Comp = mod.default || mod.LiveTimestamp;
  report.check(typeof Comp === 'function', 'default export LiveTimestamp is a component');
  if (typeof Comp !== 'function') return;

  return (async () => {
    const React = await import('react');
    const ReactDOMServer = await import('react-dom/server');
    let result;
    try {
      result = await hydrationCheck(React, ReactDOMServer, () => React.createElement(Comp));
    } catch (e) {
      report.check(false, `SSR/hydration harness: ${e.message}`);
      return;
    }
    report.check(result.errors.length === 0,
      `hydration produces zero mismatches (got ${result.errors.length}: ${String(result.errors[0] || '').slice(0, 90)})`);
    report.check(/\d{1,2}:\d{2}/.test(result.text || ''),
      'component still displays a timestamp after mount');

    const reply = String(run?.final?.reply || '');
    report.check(/hydrat|mismatch|server.rendered|useEffect|suppressHydration/i.test(reply),
      'diagnosis explains the hydration root cause');
    checkLocalModel(report, run);
    checkTurnCompleted(report, run);
    checkDiscoveryBeforeWrite(report, run, 'agent inspected evidence before editing');
    checkRanVerification(report, run);
  })();
}

// ---- Module 5 -------------------------------------------------------------
function verifyM5(report, workspace, run, rows) {
  if (!hasWs(workspace, M5_ENTRY)) {
    report.check(false, `${M5_ENTRY} exists`);
    report.check(visionInspected(rows), 'video frames inspected by local vision model (local_visual_analysis row)');
    checkLocalModel(report, run);
    checkTurnCompleted(report, run);
    checkDiscoveryBeforeWrite(report, run, 'agent inspected video evidence before editing');
    checkRanVerification(report, run);
    return;
  }
  report.check(true, `${M5_ENTRY} exists`);
  report.check(visionInspected(rows), 'video frames inspected by local vision model (local_visual_analysis row)');

  const tc = typecheck(workspace);
  report.check(tc.ok, `TypeScript strict typecheck passes${tc.ok ? '' : ` — ${tc.output.split('\n')[0]}`}`);
  report.meta('typecheck', tc.ok ? 'pass' : tc.output.slice(0, 400));

  let mod;
  try { mod = loadComponent(workspace, M5_ENTRY); }
  catch (e) { report.check(false, `component loads: ${e.message}`); return; }
  const Wizard = mod.default || mod.CheckoutWizard;
  report.check(typeof Wizard === 'function', 'default export CheckoutWizard is a component');
  if (typeof Wizard !== 'function') return;

  const $ = sel => [...domScope.container.querySelectorAll(sel)];
  const text = sel => (domScope.container.querySelector(sel)?.textContent || '').trim();
  let domScope = null;

  return (async () => {
    const React = await import('react');
    domScope = await setupDom();
    try {
      await React.act(async () => {
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(domScope.container);
        root.render(React.createElement(Wizard));
        domScope.container._root = root;
      });
      const stepText = () => text('[data-testid="step-indicator"]');
      const nextBtn = () => domScope.container.querySelector('[data-testid="next-button"]');

      report.check(/Step 1/.test(stepText()), `wizard starts on Step 1 (got "${stepText()}")`);
      await click(React, domScope.window, nextBtn());
      report.check(/Step 2/.test(stepText()), `Next advances to Step 2 (got "${stepText()}")`);

      // Empty postal code: must show an error and stay on Step 2.
      await click(React, domScope.window, nextBtn());
      const afterEmpty = stepText();
      const errText = text('[data-testid="error-message"]');
      const input = domScope.container.querySelector('[data-testid="postal-input"]');
      report.check(!/Step 1/.test(afterEmpty),
        `empty postal code does NOT silently loop back to Step 1 (got "${afterEmpty}")`);
      report.check(/Step 2/.test(afterEmpty),
        `stays on Step 2 when validation fails (got "${afterEmpty}")`);
      report.check(errText.length > 0,
        `inline validation error is displayed (got "${errText.slice(0, 60)}")`);
      if (input) {
        report.check(input.getAttribute('aria-invalid') === 'true',
          'postal input marked aria-invalid');
      } else {
        report.check(false, 'postal input still present after failed validation');
      }

      // Valid postal code advances to Step 3.
      if (input) {
        await typeInto(React, domScope.window, input, 'K1A 0B1');
        await click(React, domScope.window, nextBtn());
        report.check(/Step 3/.test(stepText()),
          `valid postal code advances to Step 3 (got "${stepText()}")`);
      }
      const reply = String(run?.final?.reply || '');
      report.check(/postal|frame|step 2|timestamp/i.test(reply),
        'report cites the observed flow evidence');
      checkLocalModel(report, run);
      checkTurnCompleted(report, run);
      checkDiscoveryBeforeWrite(report, run, 'agent inspected video evidence before editing');
      checkRanVerification(report, run);
    } catch (e) {
      report.check(false, `wizard interaction harness: ${e.message}`);
    } finally {
      try { domScope.container._root?.unmount(); } catch { /* ignore */ }
      domScope.cleanup();
    }
  })();
}

// --------------------------------------------------------------------------
// Seeds + per-module orchestration
// --------------------------------------------------------------------------

function seedWorkspace(id, ws) {
  if (id === 1) {
    writeWs(ws, M1_ENTRY, M1_SEED);
  } else if (id === 2) {
    writeWs(ws, 'app.js', M2_APP);
    writeWs(ws, 'db.js', M2_DB);
  } else if (id === 4) {
    writeWs(ws, M4_ENTRY, M4_SEED);
  } else if (id === 5) {
    writeWs(ws, M5_ENTRY, M5_SEED);
  }
  // Give every workspace the configured system prompt so the agent under test
  // runs with the real production prompt.
  fs.copyFileSync(path.join(ROOT, 'agent-system-prompt.md'), path.join(ws, 'agent-system-prompt.md'));
  return ws;
}

const MEDIA_DIR = path.join(ROOT, '.data', 'eval-media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

async function runModule(id, report) {
  const task = TASKS[id];
  report.beginModule(String(id), task.title);
  const ws = makeWorkspace(`m${id}`);
  report.meta('workspace', path.relative(ROOT, ws));
  seedWorkspace(id, ws);

  // ---- self-test mode: run verifiers against the unfixed seed ----
  if (SELF_TEST) {
    const before = report.failures;
    if (id === 1) await verifyM1(report, ws, null);
    else if (id === 2) await verifyM2(report, ws);
    else if (id === 3) await verifyM3(report, ws);
    else if (id === 4) await verifyM4(report, ws, null, []);
    else if (id === 5) await verifyM5(report, ws, null, []);
    const seedFailures = report.failures - before;
    const detected = seedFailures > 0;
    // Collapse the seed run into one discrimination verdict: the checks are
    // valid precisely because they failed on the unfixed fixture.
    report.resetCurrentChecks();
    report.check(detected,
      `checks detect the unfixed defect (${seedFailures} check(s) failed on the seed fixture as expected)`);
    if (!KEEP) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ } }
    return;
  }

  // ---- fixtures that need media ----
  let message = task.message;
  let mediaLine = '';
  if (id === 4) {
    const png = makeErrorLogPng(path.join(MEDIA_DIR, 'm4-hydration-error.png'));
    if (png) {
      mediaLine = `Screenshot of the error: ${png}`;
      message = `${mediaLine}\n\n${message}`;
    } else report.check(false, 'error-log screenshot fixture generated');
  }
  if (id === 5) {
    const mp4 = makeCheckoutFlowMp4(path.join(MEDIA_DIR, 'm5-checkout-flow.mp4'));
    if (mp4) {
      mediaLine = `Screen recording of the flow: ${mp4}`;
      message = `${mediaLine}\n\n${message}`;
    } else report.check(false, 'checkout-flow video fixture generated');
  }

  // ---- agent turn (with one corrective retry on verification failure) ----
  const sessionId = `eval-m${id}-${Date.now()}`;
  let run = await agentTurn({ sessionId, message, workspace: ws });
  let rows = await historyRows(sessionId);
  report.meta('elapsed', `${Math.round(run.elapsed / 1000)}s`);
  report.meta('agent reply', String(run.final?.reply || run.error?.error || '').replace(/\s+/g, ' ').slice(0, 240));

  const runVerifier = async () => {
    if (id === 1) await verifyM1(report, ws, run);
    else if (id === 2) await verifyM2(report, ws);
    else if (id === 3) await verifyM3(report, ws);
    else if (id === 4) await verifyM4(report, ws, run, rows);
    else if (id === 5) await verifyM5(report, ws, run, rows);
    // Modules 2 and 3 have no vision/diagnosis checks of their own; still
    // require the turn to have used the local model stack and to have
    // discovered the workspace before writing.
    if (id === 2 || id === 3) {
      checkLocalModel(report, run);
      checkTurnCompleted(report, run);
      checkDiscoveryBeforeWrite(report, run);
      checkRanVerification(report, run);
    }
    if (run?.error) {
      report.meta('agent error', String(run.error.error || '').replace(/\s+/g, ' ').slice(0, 240));
    }
    report.meta('modelUsed', String(run?.final?.modelUsed || run?.error?.error || 'n/a'));
  };
  await runVerifier();
  report.current.attempts = 1;

  // ---- corrective retry: feed the exact failing checks back to the agent ----
  const hardFailures = report.current.checks.filter(c => !c.pass && !c.soft);
  if (hardFailures.length) {
    const feedback = [
      'Automated verification of your last change failed. Fix these in the workspace and re-verify:',
      ...hardFailures.map(c => `- ${c.msg}`),
      'Re-read the failing files, correct the code, run a real verification, then reply with what you changed and the verification result.'
    ].join('\n') + (mediaLine ? `\n\n${mediaLine}` : '') + WORKSPACE_RULES;
    // Clear the failed attempt's checks (and its failure tally) so the final
    // verdict reflects the post-retry state of the workspace.
    const beforeMeta = { ...report.current.meta };
    report.resetCurrentChecks();
    const retry = await agentTurn({ sessionId, message: feedback, workspace: ws });
    rows = await historyRows(sessionId);
    run = { ...retry, final: retry.final || run.final };
    report.current.attempts = 2;
    report.meta('retry elapsed', `${Math.round(retry.elapsed / 1000)}s`);
    await runVerifier();
    for (const [k, v] of Object.entries(beforeMeta)) if (!(k in report.current.meta)) report.meta(k, v);
  }

  if (report.current.checks.filter(c => !c.soft).every(c => c.pass) && !KEEP) {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    report.meta('workspace kept', path.relative(ROOT, ws));
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
const report = new Report();
const t0 = Date.now();
try {
  for (const id of [1, 2, 3, 4, 5]) {
    if (only(id)) await runModule(id, report);
  }
} finally {
  listener.close();
}

const summary = report.summary();
const out = path.join(ROOT, SELF_TEST ? 'EVAL_SELFTEST_RESULTS.md' : 'EVALUATION_RESULTS.md');
fs.writeFileSync(out, summary, 'utf8');
console.log('\n' + summary);
console.log(`\nTotal: ${Math.round((Date.now() - t0) / 1000)}s — report written to ${path.relative(ROOT, out)}`);
process.exit(report.failures ? 1 : 0);
