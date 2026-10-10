# AI Coding Agent Evaluation Suite

Use each module as a separate user task against a disposable test project. These scenarios are intentionally separate from the permanent system prompt so normal user requests are not polluted by five unrelated tasks.

## Running the suite

```powershell
npm run test:eval            # run all 5 modules end-to-end (real local model turns)
npm run test:eval -- --modules 1,4   # run a subset
npm run test:eval:self       # self-test: prove every module's checks FAIL on the unfixed seed fixtures
```

The runner (`scripts/check-eval-suite.mjs`) seeds a disposable workspace per
module under `.data/`, sends the module as one user task through the real agent
API (`/api/agent/chat/stream`, local qwen3 stack only), then verifies the result
deterministically:

- **Module 1** — strict `tsc` typecheck + jsdom render: rows render, header
  click sorts, second click toggles direction.
- **Module 2** — `node --check` + static security scans + a live Express
  runtime harness: malformed JSON → 4xx, missing/invalid email → 400,
  parameterized INSERT (injection payload stays out of the SQL text), db
  failure → 5xx JSON, process survives.
- **Module 3** — strict `tsc` + jsdom: `dark` class toggle, `localStorage`
  persistence across remount, `aria-pressed`, toggle-back.
- **Module 4** — vision-evidence row in history + strict `tsc` + server-render /
  client-hydrate with a skewed clock: zero hydration mismatches, timestamp
  still rendered.
- **Module 5** — vision-evidence row in history + strict `tsc` + jsdom wizard
  flow: empty postal code shows an inline error and stays on Step 2 (no silent
  loop to Step 1), valid postal advances to Step 3.

Every module gets one corrective retry: failing checks are fed back to the agent
as a new user message, then verification reruns. Results are written to
`EVALUATION_RESULTS.md` (`EVAL_SELFTEST_RESULTS.md` for `--self-test`). The
harness exits non-zero if any hard check fails.

## Module 1 — Incomplete Code Completion

```tsx
// TODO: Add proper types for User and Column props
export function UserTable({ data }: { data: any[] }) {
  // TODO: Implement sorting state and sorting logic here
  return (
    <div className="p-4">
      {/* TODO: Render table rows dynamically based on sorted data */}
    </div>
  );
}
```

**Task:** Complete the missing logic, add robust TypeScript types, finish the UI, and verify the result in preview.

**Acceptance:** TypeScript/build passes; sorting works; rows render from data; no `any` is introduced unnecessarily.

## Module 2 — Failing Code Diagnosis & Refactoring

```js
app.post('/api/users', async (req, res) => {
  const { name, email } = req.body;
  const user = await db.query(`INSERT INTO users (name, email) VALUES ('${name}', '${email}')`);
  res.json({ success: true, user });
});
```

**Task:** Diagnose malformed JSON handling, missing DB handling, SQL injection, validation, and unhandled promise rejection. Refactor securely and verify the route behavior.

**Acceptance:** Parameterized query; input validation; malformed/missing data handled; DB errors handled; route does not crash the process.

## Module 3 — New Code Architecture & Development

**Task:** Build a modular Dark Mode Toggle using React and Tailwind CSS with persistent state. Verify the toggle and persistence in preview.

**Acceptance:** Clean component/state separation; persistence survives reload; accessible control; build/runtime pass.

## Module 4 — Bug Resolution via Image / Error Log Analysis

**Scenario:** A supplied screenshot/error log shows:

`Error: Text content does not match server-rendered HTML.`

The visible cause is a dynamic timestamp rendered differently on server and client.

**Task:** Inspect the uploaded evidence with the vision model, diagnose the root cause, implement the appropriate fix (`useEffect`, deterministic rendering, or `suppressHydrationWarning` only when justified), and verify the defect is gone.

**Acceptance:** The diagnosis is grounded in visible evidence; hydration mismatch is resolved; build/runtime verification passes.

## Module 5 — Dynamic Failure Analysis via Video Recording

**Scenario:** A checkout wizard video shows Step 2 → Next silently fails and returns to Step 1 when postal code is empty.

**Task:** Inspect timestamped video frames, identify the failing transition and missing validation, implement clear validation/error feedback, and verify the fixed flow in preview.

**Acceptance:** The agent cites observed visual evidence/timestamps, prevents the silent loop, displays useful validation feedback, and verifies the corrected flow.

## Required evaluation checklist

- [ ] Did all code snippets compile and run with zero syntax/runtime errors?
- [ ] Were all missing types, logic gaps, and UI elements successfully filled?
- [ ] Were bugs correctly diagnosed and securely refactored?
- [ ] Were visual/dynamic defects handled correctly based on logs and flow traces?

## Evaluation checklist

- [ ] Agent classified the task correctly.
- [ ] Agent discovered the relevant project before editing.
- [ ] Agent planned before writing.
- [ ] Missing types/logic/UI were completed where applicable.
- [ ] Security vulnerabilities were fixed rather than ignored.
- [ ] Screenshot/video evidence was actually inspected by the local vision model.
- [ ] Real verification commands were executed.
- [ ] Failed verification triggered self-correction/retry.
- [ ] UI/runtime tasks were checked in preview.
- [ ] Agent did not claim success without evidence.
- [ ] No Gemini/cloud model was used.
