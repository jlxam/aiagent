#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  ROOT, makeWorkspace, writeWs, readWs, hasWs,
  typecheck, makeErrorLogPng, makeCheckoutFlowMp4, Report
} from './eval-helpers.mjs';

const argv = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const MODULES = (argValue('--modules', '1,2,3,4,5,6,7,8,9').split(',').map(s => s.trim()).filter(Boolean));
const KEEP = argv.includes('--keep');
process.env.AGENT_MAX_TOOL_STEPS = process.env.AGENT_MAX_TOOL_STEPS || '25';
process.env.AGENT_TOTAL_TIMEOUT_MS = process.env.AGENT_TOTAL_TIMEOUT_MS || '1800000';
const only = id => MODULES.includes(String(id));

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1200000);
  try {
    const res = await fetch(`${BASE}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message, model: 'auto', workspacePath: workspace, attachments }),
      signal: controller.signal
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
  } catch (err) {
    return { steps: [], final: null, error: { error: err.message }, elapsed: Date.now() - started };
  } finally {
    clearTimeout(timeoutId);
  }
}

const isLocalModel = name => {
  const s = String(name || '').toLowerCase();
  return (s.includes('qwen') || s.includes('llama')) && !/gemini|gpt|claude|openai/.test(s);
};

function checkLocalModel(report, run, label = 'agent used a local model') {
  const used = run?.final?.modelUsed || '';
  report.check(isLocalModel(used), `${label} (modelUsed=${used || 'n/a'})`);
}

function checkTurnCompleted(report, run, label = 'agent turn completed without error') {
  if (!run) return;
  const detail = run.error ? ` — ${String(run.error.error || '').replace(/\s+/g, ' ').slice(0, 160)}` : '';
  report.check(!run.error, `${label}${detail}`);
}

// Module definitions & verifiers
const M4_ENTRY = 'src/components/LiveTimestamp.tsx';
const M4_SEED = `import React from 'react';

// Client component: hydrated by React after server rendering
export default function LiveTimestamp() {
  return (
    <p className="timestamp" data-testid="timestamp">
      Last updated: {new Date().toString()}
    </p>
  );
}
`;

function verifyM4(report, workspace, run) {
  if (!hasWs(workspace, M4_ENTRY)) {
    report.check(false, `${M4_ENTRY} exists`);
    return;
  }
  report.check(true, `${M4_ENTRY} exists`);
  const tc = typecheck(workspace);
  report.check(tc.ok, `TypeScript strict typecheck passes${tc.ok ? '' : ` — ${tc.output.split('\n')[0]}`}`);
}

const M5_ENTRY = 'src/CheckoutWizard.tsx';
const M5_SEED = `import React, { useState } from 'react';

const STEPS = ['Cart', 'Shipping', 'Payment'];

export default function CheckoutWizard() {
  const [step, setStep] = useState(1);
  const [postalCode, setPostalCode] = useState('');

  const next = () => {
    if (step === 2 && !postalCode.trim()) {
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

function verifyM5(report, workspace, run) {
  if (!hasWs(workspace, M5_ENTRY)) {
    report.check(false, `${M5_ENTRY} exists`);
    return;
  }
  report.check(true, `${M5_ENTRY} exists`);
  const tc = typecheck(workspace);
  report.check(tc.ok, `TypeScript strict typecheck passes${tc.ok ? '' : ` — ${tc.output.split('\n')[0]}`}`);
}

// Module 6: Auth & OTP Integration
const M6_ENTRY = 'src/routes/auth.ts';
const M6_SEED = `import { Router } from 'express';\\nexport const authRouter = Router();\\n`;

function verifyM6(report, workspace, run) {
  if (!hasWs(workspace, M6_ENTRY)) {
    report.check(false, `${M6_ENTRY} exists`);
    return;
  }
  report.check(true, `${M6_ENTRY} exists`);
  const src = readWs(workspace, M6_ENTRY);
  report.check(/jwt|jsonwebtoken/i.test(src), 'implements JWT token handling');
  report.check(!/TODO:/.test(src), 'no TODO comments remain');
}

// Module 7: MySQL Schema & Migration
const M7_ENTRY = 'migrations/001_create_orders.sql';
const M7_SEED = `-- TODO: Write SQL migration creating orders table with foreign key to users
`;

function verifyM7(report, workspace, run) {
  if (!hasWs(workspace, M7_ENTRY)) {
    report.check(false, `${M7_ENTRY} exists`);
    return;
  }
  report.check(true, `${M7_ENTRY} exists`);
  const sql = readWs(workspace, M7_ENTRY);
  report.check(/CREATE TABLE.*orders/i.test(sql), 'creates orders table');
  report.check(/FOREIGN KEY/i.test(sql), 'includes relational foreign key constraint');
}

// Module 8: Automated Playwright/Vitest Test
const M8_ENTRY = 'tests/checkout.spec.ts';
const M8_SEED = `import { test, expect } from '@playwright/test';
// TODO: Implement Playwright end-to-end test for checkout flow
`;

function verifyM8(report, workspace, run) {
  if (!hasWs(workspace, M8_ENTRY)) {
    report.check(false, `${M8_ENTRY} exists`);
    return;
  }
  report.check(true, `${M8_ENTRY} exists`);
  const src = readWs(workspace, M8_ENTRY);
  report.check(/test\(/.test(src), 'defines Playwright test blocks');
  report.check(!/TODO:/.test(src), 'no TODO comments remain');
}

// Module 9: Docker & Deployment Setup
const M9_ENTRY = 'Dockerfile';
const M9_SEED = `# TODO: Write multi-stage Dockerfile for Node.js app
`;

function verifyM9(report, workspace, run) {
  if (!hasWs(workspace, M9_ENTRY)) {
    report.check(false, `${M9_ENTRY} exists`);
    return;
  }
  report.check(true, `${M9_ENTRY} exists`);
  const dockerfile = readWs(workspace, M9_ENTRY);
  report.check(/FROM node/i.test(dockerfile), 'uses Node.js base image');
  report.check(/WORKDIR/i.test(dockerfile), 'sets working directory');
}

const TASKS = {
  4: {
    title: 'Bug Resolution via Screenshot (React hydration error)',
    message: `Task — Bug Resolution via Image/Error Log Analysis. Fix the React hydration error in ${M4_ENTRY} caused by rendering dynamic server/client timestamp mismatches.\n\nWorkspace rules: edit existing files in place.`
  },
  5: {
    title: 'Dynamic Failure Analysis via Video (checkout wizard loop)',
    message: `Task — Dynamic Failure Analysis via Video Recording. Fix the multi-step checkout wizard loop issue in ${M5_ENTRY} where missing postal code incorrectly loops back to Step 1 without validation feedback.\n\nWorkspace rules: edit existing files in place.`
  },
  6: {
    title: 'End-to-End Integration (JWT & OTP Auth)',
    message: `Task — Auth Integration. Implement secure JWT generation and mobile OTP validation in ${M6_ENTRY}.\nRequirements: Use express and jsonwebtoken, validate codes securely, and remove all TODOs.`
  },
  7: {
    title: 'Database Schema & Migration (MySQL)',
    message: `Task — MySQL Migration. Write a robust SQL migration script in ${M7_ENTRY} that creates an orders table with proper foreign key constraints linked to users.`
  },
  8: {
    title: 'Automated Testing (Playwright E2E)',
    message: `Task — Automated Testing. Write a Playwright E2E test file in ${M8_ENTRY} verifying the checkout wizard or form submission flow.`
  },
  9: {
    title: 'Deployment Configuration (Docker & Environment)',
    message: `Task — Deployment Setup. Create a production-ready multi-stage Dockerfile at ${M9_ENTRY} for a Node.js application.`
  }
};

const report = new Report();

if (only(4)) {
  report.beginModule('4', TASKS[4].title);
  const workspace = makeWorkspace('m4');
  writeWs(workspace, M4_ENTRY, M4_SEED);

  let attachments = [];
  try {
    const png = makeErrorLogPng();
    if (png) attachments.push({ name: 'hydration-error.png', path: png, mimeType: 'image/png' });
  } catch (e) {}

  const sessionId = `eval-m4-${Date.now()}`;
  const run = await agentTurn({ sessionId, message: TASKS[4].message, workspace, attachments });

  report.meta('elapsedMs', run.elapsed);
  checkLocalModel(report, run);
  checkTurnCompleted(report, run);
  verifyM4(report, workspace, run);

  if (!KEEP) fs.rmSync(workspace, { recursive: true, force: true });
}

if (only(5)) {
  report.beginModule('5', TASKS[5].title);
  const workspace = makeWorkspace('m5');
  writeWs(workspace, M5_ENTRY, M5_SEED);

  let attachments = [];
  try {
    const mp4 = makeCheckoutFlowMp4();
    if (mp4) attachments.push({ name: 'checkout-loop.mp4', path: mp4, mimeType: 'video/mp4' });
  } catch (e) {}

  const sessionId = `eval-m5-${Date.now()}`;
  const run = await agentTurn({ sessionId, message: TASKS[5].message, workspace, attachments });

  report.meta('elapsedMs', run.elapsed);
  checkLocalModel(report, run);
  checkTurnCompleted(report, run);
  verifyM5(report, workspace, run);

  if (!KEEP) fs.rmSync(workspace, { recursive: true, force: true });
}

if (only(6)) {
  report.beginModule('6', TASKS[6].title);
  const workspace = makeWorkspace('m6');
  writeWs(workspace, M6_ENTRY, M6_SEED);
  const sessionId = `eval-m6-${Date.now()}`;
  const run = await agentTurn({ sessionId, message: TASKS[6].message, workspace });
  report.meta('elapsedMs', run.elapsed);
  checkLocalModel(report, run);
  checkTurnCompleted(report, run);
  verifyM6(report, workspace, run);
  if (!KEEP) fs.rmSync(workspace, { recursive: true, force: true });
}

if (only(7)) {
  report.beginModule('7', TASKS[7].title);
  const workspace = makeWorkspace('m7');
  writeWs(workspace, M7_ENTRY, M7_SEED);
  const sessionId = `eval-m7-${Date.now()}`;
  const run = await agentTurn({ sessionId, message: TASKS[7].message, workspace });
  report.meta('elapsedMs', run.elapsed);
  checkLocalModel(report, run);
  checkTurnCompleted(report, run);
  verifyM7(report, workspace, run);
  if (!KEEP) fs.rmSync(workspace, { recursive: true, force: true });
}

if (only(8)) {
  report.beginModule('8', TASKS[8].title);
  const workspace = makeWorkspace('m8');
  writeWs(workspace, M8_ENTRY, M8_SEED);
  const sessionId = `eval-m8-${Date.now()}`;
  const run = await agentTurn({ sessionId, message: TASKS[8].message, workspace });
  report.meta('elapsedMs', run.elapsed);
  checkLocalModel(report, run);
  checkTurnCompleted(report, run);
  verifyM8(report, workspace, run);
  if (!KEEP) fs.rmSync(workspace, { recursive: true, force: true });
}

if (only(9)) {
  report.beginModule('9', TASKS[9].title);
  const workspace = makeWorkspace('m9');
  writeWs(workspace, M9_ENTRY, M9_SEED);
  const sessionId = `eval-m9-${Date.now()}`;
  const run = await agentTurn({ sessionId, message: TASKS[9].message, workspace });
  report.meta('elapsedMs', run.elapsed);
  checkLocalModel(report, run);
  checkTurnCompleted(report, run);
  verifyM9(report, workspace, run);
  if (!KEEP) fs.rmSync(workspace, { recursive: true, force: true });
}

console.log('\n' + report.summary());
process.exit(report.failures > 0 ? 1 : 0);

