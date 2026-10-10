// Regression check: read-only fast paths must not swallow implementation work.
// Run: node .data/check-fastpaths.mjs   (exit 1 on any failure)
import { isDirectFileRequest, directFileTemplateFor, shouldDirectInspect, shouldDirectQuestion } from '../server/agentService.js';
import fs from 'fs';
import path from 'path';
import url from 'url';

// shouldDirectInspect / shouldDirectQuestion are module-private; read them off
// the source so this check stays honest without widening the public surface.

let fail = 0;
const t = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  want=${String(want).padEnd(5)} got=${String(got).padEnd(5)}  ${label}`);
};

console.log('--- shouldDirectInspect: implementation requests must NOT be stolen ---');
// The user's actual case: names structure AND an edit.
t('inspect the project structure and add a contact form', shouldDirectInspect('inspect the project structure and add a contact form'), false);
t('analyze the project structure, then create a landing page', shouldDirectInspect('analyze the project structure, then create a landing page'), false);
t('what files are in the project and fix the broken header', shouldDirectInspect('what files are in the project and fix the broken header'), false);
t('inspect the project structure and implement auth', shouldDirectInspect('inspect the project structure and implement auth'), false);
t('project structure — update the readme', shouldDirectInspect('project structure — update the readme'), false);
t('inspect the react project and write a new component', shouldDirectInspect('inspect the react project and write a new component'), false);

console.log('\n--- shouldDirectInspect: genuine read-only questions must still be fast ---');
t('inspect the project structure', shouldDirectInspect('inspect the project structure'), true);
t('what files are in this project', shouldDirectInspect('what files are in this project'), true);
t('analyze the project structure', shouldDirectInspect('analyze the project structure'), true);
t('project overview of the react codebase', shouldDirectInspect('project overview of the react codebase'), true);

console.log('\n--- shouldDirectQuestion: same guarantee ---');
t('what framework does this project use', shouldDirectQuestion('what framework does this project use'), true);
t('what database does this project use', shouldDirectQuestion('what database does this project use'), true);
t('what framework does this project use, then update the config', shouldDirectQuestion('what framework does this project use, then update the config'), false);
t("what's the project name and fix the build", shouldDirectQuestion("what's the project name and fix the build"), false);
t('what database does this project use', shouldDirectQuestion('what database does this project use'), true);

console.log('\n--- direct-write fast path still works (unchanged behaviour) ---');
t('create a landing page', isDirectFileRequest('create a landing page'), true);
t('generate a readme', isDirectFileRequest('generate a readme'), true);
t('inspect the project structure and create a landing page', isDirectFileRequest('inspect the project structure and create a landing page'), false);
t('create a landing page, then inspect the structure', isDirectFileRequest('create a landing page, then inspect the structure'), true);
t('make an about page', isDirectFileRequest('make an about page'), true);
t('fix the login bug', isDirectFileRequest('fix the login bug'), false);
t('static_page for landing page', directFileTemplateFor('create a landing page'), 'static_page');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL PASS');
if (fail) process.exitCode = 1;
