import fs from 'fs';
import path from 'path';

const root = process.cwd();
const required = [
  'agent-system-prompt.md',
  'AI_CODING_AGENT_EVALUATION_SUITE.md',
  'roo-agent.config.json',
  '.env.example',
  'server/agentService.js',
  'src/components/AgentStudio.tsx'
];
const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`CONFIG CHECK FAILED\nMissing: ${missing.join(', ')}`);
  process.exit(1);
}
const roo = JSON.parse(fs.readFileSync(path.join(root, 'roo-agent.config.json'), 'utf8'));
const prompt = fs.readFileSync(path.join(root, 'agent-system-prompt.md'), 'utf8');
const requiredPromptTerms = ['DISCOVER', 'PLAN', 'IMPLEMENT', 'VERIFY', 'PREVIEW', 'qwen3:8b', 'qwen3-vl:8b'];
const missingTerms = requiredPromptTerms.filter(term => !prompt.includes(term));
if (missingTerms.length) {
  console.error(`CONFIG CHECK FAILED\nSystem prompt is missing: ${missingTerms.join(', ')}`);
  process.exit(1);
}
if (roo.textModel !== 'qwen3:8b' || roo.visionModel !== 'qwen3-vl:8b' || roo.cloudFallback !== false) {
  console.error('CONFIG CHECK FAILED\nUnexpected local model/cloud fallback configuration.');
  process.exit(1);
}
console.log('CONFIG CHECK: PASS');
console.log(`text model: ${roo.textModel}`);
console.log(`vision model: ${roo.visionModel}`);
console.log(`system prompt: ${roo.systemPromptFile}`);
console.log(`evaluation suite: ${roo.evaluationSuiteFile}`);
