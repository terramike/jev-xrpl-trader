# Jev XRPL Trader — Paper MVP Spec

## Product

A standalone Bun/TypeScript daemon reads validated XRPL Testnet order books and streams a local dashboard. It compares three independent virtual strategies on the same immutable market events. The process does not submit transactions, load signing code, or support Mainnet.

## Strategies

- **Deterministic baseline:** two-sided passive quotes around midpoint at the configured spread and size.
- **Jev-skewed baseline:** baseline quotes adjusted using typed direction, toxicity, volatility, and confidence; high toxicity, extreme volatility, or model timeout withdraws this strategy's offers.
- **Static passive control:** fixed quotes with twice the configured spread and half the configured size.

Each strategy has its own offers, inventory, P&L, risk state, and modeled costs. All receive the same frozen market event and use the same paper fill model.

## Market and execution model

Market identity is the exact base and quote currency plus issuer for each issued currency. XRP is native and has no issuer. Data sources are Testnet, deterministic seeded synthetic, and recorded version 1 JSONL replay.

Testnet execution volume comes only from validated successful direct `OfferCreate` metadata affecting offers in the configured pair. AMM and routed executions are excluded. A virtual order activates one validated ledger after placement. A matching execution consumes configurable fixed queue ahead plus a fraction of displayed better-or-equal-price depth on that side before filling the remaining order, capped by validated executable volume, order remainder, and inventory limit.

## Safety and state

Schema validation accepts only `mode=paper` and `network=testnet`. Signing-related environment settings are rejected. The only executor shipped is `PaperExecutor`.

Version 1 cycle/control events are appended to local JSONL before broadcast. Periodic checkpoints retain simulated offers, inventory, P&L, risk and kill-switch state; recovery loads a compatible checkpoint then replays later audit events. Synthetic sessions store and reuse their seed. A persistent emergency stop cancels virtual offers and blocks new ones until explicit reset.

XRPL fee estimates in XRP and Jev inference estimates in USD are reported separately from quote-currency P&L. They are modeled costs, not actual fees.

## Operations and UI

The daemon and dashboard are separate local processes. CLI commands are `start`, `status`, `report`, `stop`, `cancel-all`, and `reset-stop`. Admin APIs bind to loopback and require a per-process bearer token. `stop` activates the persistent emergency stop; Ctrl+C exits the foreground daemon.

The responsive dashboard displays pair and ledger status, all three strategies, virtual offers/fills, inventory, P&L, risk state, estimated costs, and the persistent stop state. The daemon remains operational if the dashboard is unavailable.

## Out of scope

Live execution, transaction signing, Muse, Cloudflare, and Mainnet access or submission.
