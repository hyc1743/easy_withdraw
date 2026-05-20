# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Dev server with hot reload (tsx watch)
npm start            # Interactive startup: pick localhost or Tailscale IP
npm test             # Run all tests (Node test runner)
npm run build        # TypeScript compilation check (tsc)
npm run serve        # Run compiled output from dist/
```

Run a single test file:
```bash
node --import tsx --test tests/<name>.test.ts
```

## Architecture

**Stack**: TypeScript (strict, ES modules, Node16 resolution), Express backend, vanilla HTML frontend (Tailwind CDN), SQLite via better-sqlite3.

**Data at rest**: All sensitive data (API secrets, private keys, passphrases) is encrypted with AES-256-GCM using a key derived from the master password via Argon2id. Data is stored in `~/.easy_withdraw/` (overridable with `EW_DATA_DIR`).

**Session model**: Cookie-based (`ew_session`). `SessionManager` holds decryption keys in memory with 15-minute idle timeout. A locked session means all encrypted data is inaccessible — running tasks continue executing.

**Task system** (`server/tasks/`): The core abstraction for scheduled/repeated operations. Only one task runs at a time. Task lifecycle:
1. Route handler creates a `TaskJob` object and calls `hydrateTask()` which binds it to an executor and registers it with the `TaskRuntime`.
2. `TaskRuntime` runs rounds via `setTimeout`, persists state to SQLite (`schedule_jobs` / `schedule_logs` tables) after each round.
3. On session unlock, `ensureRuntimeHydrated()` reloads the latest running task from SQLite and re-registers it — this is how tasks survive server restarts.

Three task types exist:
- `withdraw` — scheduled recurring withdrawals at fixed intervals
- `sell_market` — auto market-sell in rounds until balance is depleted
- `crosschain_oft` — LayerZero OFT cross-chain transfers (source tx → poll delivery → complete)

**Exchange adapters** (`server/exchange/`): Each exchange is a class implementing the `ExchangeAdapter` interface. The `adapters` registry maps exchange names to instances. Spot trading methods (`listSpotSymbols`, `getSpotSymbol`, `getSpotBalance`, `placeMarketSellOrder`) are optional — only exchanges that support spot auto-sell implement them. Binance, OKX, Bybit, Gate, Bitget, and MEXC all implement the full interface.

**Onchain module** (`server/onchain/`): EVM wallet management (via ethers.js v6), LayerZero OFT token lookups, cross-chain transfer execution, and cross-chain history persistence.

**Route pattern**: Every route file exports a function that takes `SessionManager` and returns an Express `Router`. All routes except auth and health require session unlock via `requireSession` middleware. Responses follow `{ ok: boolean, error?: string, message?: string }` shape.

**Config storage**: App config lives in SQLite `kv_store` table as a single JSON blob under key `app_config`. `loadConfig()` and `saveConfig()` provide read/write access. Legacy JSON file migration (`config.json`, `history.json`) is handled automatically in `db.ts`.

## Key conventions

- 2-space indentation, camelCase functions/variables, PascalCase types/interfaces
- Adapter classes are named `XxxAdapter` (e.g. `GateAdapter`, `MexcAdapter`)
- Route files in `server/routes/` are named after the resource (e.g. `withdraw.ts`, `trade.ts`)
- Exchange API calls in adapters use the exchange's native REST API with HMAC signing
- Tests use Node's built-in test runner and are located in `tests/`
- No frontend build step — `public/index.html` is a self-contained SPA using Tailwind CDN and vanilla JS

## MEXC idempotency

MEXC does not support `client_withdraw_id`. The `executeWithdrawRequest` in `server/tasks/executors.ts` skips injecting the idempotency key for MEXC accounts. When adding new exchanges, check whether they support client withdraw IDs and add exceptions as needed.
