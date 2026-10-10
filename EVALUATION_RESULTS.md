# Evaluation Suite Results

Run: 2026-10-08T01:45:52.890Z

## Module 1 — Incomplete Code Completion (UserTable): FAIL (2 attempts)
- workspace: .data\eval-m1-1791398174915
- elapsed: 1800s
- agent reply: Ollama model call timed out after 147 seconds.
- typecheck: .data/eval-m1-1791398174915/src/UserTable.tsx(15,39): error TS2686: 'React' refers to a UMD global, but the current file is a module. Consider adding an import instead.
.data/eval-m1-1791398174915/src/UserTable.tsx(29,22): error TS2686: 'React' refers to a UMD global, but the current file is a module. Consider adding an import instead.
- agent error: timed out waiting for llama-server to start - 
- modelUsed: timed out waiting for llama-server to start - 
- retry elapsed: 15458s
- workspace kept: .data\eval-m1-1791398174915
- [x] src/UserTable.tsx exists
- [x] no TODO comments remain
- [x] no `any` types remain (User/Column typed)
- [ ] TypeScript strict typecheck passes — .data/eval-m1-1791398174915/src/UserTable.tsx(15,39): error TS2686: 'React' refers to a UMD global, but the current file is a module. Consider adding an import instead.
- [x] named export UserTable is a component
- [ ] interactive render: React is not defined
- [ ] agent used a local model (modelUsed=n/a)
- [ ] agent turn completed without error — timed out waiting for llama-server to start - 
- [ ] agent discovered before writing
- [ ] agent ran a real verification command (soft)

## Module 3 — New Code Architecture (Dark Mode Toggle with persistence): FAIL (2 attempts)
- workspace: .data\eval-m3-1791415467251
- elapsed: 891s
- agent reply: Ollama model call timed out after 300 seconds.
- agent error: Ollama model call timed out after 300 seconds.
- modelUsed: Ollama model call timed out after 300 seconds.
- retry elapsed: 683s
- workspace kept: .data\eval-m3-1791415467251
- [ ] src/DarkModeToggle.tsx exists
- [ ] agent used a local model (modelUsed=n/a)
- [ ] agent turn completed without error — Ollama model call timed out after 300 seconds.
- [x] agent discovered before writing
- [ ] agent ran a real verification command (soft)

## Module 4 — Bug Resolution via Screenshot (React hydration error): FAIL (2 attempts)
- workspace: .data\eval-m4-1791417042123
- elapsed: 600s
- agent reply: Local image/video analysis failed. Tried qwen3-vl:8b, llama3.2-vision:latest. Ollama model call timed out after 248 seconds.
- typecheck: pass
- agent error: Local image/video analysis failed. Tried qwen3-vl:8b, llama3.2-vision:latest. Ollama model call timed out after 270 seconds.
- modelUsed: Local image/video analysis failed. Tried qwen3-vl:8b, llama3.2-vision:latest. Ollama model call timed out after 270 seconds.
- retry elapsed: 3743s
- workspace kept: .data\eval-m4-1791417042123
- [x] src/components/LiveTimestamp.tsx exists
- [ ] screenshot inspected by local vision model (local_visual_analysis row)
- [x] TypeScript strict typecheck passes
- [x] default export LiveTimestamp is a component
- [ ] hydration produces zero mismatches (got 1: Hydration failed because the server rendered text didn't match the client. As a result thi)
- [x] component still displays a timestamp after mount
- [ ] diagnosis explains the hydration root cause
- [ ] agent used a local model (modelUsed=n/a)
- [ ] agent turn completed without error — Local image/video analysis failed. Tried qwen3-vl:8b, llama3.2-vision:latest. Ollama model call timed out after 270 seconds.
- [x] agent inspected evidence before editing
- [ ] agent ran a real verification command (soft)

## Module 5 — Dynamic Failure Analysis via Video (checkout wizard loop): FAIL (2 attempts)
- workspace: .data\eval-m5-1791421419542
- elapsed: 1234s
- agent reply: Local image/video analysis failed. Tried qwen3-vl:8b, llama3.2-vision:latest. Ollama model call timed out after 47 seconds.
- typecheck: pass
- agent error: Local image/video analysis failed. Tried qwen3-vl:8b, llama3.2-vision:latest. Ollama model call timed out after 600 seconds.
- modelUsed: Local image/video analysis failed. Tried qwen3-vl:8b, llama3.2-vision:latest. Ollama model call timed out after 600 seconds.
- retry elapsed: 1239s
- workspace kept: .data\eval-m5-1791421419542
- [x] src/CheckoutWizard.tsx exists
- [ ] video frames inspected by local vision model (local_visual_analysis row)
- [x] TypeScript strict typecheck passes
- [x] default export CheckoutWizard is a component
- [x] wizard starts on Step 1 (got "Step 1 of 3: Cart")
- [x] Next advances to Step 2 (got "Step 2 of 3: Shipping")
- [ ] empty postal code does NOT silently loop back to Step 1 (got "Step 1 of 3: Cart")
- [ ] stays on Step 2 when validation fails (got "Step 1 of 3: Cart")
- [ ] inline validation error is displayed (got "")
- [ ] postal input still present after failed validation
- [ ] report cites the observed flow evidence
- [ ] agent used a local model (modelUsed=n/a)
- [ ] agent turn completed without error — Local image/video analysis failed. Tried qwen3-vl:8b, llama3.2-vision:latest. Ollama model call timed out after 600 seconds.
- [x] agent inspected video evidence before editing
- [ ] agent ran a real verification command (soft)

## Evaluation checklist
- [ ] All code compiled/ran with zero syntax/runtime errors
- [ ] Missing types, logic gaps, and UI elements filled (Module 1)
- [ ] Bugs diagnosed and securely refactored (Module 2)
- [ ] New modular code built and verified (Module 3)
- [ ] Visual/dynamic defects handled from logs and flow traces (Modules 4–5)
- [ ] No cloud model used; local qwen3 stack only

**21 failing check(s).**
(4 soft warning(s).)