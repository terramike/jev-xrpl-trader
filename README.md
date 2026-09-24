# Jev XRPL Trader

Paper-only XRPL market-making research service, forked from [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader). It reads validated XRPL Testnet ledgers and order books, evaluates three independent virtual strategies against the same immutable events, and signs or submits no transactions.

This repository preserves the upstream MIT license and copyright notice. See [LICENSE](LICENSE).

## Safety boundary

- `MODE` must be `paper`; `NETWORK` must be `testnet`. Schema validation rejects live or Mainnet values before startup.
- The only executor in this build is `PaperExecutor`. No wallet, seed, private key, transaction builder, or signing adapter is loaded. Signing-related environment variables are rejected.
- Use a dedicated `DATA_DIR` for a new session. Existing audit state is tied to the original source, market, and synthetic seed.
- Every issued asset requires the exact XRPL currency code and issuer address. XRP is native and has no issuer.
- Testnet direct-offer executions are inferred from validated `OfferCreate` metadata. AMM and routed volumes are omitted, making the fill model conservative. Partial fills are limited by eligible validated direct-offer volume, queue ahead, and remaining virtual offer size.
- `stop` activates the persistent emergency stop and clears simulated offers. It leaves the daemon available for inspection. Press Ctrl+C in the foreground terminal to exit; the stop state is restored on the next start. `reset-stop` explicitly clears it.

## Configure and run

Install [Bun](https://bun.sh), copy `.env.example` to `.env`, then set `BASE_CURRENCY`, `QUOTE_CURRENCY`, and the exact `QUOTE_ISSUER` (for an issued quote asset). For an XRP base, leave `BASE_ISSUER` unset. Keep Jev credentials in your local environment; never put them in Git.

```sh
bun install
bun run trader start --source synthetic --synthetic-seed demo-001
bun run trader status
bun run trader report
bun run trader stop
```

Use `--source testnet` to connect to the approved Testnet WebSocket, or `--source replay --replay ./data/market.jsonl` for version 1 recorded market events. Synthetic source defaults to seed `jev-xrpl-paper-v1`; use `--synthetic-seed` (never a wallet seed) to choose another seed. It is stored in session metadata and the generated sequence resumes deterministically after a restart.

The dashboard is a separate local web process:

```sh
cd web
bun install
bun run dev -- --port 3002
```

The data API and SSE stream bind to `127.0.0.1:3000`; the authenticated admin endpoint binds to `127.0.0.1:3001`. A per-process bearer token is written to `DATA_DIR/admin.token` for the CLI. The dashboard can read events but cannot invoke administrative actions. The daemon continues if the dashboard is closed.

## Strategies and fill assumptions

- **Baseline:** deterministic two-sided passive quotes around the midpoint at the configured spread and size.
- **Jev-skewed baseline:** baseline quotes skewed by a typed direction/toxicity/volatility/confidence assessment. High toxicity, extreme volatility, or a Jev timeout withholds quotes for that strategy only.
- **Static passive control:** deterministic quotes at twice the configured spread and half the configured size, without directional inputs.

Each strategy has independent offers, signed inventory, realized and unrealized P&L, daily loss limits, and modeled costs. Offers activate one validated ledger after placement. Configurable queue ahead is a fixed base-unit amount plus a fraction of displayed volume at better or equal prices on that side. When a validated direct DEX execution crosses an offer, it consumes queue first and then fills up to the remaining executable volume. Modeled XRPL fees (XRP) and Jev inference cost (USD) are reported separately from quote-currency P&L; neither is an actual transaction cost in this paper-only build.

## Local persistence and operations

`DATA_DIR` contains versioned `audit.jsonl`, `checkpoint.json`, `session.json`, and `admin.token` files. Each accepted ledger is appended before dashboard publication. Recovery loads the newest compatible checkpoint and replays later audit events. Emergency-stop state is written to the audit stream and checkpoint immediately. A partial final JSONL line is ignored on recovery; malformed earlier records fail startup.

```sh
bun run trader status
bun run trader report
bun run trader cancel-all
bun run trader stop
bun run trader reset-stop
```

`status` and `report` are read-only. Administrative requests use a random local bearer token, no CORS is enabled on the admin port, and both servers bind only to loopback.

## Validation

```sh
bun test
cd web && bun run build
```

Tests cover configuration rejection, event-version validation, deterministic synthetic replay, partial fills and queue assumptions, one-ledger latency, independent strategy accounting, audit/checkpoint recovery, persistent emergency stop, and local admin controls.

## Deferred

Live execution, all signing adapters (including Muse), Cloudflare hosting, and Mainnet connectivity or submission are out of scope. This code is an experimental paper-trading tool, not a profitability claim or financial advice.
