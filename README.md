# Jev XRPL Trader

Paper-only XRPL market-making research service, forked from [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader). It reads validated XRPL ledgers and order books, evaluates three independent virtual strategies against the same immutable events, and signs or submits no transactions.

This repository preserves the upstream MIT license and copyright notice. See [LICENSE](LICENSE).

## Safety boundary

- `MODE` must be `paper`. Testnet remains the default. Mainnet is available only with both `NETWORK=mainnet` and `SOURCE=mainnet`, and always uses the read-only ledger/book reader. Mainnet requires a separate fresh `DATA_DIR`; `MODEL=mock` and `MODEL=jev` are supported for paper observation only, while live mode remains rejected.
- The only executor in this build is `PaperExecutor`. No wallet, seed, private key, transaction builder, or signing adapter is loaded. Signing-related environment variables are rejected.
- Use a dedicated `DATA_DIR` for a new session. Existing audit state is tied to the original source, market, and synthetic seed.
- Every issued asset requires the exact XRPL currency code and issuer address. XRP is native and has no issuer.
- Testnet direct-offer executions are inferred from metadata in validated `OfferCreate` and `Payment` transactions. Unsupported payment executions without matching target-book offer deltas are explicitly omitted; AMM and non-target routed volumes are not estimated. XRPL metadata is treated as final only after the ledger is validated.
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

Use `--source testnet` to connect to the approved Testnet WebSocket, or `--source replay --replay ./data/market.jsonl` for version 3 recorded market events. Financial amounts, prices, inventory, and P&L are serialized as decimal strings; XRP fees are stored as integer drops. Older journals and replays are rejected instead of being reinterpreted with lossy numeric state. Synthetic source defaults to seed `jev-xrpl-paper-v1`; use `--synthetic-seed` (never a wallet seed) to choose another seed. It is stored in session metadata and the generated sequence resumes deterministically after a restart.

For a read-only Mainnet paper observation, configure the exact Mainnet pair identity, then explicitly select Mainnet and a new, empty data directory:

```sh
bun run trader start --mode paper --network mainnet --source mainnet --data-dir data/mainnet-shadow-2026-09-24
```

The Mainnet source uses `XRPL_MAINNET_WS_URL` (default `wss://xrplcluster.com/`) and only subscribes to ledgers and requests validated ledger and book data. The supported endpoint hosts are restricted to documented public Mainnet endpoints. The XRP Ledger [public server list](https://xrpl.org/docs/tutorials/public-servers) notes that public servers may become unavailable and are not for sustained or business use. The only executor in this repository remains `PaperExecutor`; no transaction builder, signer, or submission path is included. Jev may be enabled for Mainnet paper observation after the read-only feed has been validated. Every new Mainnet observation requires its own fresh `DATA_DIR`; a saved Mainnet directory may be reused only to resume that same saved session.

For the verified XRP/RLUSD Mainnet market, use the official RLUSD currency code and issuer, and start Jev with a new directory:

```sh
bun run trader start --mode paper --network mainnet --source mainnet --model jev \
  --quote 524C555344000000000000000000000000000000 \
  --quote-issuer rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De \
  --mainnet-ws-url wss://s1.ripple.com/ \
  --data-dir data/mainnet-jev-shadow-2026-09-24
```

The pair identity is listed in [Ripple's XRPL RLUSD documentation](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl). Keep the TypeSafe key in the ignored local `.env`; Jev judgments only affect the Jev-skewed paper strategy. Baseline and static control continue on the same immutable Mainnet events.

To run Jev in Testnet shadow mode, keep `NETWORK=testnet` and use `MODEL=jev`. Add your TypeSafe AI credential to the local, Git-ignored `.env` as `TYPESAFE_AI_API_KEY=...`; never pass it as a CLI argument or put it in a session file. Startup rejects Jev mode when the key is missing. The paper process signs and submits nothing. For a short synthetic smoke run, select `SOURCE=synthetic` and a reproducible `SYNTHETIC_SEED`; for XRPL observation use `SOURCE=testnet`. Jev is evaluated once per accepted ledger, and its timeout or invalid response withholds only the Jev strategy's new quotes. A recorded session reports Jev calls, timeouts, latency, input tokens, and modeled inference cost separately.

Version 3 changes the persisted event and financial amount representation. Start it with a new, empty `DATA_DIR` (for example, `DATA_DIR=data/paper-v3`); do not point it at a version 1 session. Version 1 and other earlier audit journals, checkpoints, and replay files are not migrated or deleted: the v3 reader rejects them with a schema-version error. Keep old data separately if it is needed for reference.

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

Each strategy has independent offers, signed inventory, realized and unrealized P&L, daily loss limits, and modeled costs. Offers activate one validated ledger after placement and expire after `OFFER_LIFETIME_LEDGERS` eligible ledgers (default 1). Unchanged quotes retain their queue position. Replacing or canceling a resting offer records a modeled cancel cost; creating each offer records a modeled create cost. `MODELED_XRPL_FEE_DROPS` is charged per modeled create or cancel action. Configurable queue ahead is a fixed base-unit amount plus a fraction of displayed volume at better or equal prices on that side. A qualifying fill records its validated transaction hash, execution price, consumed queue volume, and qualification rule. Each cycle audit event stores the explicit eligible direct-offer base volume, unsupported transaction cases, per-strategy quote decisions and assessments, and fill evidence. Reports state queue and lifetime assumptions. Modeled XRPL fees (XRP) and Jev inference cost (USD) are reported separately from quote-currency P&L; neither is an actual transaction cost in this paper-only build.

The XRPL ledger reader serializes ledger processing, requests each validated ledger with expanded transactions, and reconciles all transaction metadata before reading that ledger's book. A missing ledger, missing transaction metadata, failed book request, empty book, or crossed book pauses the feed rather than publishing a partial or out-of-order event. Payments whose metadata does not expose direct target-book offer deltas are excluded; `delivered_amount` is not treated as DEX volume.

## Local persistence and operations

`DATA_DIR` contains versioned `audit.jsonl`, `checkpoint.json`, `session.json`, and `admin.token` files. Each accepted ledger is appended before dashboard publication. Recovery loads the newest compatible checkpoint and replays later audit events. If the checkpoint is corrupt or incompatible, startup clearly warns and replays the intact, supported-version audit from its beginning; if that journal is unavailable, corrupt, or from an unsupported schema, startup fails with the checkpoint and journal issue. Emergency-stop state is written to the audit stream and checkpoint immediately. A partial final JSONL line is ignored on recovery; malformed earlier records fail startup.

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
