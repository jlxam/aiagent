import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';

/**
 * STEP 1: Define the patchFile tool function
 */
export async function patchFile({ path, search, replace }) {
  try {
    const content = await fs.readFile(path, 'utf8');
    if (!content.includes(search)) {
      return `Error: Search block not found in ${path}. Please ensure exact matching.`;
    }
    const updated = content.replace(search, replace);
    await fs.writeFile(path, updated, 'utf8');
    
    // Automatically run typecheck for immediate feedback
    try {
      execSync('npx tsc --noEmit', { stdio: 'pipe' });
      return `Successfully patched ${path} and TypeScript check PASSED.`;
    } catch (tcError) {
      return `Successfully patched ${path}, but TypeScript check FAILED:\n${tcError.stderr?.toString() || tcError.message}`;
    }
  } catch (err) {
    return `Failed to patch file: ${err.message}`;
  }
}

/**
 * STEP 2: Register patch_file in your tool execution handler / registry
 */
export const agentTools = {
  patch_file: patchFile,
  // (Your other tools like read_file, write_file, run_command go here if applicable)
};

/**
 * Your messages array with the updated system prompt rules
 */
const messages = [
  {
    role: 'system',
    content: `You are LocalAgent, an expert local AI software development assistant working inside workspace: ${resolvedWorkspace}.
You have access to tools to inspect files, patch code precisely, run tests, and execute terminal commands.

CRITICAL FILE UPDATE RULES:
1. NEVER rewrite an entire file when modifying code. Always use precise patching / search-and-replace mechanisms to target specific functions or components.
2. Always inspect files before editing.
3. If a type check or compilation error occurs after an update, immediately read the error output, formulate a corrective patch, and apply it in the next step.
4. Write clean, production-ready code and handle tool outputs carefully.`
  },
  {
    role: 'user',
    content: prompt
  }
];