# Binance Auto Sell Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generalized backend task runtime that preserves scheduled withdraw behavior and adds Binance spot auto-sell tasks that market-sell a fixed amount every N seconds until the asset balance is exhausted.

**Architecture:** Generalize the existing withdraw-only scheduler into a shared task runtime with action-specific executors for `withdraw` and `sell_market`. Extend the Binance adapter with spot symbol metadata and market-sell capabilities, then add a dedicated sell UI and shared task APIs so both withdraw and sell tasks run through the same persisted runtime.

**Tech Stack:** TypeScript, Express, better-sqlite3, vanilla HTML/JS, Binance REST API

---

### Task 1: Generalize SQLite Task Storage

**Files:**
- Modify: `server/db.ts`
- Test: manual schema verification via local SQLite file plus `npm run build`

- [ ] **Step 1: Write the failing test expectation**

Document the expected schema delta in comments or notes before editing:

```text
schedule_jobs must support job_type, payload_json, progress_json
existing withdraw rows must remain readable after migration
```

- [ ] **Step 2: Run build to confirm the current code does not yet include the new schema**

Run: `npm run build`
Expected: PASS, but no code exists yet for generalized task columns.

- [ ] **Step 3: Write minimal schema migration**

Update `server/db.ts` to:

- create new installs with `job_type`, `payload_json`, `progress_json`
- detect missing columns on existing installs and add them with `ALTER TABLE`
- preserve existing `request_json` data for backward compatibility

- [ ] **Step 4: Run build to verify the schema changes compile**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/db.ts
git commit -m "feat: generalize task storage schema"
```

### Task 2: Define Shared Task Types And Persistence Helpers

**Files:**
- Create: `server/tasks/types.ts`
- Create: `server/tasks/store.ts`
- Modify: `server/routes/withdraw.ts`
- Test: `npm run build`

- [ ] **Step 1: Write the failing test expectation**

Write down the target types and helper contracts:

```ts
type TaskJobType = "withdraw" | "sell_market";
type TaskState = "running" | "completed" | "stopped";
```

Helpers must load old withdraw rows and normalize them into the new task shape.

- [ ] **Step 2: Run build to verify these modules do not exist yet**

Run: `npm run build`
Expected: PASS, but the shared task modules are absent.

- [ ] **Step 3: Write minimal shared task definitions and DB helpers**

Implement:

- shared task payload and progress unions
- row-to-model normalization for old `request_json`
- helpers to save task rows and logs
- helpers to load a task, the active task, and recent logs

- [ ] **Step 4: Update withdraw route imports to consume helpers without changing behavior yet**

Replace local task-row types in `server/routes/withdraw.ts` with imports from the new shared modules where practical.

- [ ] **Step 5: Run build to verify shared task helpers compile**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/tasks/types.ts server/tasks/store.ts server/routes/withdraw.ts
git commit -m "feat: add shared task models"
```

### Task 3: Extract Common Runtime Scheduler

**Files:**
- Create: `server/tasks/runtime.ts`
- Modify: `server/routes/withdraw.ts`
- Test: `npm run build`

- [ ] **Step 1: Write the failing test expectation**

Define the runtime contract first:

```ts
startTask(...)
stopTask(...)
getActiveTask(...)
restoreRunningTasks(...)
```

The runtime must own timers and a single active-task id, matching existing withdraw behavior.

- [ ] **Step 2: Run build to verify the runtime does not exist yet**

Run: `npm run build`
Expected: PASS, but there is no extracted runtime.

- [ ] **Step 3: Write minimal runtime implementation**

Implement a runtime that:

- tracks in-memory timers by task id
- persists state changes through shared store helpers
- supports one active task at a time
- restores the latest running task after unlock/startup

- [ ] **Step 4: Refactor withdraw scheduling to call the runtime**

Move timer orchestration out of `server/routes/withdraw.ts` and adapt existing withdraw schedule endpoints to use the runtime APIs while preserving payload and response shape where possible.

