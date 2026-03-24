# Binance Auto Sell Design

## Summary

Add a new backend-driven scheduled market-sell capability that can sell a fixed base-asset amount at a user-defined second interval until the asset balance is exhausted. The first implementation supports Binance spot only and reuses the existing persistent schedule infrastructure by generalizing it into a shared task runtime.

## Goals

- Support Binance spot market sell tasks that run on the backend at a second-based interval.
- Let the user choose any valid Binance spot trading pair, such as `BTCUSDT`.
- Sell a fixed base-asset amount each round.
- If the remaining balance is smaller than the configured amount, sell the remaining balance in the final round.
- Stop the task immediately on any execution error.
- Persist task state and logs in SQLite and restore running tasks after service restart and unlock.
- Preserve the current scheduled withdraw behavior by moving it onto the same generalized task runtime.

## Non-Goals

- Buy orders
- Limit orders
- Parallel task orchestration
- Multi-exchange trading support
- Stop-loss, take-profit, or price-triggered execution
- Precomputed total-round scheduling

## User Experience

### New Sell View

Add a dedicated `卖出` page in `public/index.html`. The page contains:

- account selector
- trading pair selector/search
- base asset balance display
- per-round sell amount input
- interval input in seconds
- preview button
- start auto-sell button
- stop task button
- result/status panel

This view should not be merged into the withdraw page because the required inputs and execution semantics differ materially.

### Task Progress Panel

Upgrade the existing right-side progress panel from "withdraw progress" to a generic "task progress" panel. It must show:

- task type
- state
- executed round count
- interval
- next run time
- latest logs

For sell tasks it should also show:

- trading pair
- cumulative sold base quantity
- latest executed quantity
- latest quote quantity
- latest average price

## Architecture

### Generalized Task Runtime

Introduce a shared task runtime for backend-executed repeating tasks.

Suggested file layout:

- `server/tasks/types.ts`
  - common task state and payload types
- `server/tasks/runtime.ts`
  - in-memory runtime registry, timers, restore logic, stop/start helpers
- `server/tasks/executors.ts`
  - action-specific execution handlers for `withdraw` and `sell_market`
- `server/routes/trade.ts`
  - Binance sell APIs

Existing `server/routes/withdraw.ts` should stop owning its own scheduler state machine directly and instead call into the shared runtime.

### Task Types

Define:

- `job_type = "withdraw" | "sell_market"`
- common state: `running | completed | stopped`
- common timing fields: `interval_sec`, `next_run_at`, `created_at`, `updated_at`
- `payload_json`: request payload for the task action
- `progress_json`: action-specific runtime progress

### Withdraw Compatibility

The current scheduled withdraw flow remains supported with no user-visible behavior change other than reading from the shared task runtime instead of the withdraw-only scheduler.

## Sell Task Model

### Start Payload

The sell task start payload should include:

- `account_id`
- `symbol`
- `base_asset`
- `quote_asset`
- `step_amount`
- `interval_sec`

`account_id` must resolve to a Binance account.

### Progress Model

Persist at least:

- `done_count`
- `sold_total`
- `last_order_id`
- `last_executed_qty`
- `last_quote_qty`
- `last_price`
- `final_round` flag when the task is executing the last remaining balance

## Binance Rules

### Market Metadata

Add Binance spot symbol metadata queries so the backend can validate:

- symbol exists
- symbol status is tradable
- base asset and quote asset match the chosen symbol
- market quantity filters such as `minQty`, `stepSize`, and market-lot-size constraints

### Execution Loop

Each sell round runs as follows:

1. Resolve account and confirm it is Binance.
2. Fetch current available balance for `base_asset`.
3. If available balance is `<= 0`, mark task `completed`.
4. Compute intended round quantity:
   - if `available >= step_amount`, use `step_amount`
   - if `0 < available < step_amount`, use `available` and mark as final round
5. Load current symbol filters and round the quantity down to the nearest valid step.
6. If rounded quantity is `<= 0` or lower than the minimum tradable quantity, fail the round and stop the task.
7. Submit a Binance spot `MARKET` order with `side=SELL` using quantity-based execution.
8. Record order result and update progress.
9. If this was the final round, mark task `completed`; otherwise schedule the next run.

### Error Policy

Any error stops the task immediately after writing a task log entry. This includes:

- account is not Binance
- balance query failure
- invalid or halted symbol
- quantity rounded below minimum trade size
- Binance API order failure

## API Design

### Trade APIs

Add:

- `GET /api/trade/binance/symbols?account_id=...`
- `GET /api/trade/binance/symbol/:symbol?account_id=...`
- `GET /api/trade/binance/balance?account_id=...&asset=...`
- `POST /api/trade/sell/preview`
- `POST /api/trade/sell/schedule/start`

### Shared Task APIs

Generalize scheduled-task control APIs to:

- `POST /api/tasks/:id/stop`
- `GET /api/tasks/active`
- `GET /api/tasks/:id`

Existing withdraw routes may either keep compatibility wrappers or migrate frontend calls to the shared task endpoints.

### Preview Response

`POST /api/trade/sell/preview` should return:

- current base balance
- configured step amount
- rounded executable quantity
- symbol status
- quantity rule details such as `minQty` and `stepSize`
- whether the current balance can execute immediately

## Exchange Adapter Changes

Extend `server/exchange/types.ts` with Binance-only market-sell related capabilities that remain optional for exchanges that do not support them yet. Avoid forcing every exchange adapter to implement spot trading immediately.

Binance adapter additions should cover:

- list tradable spot symbols
- get symbol rule details
- place market sell order

The implementation should use Binance signed spot trading endpoints and normalize the returned order information for task logging and UI display.

## Persistence And Migration

### SQLite Changes

Modify `schedule_jobs` to support generalized tasks:

- add `job_type`
- rename or replace `request_json` with `payload_json`
- add `progress_json`

`schedule_logs` can remain unchanged.

### Migration Strategy

At startup:

- detect missing columns and add them with `ALTER TABLE`
- backfill existing scheduled withdraw rows with `job_type = "withdraw"`
- preserve compatibility with old rows that still contain withdraw request payloads

Migration must be non-destructive and safe for existing user data.

## Testing Strategy

### Build Verification

- `npm run build`

### Manual Verification

Add coverage to `TEST_GUIDE.md` for:

- symbol loading for a Binance account
- preview validation for valid and invalid symbols
- preview validation for minimum trade quantity failures
- starting a sell task and observing backend execution at second intervals
- final round selling the remaining smaller-than-step balance
- immediate stop on API or validation error
- service restart plus unlock restoring a running sell task
- scheduled withdraw still working after task-runtime generalization

## Rollout Notes

- This feature depends on Binance API keys with spot trading permission.
- The UI should clearly label that the sell task uses spot market orders.
- The system should log order ids and quantities but must not log secrets.
