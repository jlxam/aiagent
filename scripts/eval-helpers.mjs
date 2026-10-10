/**
 * Shared helpers for the AI Coding Agent Evaluation Suite harness
 * (scripts/check-eval-suite.mjs).
 *
 * Everything here is deterministic and model-free: typecheck, TSX transpile +
 * load, jsdom interactive rendering, SSR/hydration checks, and ffmpeg fixture
 * generation for the image/video modules.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const TSC_BIN = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const nodeRequire = createRequire(path.join(ROOT, 'package.json'));

// --------------------------------------------------------------------------
// Workspace fixtures
// --------------------------------------------------------------------------

/** Create a disposable workspace under .data/ and return its absolute path. */
export function makeWorkspace(tag) {
  const dir = path.join(ROOT, '.data', `eval-${tag}-${Date.now()}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `eval-${tag}`,
    private: true,
    version: '0.0.0',
    type: 'module'
  }, null, 2));
  return dir;
}

export function writeWs(workspace, relPath, content) {
  const full = path.join(workspace, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

export function readWs(workspace, relPath) {
  return fs.readFileSync(path.join(workspace, relPath), 'utf8');
}

export function hasWs(workspace, relPath) {
  return fs.existsSync(path.join(workspace, relPath));
}

/** Recursive list of files under dir (relative paths), skipping noise dirs. */
export function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.eval-build'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

// --------------------------------------------------------------------------
// Typecheck / syntax verification
// --------------------------------------------------------------------------

/**
 * Run tsc --noEmit over the workspace with strict React settings.
 * Returns { ok, output }.
 */
export function typecheck(workspace) {
  if (!fs.existsSync(TSC_BIN)) {
    return { ok: false, output: 'typescript is not installed (run npm install)' };
  }
  const files = listFiles(workspace)
    .filter(f => /\.(ts|tsx)$/.test(f))
    .map(f => path.join(workspace, f));
  if (!files.length) return { ok: true, output: 'no TS files' };
  const args = [
    TSC_BIN, '--noEmit', '--strict', '--skipLibCheck',
    '--jsx', 'react-jsx',
    '--module', 'esnext', '--moduleResolution', 'bundler',
    '--target', 'es2022', '--lib', 'es2022,dom,dom.iterable',
    '--esModuleInterop', '--allowSyntheticDefaultImports',
    '--types', 'react',
    ...files
  ];
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, output };
}

/** Syntax-check a JS file with node --check. */
export function nodeCheck(file) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 30000 });
  return { ok: res.status === 0, output: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

// --------------------------------------------------------------------------
// TSX transpile + load (CJS side-load so `require('react')` resolves to the
// single root node_modules copy)
// --------------------------------------------------------------------------

/**
 * Transpile every .ts/.tsx/.jsx file in the workspace into workspace/.eval-build
 * as CommonJS and return the absolute path of the entry module's compiled file.
 */
export function buildEntry(workspace, entryRel) {
  const ts = nodeRequire('typescript');
  const outRoot = path.join(workspace, '.eval-build');
  fs.rmSync(outRoot, { recursive: true, force: true });
  const files = listFiles(workspace).filter(f => /\.(tsx?|jsx)$/.test(f));
  const entry = entryRel.replace(/\\/g, '/');
  let entryOut = null;
  for (const rel of files) {
    const relPosix = rel.replace(/\\/g, '/');
    const src = fs.readFileSync(path.join(workspace, rel), 'utf8');
    const result = ts.transpileModule(src, {
      fileName: rel,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        resolveJsonModule: true
      }
    });
    const outRel = relPosix.replace(/\.(tsx|jsx|ts)$/, '.js');
    const outFile = path.join(outRoot, ...outRel.split('/'));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, result.outputText, 'utf8');
    if (relPosix === entry) entryOut = outFile;
  }
  if (!entryOut) throw new Error(`entry ${entryRel} not found in workspace`);
  // The workspace is ESM ("type": "module"); mark the compiled output as
  // CommonJS so require() can load the transpiled CJS.
  fs.writeFileSync(path.join(outRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8');
  return entryOut;
}

/**
 * Load a workspace TS entry (default + named exports) for testing.
 * The build directory is recreated per call, so require-cache entries are
 * evicted for every compiled file before loading — a second attempt always
 * sees the agent's updated code.
 */
export function loadComponent(workspace, entryRel) {
  const entryFile = buildEntry(workspace, entryRel);
  const outRoot = path.join(workspace, '.eval-build');
  const req = createRequire(pathToFileURL(entryFile).href);
  for (const key of Object.keys(req.cache)) {
    if (key.startsWith(outRoot)) delete req.cache[key];
  }
  return req(entryFile);
}

// --------------------------------------------------------------------------
// jsdom interactive rendering
// --------------------------------------------------------------------------

let domSeq = 0;

/**
 * Create a fresh jsdom document + root container and install browser globals.
 * Returns { window, document, container, cleanup }.
 */
export async function setupDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
  });
  const define = (key, value) => {
    try { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
    catch { try { globalThis[key] = value; } catch { /* leave as-is */ } }
  };
  define('window', dom.window);
  define('document', dom.window.document);
  define('navigator', dom.window.navigator);
  define('localStorage', dom.window.localStorage);
  define('sessionStorage', dom.window.sessionStorage);
  define('HTMLElement', dom.window.HTMLElement);
  define('HTMLInputElement', dom.window.HTMLInputElement);
  define('Element', dom.window.Element);
  define('Node', dom.window.Node);
  define('Event', dom.window.Event);
  define('MouseEvent', dom.window.MouseEvent);
  define('KeyboardEvent', dom.window.KeyboardEvent);
  define('CustomEvent', dom.window.CustomEvent);
  define('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  define('requestAnimationFrame', cb => setTimeout(() => cb(Date.now()), 16));
  define('cancelAnimationFrame', id => clearTimeout(id));
  define('IS_REACT_ACT_ENVIRONMENT', true);

  const container = dom.window.document.createElement('div');
  container.id = `eval-root-${++domSeq}`;
  dom.window.document.body.appendChild(container);

  return {
    window: dom.window,
    document: dom.window.document,
    container,
    cleanup() {
      try { container.remove(); } catch { /* ignore */ }
    }
  };
}

/** Dispatch a click on an element inside act(). */
export async function click(React, window, el) {
  const { act } = React;
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Type into an input (native setter + input event) inside act(). */
export async function typeInto(React, window, input, value) {
  const { act } = React;
  const proto = window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    setter ? setter.call(input, value) : (input.value = value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

// --------------------------------------------------------------------------
// SSR + hydration check with a pinned clock
// --------------------------------------------------------------------------

/**
 * Server-render `element`, advance a mocked clock by `skewMs`, hydrate, and
 * collect recoverable (hydration) errors. Returns { errors, html, text }.
 * A component with a dynamic timestamp and no hydration guard must produce
 * errors; a useEffect/suppressHydrationWarning fix must produce none.
 */
export async function hydrationCheck(React, ReactDOMServer, elementFactory, { skewMs = 300000 } = {}) {
  const { renderToString } = ReactDOMServer;
  const RealDate = globalThis.Date;
  const base = RealDate.now();
  let pinned = base;
  class MockDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(pinned); else super(...args); }
    static now() { return pinned; }
  }
  globalThis.Date = MockDate;
  try {
    const serverHtml = renderToString(elementFactory());
    pinned = base + skewMs;
    const dom = await setupDom();
    const { hydrateRoot } = await import('react-dom/client');
    const errors = [];
    dom.container.innerHTML = serverHtml;
    await React.act(async () => {
      hydrateRoot(dom.container, elementFactory(), {
        onRecoverableError: err => errors.push(String(err?.message || err))
      });
    });
    await React.act(async () => { /* flush effects */ });
    const text = dom.container.textContent;
    dom.cleanup();
    return { errors, html: serverHtml, text };
  } finally {
    globalThis.Date = RealDate;
  }
}

// --------------------------------------------------------------------------
// Fixture generation (ffmpeg)
// --------------------------------------------------------------------------

const ARIAL = "fontfile='C\\:/Windows/Fonts/arial.ttf':";

// ffmpeg's -vf parser treats backslashes as escapes and unescaped ':' as an
// option separator, so Windows paths must be forward-slashed and colons
// escaped (same convention as the fontfile path above).
const ffPath = p => String(p).replace(/\\/g, '/').replace(/:/g, '\\:');

function ffmpeg(args) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args],
    { encoding: 'utf8', timeout: 120000 });
  if (res.status !== 0) {
    const err = String(res.stderr || res.error?.message || '').trim();
    console.error(`  ffmpeg failed (exit ${res.status}): ${err.split('\n').slice(0, 4).join(' | ')}`);
  }
  return res.status === 0;
}

function drawtextFilter(lines) {
  return lines.map(l => {
    const file = path.join(os.tmpdir(), `eval-dt-${l.hash}.txt`);
    fs.writeFileSync(file, l.text, 'utf8');
    const font = fs.existsSync('C:/Windows/Fonts/arial.ttf') ? ARIAL : '';
    return `drawtext=${font}textfile='${ffPath(file)}':fontcolor=${l.color || 'white'}:fontsize=${l.size || 30}:x=${l.x || 30}:y=${l.y || 40}`;
  }).join(',');
}

/** Render an error-log screenshot for Module 4. Returns null on failure. */
export function makeErrorLogPng(outFile) {
  const lines = [
    { hash: 'm4a', text: 'Error: Text content does not match server-rendered HTML.', color: 'white', y: 60 },
    { hash: 'm4b', text: 'Hydration failed because the server rendered text did not match the client.', color: '0xff6666', y: 150 },
    { hash: 'm4c', text: 'at LiveTimestamp (src/components/LiveTimestamp.tsx:4:12)', color: '0xaaaaaa', size: 26, y: 240 },
    { hash: 'm4d', text: 'The dynamic timestamp rendered on the server differs from the client.', color: '0xffcc66', size: 26, y: 320 }
  ];
  const ok = ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=black:s=1280x440',
    '-vf', drawtextFilter(lines),
    '-frames:v', '1', '-y', outFile
  ]);
  return ok && fs.existsSync(outFile) ? outFile : null;
}

/**
 * Render a short checkout-wizard flow video for Module 5 (4 scenes, 3s each).
 * Returns null on failure.
 */
export function makeCheckoutFlowMp4(outFile) {
  const scenes = [
    { t: 0, hash: 'm5a', lines: ['Checkout wizard - Step 2: Shipping', 'Postal code field: (empty)', 'User clicks Next'] },
    { t: 3, hash: 'm5b', lines: ['Click Next with empty postal code', 'No validation error is displayed', 'The click appears to do nothing'] },
    { t: 6, hash: 'm5c', lines: ['Screen silently jumps back to Step 1', 'Wizard loop defect - progress lost', 'Expected: stay on Step 2 with an error'] },
    { t: 9, hash: 'm5d', lines: ['Expected: inline validation error', 'Actual: silent reset to Step 1', 'Reproduced at 00:03 and 00:08'] }
  ];
  const font = fs.existsSync('C:/Windows/Fonts/arial.ttf') ? ARIAL : '';
  const filters = [];
  for (const s of scenes) {
    s.lines.forEach((line, i) => {
      const file = path.join(os.tmpdir(), `eval-dt-${s.hash}-${i}.txt`);
      fs.writeFileSync(file, line, 'utf8');
      const y = 140 + i * 70;
      filters.push(`drawtext=${font}textfile='${ffPath(file)}':fontcolor=white:fontsize=34:x=40:y=${y}:enable='between(t,${s.t},${s.t + 3})'`);
    });
  }
  const ok = ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=black:s=1024x576:d=12',
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', outFile
  ]);
  return ok && fs.existsSync(outFile) ? outFile : null;
}

// --------------------------------------------------------------------------
// Reporting
// --------------------------------------------------------------------------

export class Report {
  constructor() {
    this.modules = [];
    this.failures = 0;
    this.softFailures = 0;
  }

  beginModule(id, title) {
    this.current = { id, title, checks: [], attempts: 0, meta: {} };
    this.modules.push(this.current);
    console.log(`\n=== Module ${id} — ${title} ===`);
  }

  check(cond, msg, { soft = false } = {}) {
    const entry = { msg, pass: !!cond, soft };
    this.current.checks.push(entry);
    if (!cond) {
      if (soft) this.softFailures += 1;
      else this.failures += 1;
      console.log(`  ${soft ? 'WARN' : 'FAIL'} ${msg}`);
    } else {
      console.log(`  ok   ${msg}`);
    }
    return !!cond;
  }

  meta(key, value) { this.current.meta[key] = value; }

  summary() {
    const lines = [];
    lines.push('# Evaluation Suite Results');
    lines.push('');
    lines.push(`Run: ${new Date().toISOString()}`);
    lines.push('');
    for (const m of this.modules) {
      const hard = m.checks.filter(c => !c.soft);
      const passed = hard.every(c => c.pass);
      lines.push(`## Module ${m.id} — ${m.title}: ${passed ? 'PASS' : 'FAIL'}${m.attempts > 1 ? ` (${m.attempts} attempts)` : ''}`);
      for (const [k, v] of Object.entries(m.meta)) lines.push(`- ${k}: ${v}`);
      for (const c of m.checks) lines.push(`- [${c.pass ? 'x' : ' '}] ${c.msg}${c.soft ? ' (soft)' : ''}`);
      lines.push('');
    }
    lines.push('## Evaluation checklist');
    lines.push(`- [${this.allHardPass() ? 'x' : ' '}] All code compiled/ran with zero syntax/runtime errors`);
    lines.push(`- [${this.sectionPass(['1']) ? 'x' : ' '}] Missing types, logic gaps, and UI elements filled (Module 1)`);
    lines.push(`- [${this.sectionPass(['2']) ? 'x' : ' '}] Bugs diagnosed and securely refactored (Module 2)`);
    lines.push(`- [${this.sectionPass(['3']) ? 'x' : ' '}] New modular code built and verified (Module 3)`);
    lines.push(`- [${this.sectionPass(['4', '5']) ? 'x' : ' '}] Visual/dynamic defects handled from logs and flow traces (Modules 4–5)`);
    lines.push(`- [${this.allHardPass() ? 'x' : ' '}] No cloud model used; local qwen3 stack only`);
    lines.push('');
    lines.push(this.failures ? `**${this.failures} failing check(s).**` : '**All checks passed.**');
    if (this.softFailures) lines.push(`(${this.softFailures} soft warning(s).)`);
    return lines.join('\n');
  }

  /** Map checklist sections to the module ids that answer them. */
  sectionPass(ids) {
    const mods = this.modules.filter(m => ids.includes(m.id));
    if (!mods.length) return false;
    return mods.every(m => m.checks.filter(c => !c.soft).every(c => c.pass));
  }

  /** Remove the currently registered failures from the totals. */
  resetCurrentChecks() {
    const removed = this.current.checks.filter(c => !c.pass && !c.soft).length;
    const removedSoft = this.current.checks.filter(c => !c.pass && c.soft).length;
    this.failures -= removed;
    this.softFailures -= removedSoft;
    if (this.failures < 0) this.failures = 0;
    if (this.softFailures < 0) this.softFailures = 0;
    this.current.checks = [];
  }

  allHardPass() {
    return this.modules.every(m => m.checks.filter(c => !c.soft).every(c => c.pass));
  }
}