- [ ] **Step 5: Run build to verify withdraw scheduling still compiles**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/tasks/runtime.ts server/routes/withdraw.ts
git commit -m "refactor: extract shared task runtime"
```

### Task 4: Implement Action Executors For Withdraw And Sell

**Files:**
- Create: `server/tasks/executors.ts`
- Modify: `server/routes/withdraw.ts`
- Modify: `server/tasks/runtime.ts`
- Test: `npm run build`

- [ ] **Step 1: Write the failing test expectation**

List the two executor entry points:

```ts
executeWithdrawTaskRound(...)
executeSellMarketTaskRound(...)
```

Withdraw execution must preserve current idempotency and history writes.

- [ ] **Step 2: Run build to confirm executor hooks do not exist yet**

Run: `npm run build`
Expected: PASS, but no action executor layer exists.

- [ ] **Step 3: Write minimal executor layer for withdraw**

Move the current per-round withdraw execution logic into `server/tasks/executors.ts` without changing behavior.

- [ ] **Step 4: Wire runtime to dispatch by job type**

Update the runtime so each scheduled round resolves the correct executor from `job_type`.

- [ ] **Step 5: Run build to verify executor dispatch compiles**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/tasks/executors.ts server/tasks/runtime.ts server/routes/withdraw.ts
git commit -m "refactor: dispatch scheduled tasks by type"
```

### Task 5: Extend Binance Adapter With Symbol Metadata

**Files:**
- Modify: `server/exchange/types.ts`
- Modify: `server/exchange/binance.ts`
- Test: `npm run build`

- [ ] **Step 1: Write the failing test expectation**

Define the required optional exchange capabilities:

```ts
listSpotSymbols?(...)
getSpotSymbol?(...)
placeMarketSellOrder?(...)
```

Binance must provide symbol status, base/quote assets, `minQty`, and `stepSize`.

- [ ] **Step 2: Run build to verify the adapter interface does not yet expose these methods**

Run: `npm run build`
Expected: PASS, but no spot-trading metadata methods exist yet.

- [ ] **Step 3: Write minimal Binance metadata support**

Implement signed or public Binance requests as appropriate to:

- list tradable spot symbols
- fetch a single symbol's rules
- normalize filters needed for quantity validation

- [ ] **Step 4: Extend the shared exchange types carefully**

Add optional methods and normalized types without forcing other exchanges to implement them.

- [ ] **Step 5: Run build to verify exchange adapters compile**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/exchange/types.ts server/exchange/binance.ts
git commit -m "feat: add binance spot symbol metadata"
```

### Task 6: Add Binance Market Sell Execution

**Files:**
- Modify: `server/exchange/types.ts`
- Modify: `server/exchange/binance.ts`
- Modify: `server/tasks/executors.ts`
- Test: `npm run build`

- [ ] **Step 1: Write the failing test expectation**

Document the round rules:

```text
available <= 0 => completed
available >= step_amount => sell step_amount
available < step_amount => sell available and complete if order succeeds
rounded quantity below minQty => stop with error
```

- [ ] **Step 2: Run build to verify no sell executor exists yet**

Run: `npm run build`
Expected: PASS, but no sell execution path exists.

- [ ] **Step 3: Write minimal Binance market-sell adapter method**

Implement quantity-based `MARKET` sell orders and normalize:

- order id
- executed quantity
- cumulative quote quantity
- average price when derivable

- [ ] **Step 4: Write minimal sell-task executor**

Implement the sell round flow in `server/tasks/executors.ts`:

- read balance
- resolve final-round quantity
- round down to valid step
- reject too-small quantity
- place order
- update progress
- complete or schedule next run
- stop immediately on any error

- [ ] **Step 5: Run build to verify sell execution compiles**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/exchange/types.ts server/exchange/binance.ts server/tasks/executors.ts
git commit -m "feat: add binance auto sell executor"
```

### Task 7: Add Trade Routes And Shared Task Control Routes

