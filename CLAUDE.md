# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Easy Withdraw is a **local-first** cryptocurrency exchange withdrawal tool. Single-process Express backend + single-page vanilla HTML frontend. Currently supports Gate.io, designed to extend to other exchanges.

- Language: TypeScript (ESM, `"type": "module"`)
- Runtime: Node.js with `tsx` for dev
- No frontend build step — `public/index.html` uses Tailwind CDN + vanilla JS

## Commands

```bash
npm run dev      # Dev mode with hot-reload (tsx watch)
npm start        # Production mode (tsx)
npm run build    # TypeScript compile to dist/
```

No test framework is configured. No linter is configured.

## Architecture

**Data flow:** Browser → Express REST API (`/api/*`) → Exchange adapter → Exchange API

**Security model:** Master password → Argon2id KDF → derived key (held in memory) → AES-256-GCM encrypt/decrypt exchange secrets. Server binds to `127.0.0.1` only. Session auto-locks after 15min idle.

### Key modules

- `server/security.ts` — Argon2id KDF, AES-256-GCM encrypt/decrypt, `SessionManager` class (holds derived key in memory, manages idle timeout)
- `server/config.ts` — Reads/writes `~/.easy_withdraw/config.json`. Defines all config types (`AppConfig`, `AccountConfig`, `AddressEntry`, `WithdrawTemplate`). Uses atomic write (write to `.tmp` then rename)
- `server/middleware.ts` — `requireSession()` guard (401 if locked), `requestLogger()`
- `server/exchange/types.ts` — `ExchangeAdapter` interface, shared request/response types
- `server/exchange/gate.ts` — `GateAdapter` implementing Gate.io v4 API with HMAC-SHA512 signing

### Route structure

All routes are factory functions that receive `SessionManager` and return an Express `Router`. Routes protected by `requireSession` middleware: accounts, currencies, addresses, templates, withdraw.

- `routes/auth.ts` — init/unlock/lock/status (no session guard)
- `routes/accounts.ts` — CRUD for exchange accounts
- `routes/currencies.ts` — List currencies/chains from exchange API
- `routes/addresses.ts` — Address book management (stored in config)
- `routes/templates.ts` — Withdraw template management (stored in config)
- `routes/withdraw.ts` — Preview, execute, query status, history

### Config file

Location: `~/.easy_withdraw/config.json` (cross-platform via `os.homedir()`)
History: `~/.easy_withdraw/history.json`

### Frontend

Single `public/index.html` — view switching via JS (Unlock → Accounts → Withdraw → History). Calls backend via `fetch()`.

## Conventions

- All imports use `.js` extension (required for Node16 ESM module resolution)
- API responses follow `{ ok: boolean, error?: string, message?: string }` pattern
- Exchange adapters implement the `ExchangeAdapter` interface from `exchange/types.ts`
- Sensitive data (api_secret, passphrase) is always encrypted at rest; `api_key` stored in plaintext
- Derived key is zeroed (`buffer.fill(0)`) when no longer needed
