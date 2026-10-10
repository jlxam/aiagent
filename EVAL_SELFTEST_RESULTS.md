# Evaluation Suite Results

Run: 2026-10-10T09:38:00.210Z

## Module 1 — Incomplete Code Completion (UserTable): PASS
- workspace: .data\eval-m1-1791624934994
- typecheck: pass
- [x] checks detect the unfixed defect (5 check(s) failed on the seed fixture as expected)

## Module 2 — Failing Code Diagnosis & Refactoring (Express route): PASS
- workspace: .data\eval-m2-1791625044033
- [x] checks detect the unfixed defect (10 check(s) failed on the seed fixture as expected)

## Module 3 — New Code Architecture (Dark Mode Toggle with persistence): PASS
- workspace: .data\eval-m3-1791625047619
- [x] checks detect the unfixed defect (1 check(s) failed on the seed fixture as expected)

## Module 4 — Bug Resolution via Screenshot (React hydration error): PASS
- workspace: .data\eval-m4-1791625047722
- typecheck: pass
- [x] checks detect the unfixed defect (4 check(s) failed on the seed fixture as expected)

## Module 5 — Dynamic Failure Analysis via Video (checkout wizard loop): PASS
- workspace: .data\eval-m5-1791625066734
- typecheck: pass
- [x] checks detect the unfixed defect (7 check(s) failed on the seed fixture as expected)

## Evaluation checklist
- [x] All code compiled/ran with zero syntax/runtime errors
- [x] Missing types, logic gaps, and UI elements filled (Module 1)
- [x] Bugs diagnosed and securely refactored (Module 2)
- [x] New modular code built and verified (Module 3)
- [x] Visual/dynamic defects handled from logs and flow traces (Modules 4–5)
- [x] No cloud model used; local qwen3 stack only

**All checks passed.**