**Files:**
- Create: `server/routes/trade.ts`
- Modify: `server/routes/withdraw.ts`
- Modify: `server/index.ts`
- Modify: `server/tasks/runtime.ts`
- Test: `npm run build`

- [ ] **Step 1: Write the failing test expectation**

List the new endpoints and payloads:

```text
GET /api/trade/binance/symbols
GET /api/trade/binance/symbol/:symbol
GET /api/trade/binance/balance
POST /api/trade/sell/preview
POST /api/trade/sell/schedule/start
POST /api/tasks/:id/stop
GET /api/tasks/active
GET /api/tasks/:id
```

- [ ] **Step 2: Run build to verify the trade route does not exist yet**

Run: `npm run build`
Expected: PASS, but no trade routes exist.

- [ ] **Step 3: Write minimal trade route handlers**

Implement:

- Binance account validation
- symbol lookup and filtering
- sell preview output
- sell task creation via the shared runtime

- [ ] **Step 4: Generalize task control endpoints**

Expose shared stop and task-detail endpoints, then either wrap or adapt the existing withdraw schedule endpoints to use them.

- [ ] **Step 5: Register the route module**

Mount `server/routes/trade.ts` from `server/index.ts`.

- [ ] **Step 6: Run build to verify API wiring compiles**

Run: `npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/routes/trade.ts server/routes/withdraw.ts server/index.ts server/tasks/runtime.ts
git commit -m "feat: add trade and shared task APIs"
```

### Task 8: Add Sell UI And Generic Task Progress UI

**Files:**
- Modify: `public/index.html`
- Test: `npm run build` plus manual browser verification

- [ ] **Step 1: Write the failing test expectation**

List the new UI behaviors:

```text
sell tab exists
Binance symbols can be searched
preview shows rounded quantity and rule limits
start button launches sell task
progress panel shows generic task info for withdraw and sell
```

- [ ] **Step 2: Run build to establish a clean baseline before editing the UI**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Write minimal sell page markup**

Add:

- `卖出` nav entry
- sell form inputs
- sell preview/result area
- wiring for Binance symbol search and balance loading

- [ ] **Step 4: Upgrade client-side task polling and progress rendering**

Refactor the existing withdraw-only polling code so it can render either withdraw or sell task state from the shared task APIs.

- [ ] **Step 5: Keep withdraw UX working**

Verify the withdraw form still starts, stops, and renders scheduled withdraw progress after the client-side polling changes.

- [ ] **Step 6: Run build to verify the frontend script still compiles in TypeScript-free mode**

Run: `npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: add binance auto sell UI"
```

### Task 9: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `TEST_GUIDE.md`
- Test: docs review plus `npm run build`

- [ ] **Step 1: Write the failing test expectation**

List the new user-facing docs requirements:

```text
README mentions Binance auto sell
README clarifies Binance spot trading permission
TEST_GUIDE covers preview, execution, final-round completion, restart restore, and withdraw regression
```

- [ ] **Step 2: Run build before doc edits**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Write minimal documentation updates**

Update:

- feature list and usage flow in `README.md`
- manual verification steps in `TEST_GUIDE.md`

- [ ] **Step 4: Run build after doc edits**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md TEST_GUIDE.md
git commit -m "docs: add binance auto sell guidance"
```

### Task 10: Final Verification

**Files:**
- Modify: none unless fixes are required
- Test: full verification set

- [ ] **Step 1: Run the required build verification**

Run: `npm run build`
Expected: PASS

- [ ] **Step 2: Run manual verification**

Execute the relevant `TEST_GUIDE.md` scenarios for:

- Binance symbol loading
- sell preview success and failure cases
- start/stop sell task flow
- final-round remaining-balance sell
- restart plus unlock restore
- scheduled withdraw regression

- [ ] **Step 3: Fix any issues found and re-run verification**

If any verification step fails, make the smallest targeted fix and repeat the failing verification immediately.

- [ ] **Step 4: Commit final fixes if needed**

```bash
git add <changed-files>
git commit -m "fix: resolve verification issues"
```
