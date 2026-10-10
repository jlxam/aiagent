#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const required = [
  'MOBILE_DEVELOPMENT.md',
  'agent-system-prompt.md',
  'roo-agent.config.json',
  'src/components/AgentStudio.tsx'
];
const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
const config = JSON.parse(fs.readFileSync(path.join(root, 'roo-agent.config.json'), 'utf8'));
const prompt = fs.readFileSync(path.join(root, 'agent-system-prompt.md'), 'utf8');
const checks = [
  ['mobileDevelopment=true', config.mobileDevelopment === true],
  ['React Native + Expo stack configured', config.mobileStack === 'react-native-expo-typescript'],
  ['Android target configured', Array.isArray(config.mobileTargets) && config.mobileTargets.includes('android')],
  ['iOS target configured', Array.isArray(config.mobileTargets) && config.mobileTargets.includes('ios')],
  ['mobile system prompt present', /Mobile application development mode/i.test(prompt)],
  ['AgentStudio Mobile mode present', /activeTab === 'mobile'/i.test(fs.readFileSync(path.join(root, 'src/components/AgentStudio.tsx'), 'utf8'))]
];

console.log('MOBILE CONFIG CHECK');
if (missing.length) console.log(`Missing files: ${missing.join(', ')}`);
for (const [label, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${label}`);
const ok = missing.length === 0 && checks.every(([, passed]) => passed);
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
