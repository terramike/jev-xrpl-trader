# Testnet data validation: 2026-09-24

This was a read-only Testnet feed run with the paper executor and deterministic mock model. The run did not submit XRPL transactions.

| Field | Result |
| --- | --- |
| Network | XRPL Testnet (`s.altnet.rippletest.net:51233`) |
| Market | XRP / RLUSD Testnet (`524C555344000000000000000000000000000000`, issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`) |
| Data source / model | Testnet / mock |
| Session | Version 3 decimal-accounting run (`DATA_DIR=data/testnet-validation-v3`) |
| Validated ledger events | 14 sequential events, ledger `21023908` through `21023921` |
| Connection state at inspection | Live |
| Direct eligible executions | 0 |
| Explicitly unsupported/unmatched OfferCreate or Payment cases | 67 |
| Simulated fills | 0 |
| Modeled create/cancel actions | Baseline: 14 / 12; static control: 14 / 12; Jev strategy: 0 / 0 |
| Modeled XRP costs | 260 drops (`0.00026 XRP`) each for baseline and control; 0 for Jev |

The book was non-empty and uncrossed for the sampled ledgers. The session produced no eligible executions and no fills, so it provides no strategy P&L evidence and there are no run fills to review manually. The 67 unsupported/unmatched cases are recorded with transaction type, hash, and reason; they were not converted to executable volume. The nonzero modeled costs above reflect the configured create/cancel assumptions, not paid XRPL fees.

## Review of the 67 unsupported/unmatched cases

All 67 transaction hashes were fetched again from validated Testnet history and their complete affected-node metadata was checked against the exact XRP/RLUSD pair above. The result was 10 successful `OfferCreate` transactions with offer nodes only for other pairs, 55 successful `Payment` transactions with no affected Offer nodes, and 2 unsuccessful `Payment` transactions with no affected Offer nodes. None had an XRP/RLUSD Offer node, so none was a direct execution this paper engine should have recognized. The successful Payments without Offer nodes may include non-book paths; this record does not infer DEX volume from them.

Redacted examples (hashes are shortened; account identities and amount details are omitted):

| Category | Count | Example |
| --- | ---: | --- |
| Successful `OfferCreate`; unrelated Offer nodes, no target-pair Offer node | 10 | `45906D512E…5764C6`, ledger 21023908; 2 affected Offer nodes |
| Successful `Payment`; no affected Offer node | 55 | `8682E34444…C0134D`, ledger 21023908 |
| Unsuccessful `Payment`; no affected Offer node | 2 | `53673B7886…9C1D2B`, ledger 21023911 |

The saved validated `OfferCreate` and `Payment` fixtures were also passed through the paper executor with eligible crossing offers. Both produced fills whose source transaction hashes and volumes matched the parser output. This is a fill-path exercise using other Testnet-issued assets, not evidence of XRP/RLUSD liquidity or strategy profitability.

## Longer Testnet observation

A fresh v3 paper session ran with `MODEL=mock` from 2026-09-24 23:08:24 UTC to 23:15:26 UTC (7 minutes). It processed 127 validated ledger events, from ledger 21024105 through 21024231, with 0 ledger-index gaps. The book remained publishable throughout. The feed yielded 0 eligible direct executions and 0 eligible base volume; all 127 ledgers produced 0 simulated fills.

Unsupported/unmatched transactions recorded during this run:

| Transaction type and reason | Count |
| --- | ---: |
| `OfferCreate` · `offercreate-without-direct-target-offer-delta` | 193 |
| `Payment` · `payment-without-direct-target-offer-delta` | 425 |
| `Payment` · `transaction-result-not-successful` | 32 |
| `OfferCreate` · `transaction-result-not-successful` | 5 |

Baseline and static control each recorded 128 modeled offer creates, 126 modeled cancellations, and 2 resting offers at shutdown. At 10 modeled drops per action, each recorded 2,540 drops (`0.00254 XRP`) in hypothetical fees. These are simulator assumptions, not transactions, actual network fees, or a measurement of XRPL offer behavior. The Jev-skewed strategy made 127 mock calls, had 0 timeouts, and placed no quotes. No strategy had fills or P&L evidence. The daemon was stopped with Ctrl+C; the session did not activate the persistent emergency stop.

### Why mock Jev placed no quotes

Replaying the deterministic mock assessment over those 127 saved market events yielded `bearish / high toxicity / extreme volatility` on every ledger. The observed top bid was `0.3017431399451492188640677471163673528982` XRP/RLUSD and the top ask was `0.37875`, a spread of about 2,263.27 bps versus the configured 30 bps spread. The mock labels toxicity high and volatility extreme above three times configured spread (90 bps); the Jev strategy intentionally returns no quotes if either gate triggers. The thin best bid volume (`0.013698 XRP`) against `40 XRP` at the best ask also drove its deterministic direction signal bearish. This explains the zero-quote observation as a risk gate, not a timeout. Before the current telemetry change, the no-quote branch discarded the assessment and stored only the generic reason; new per-ledger events now retain the assessment and the exact abstention gates.

Saved validated Testnet metadata fixtures exercise a partial `OfferCreate` crossing (ledger `21023460`, transaction `3DAD8C00460F4720E772984F2C4C2C8B6A1ABB31192E20D27033A276E2015BF1`) and a `Payment` crossing that fully consumed an offer (ledger `21022834`, transaction `FF0CD9981F89AA84E371F453088F95B8DB452A086FFEC4EAF79EA5C02097220F`). These fixture transactions use other Testnet-issued assets; they validate parser behavior and do not count as executions for this session's RLUSD pair.

The expanded-ledger reconciliation path was exercised against the live Testnet endpoint. It reconciles ledger transactions and reads each book snapshot in ledger order; failure cases pause publication. The separate real-Jev shadow run is deferred by operator choice (“Mock only for now”).
