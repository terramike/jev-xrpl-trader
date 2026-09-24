"use client";

import { useFeed } from "@/lib/useFeed";
import styles from "./page.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3000";
const money = (n: number, currency: string) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(4)} ${currency}`;
const qty = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });

export default function Page() {
  const feed = useFeed(API_URL);
  const latest = feed.events.at(-1);
  const labels = { baseline: "Deterministic baseline", jev: "Jev-skewed baseline", control: "Static passive control" };
  return <main className={styles.shell}>
    <header className={styles.header}>
      <div><div className={styles.eyebrow}>XRPL PAPER TRADER · TESTNET ONLY</div><h1>Jev XRPL Trader</h1><div className={styles.pair}>{latest ? `${latest.market.base.currency}/${latest.market.quote.currency}` : "Configured XRPL pair"} <span>ledger {latest?.market.ledgerIndex ?? "—"}</span></div><div className={styles.issuer}>Issuer identity: {latest?.market.base.issuer ? `${latest.market.base.currency} ${latest.market.base.issuer}` : "XRP (native)"} · {latest?.market.quote.issuer ? `${latest.market.quote.currency} ${latest.market.quote.issuer}` : latest?.market.quote.currency ?? "quote pending"}</div></div>
      <div className={styles.status}><span className={feed.connection === "live" ? styles.live : styles.offline} />API {feed.connection}<strong>Market {feed.marketConnection}</strong><strong>{latest?.emergencyStop ? "EMERGENCY STOP ACTIVE" : "Paper only · no transactions"}</strong></div>
    </header>
    <section className={styles.market}>
      <div><small>Mid price</small><strong>{latest ? qty((latest.market.bids[0]!.price + latest.market.asks[0]!.price) / 2) : "—"}</strong></div>
      <div><small>Best bid</small><strong>{latest ? qty(latest.market.bids[0]!.price) : "—"}</strong></div>
      <div><small>Best ask</small><strong>{latest ? qty(latest.market.asks[0]!.price) : "—"}</strong></div>
      <div><small>Validated executions</small><strong>{latest?.market.executions.length ?? 0}</strong></div>
      <div><small>Source</small><strong>{latest?.market.source ?? "waiting"}</strong></div>
    </section>
    <section className={styles.strategies}>
      {(["baseline", "jev", "control"] as const).map((id) => {
        const snapshot = latest?.strategies[id];
        const state = snapshot?.state;
        return <article className={styles.card} key={id}>
          <div className={styles.cardHead}><h2>{labels[id]}</h2><span className={state?.risk.stopped ? styles.badgeDanger : styles.badge}>{state?.risk.stopped ? "RISK STOP" : "PAPER"}</span></div>
          <p className={styles.reason}>{state?.lastDecision.reason ?? "Waiting for first validated market event"}</p>
          <div className={styles.metrics}><div><small>Inventory</small><strong>{qty(state?.inventory ?? 0)}</strong></div><div><small>Open offers</small><strong>{state?.offers.length ?? 0}</strong></div><div><small>Realized P&amp;L ({latest?.market.quote.currency ?? "quote"})</small><strong>{money(state?.realizedPnl ?? 0, latest?.market.quote.currency ?? "")}</strong></div><div><small>Total P&amp;L ({latest?.market.quote.currency ?? "quote"})</small><strong className={(snapshot?.totalPnl ?? 0) >= 0 ? styles.positive : styles.negative}>{money(snapshot?.totalPnl ?? 0, latest?.market.quote.currency ?? "")}</strong></div><div><small>XRPL fee model</small><strong>{qty(state?.xrplFeesXrp ?? 0)} XRP</strong></div><div><small>Jev inference</small><strong>${(state?.jevCostUsd ?? 0).toFixed(6)}</strong></div></div>
          <div className={styles.offerList}>{state?.offers.map((offer) => <span key={offer.id} className={offer.side === "buy" ? styles.bid : styles.ask}>{offer.side.toUpperCase()} {qty(offer.remaining)} @ {qty(offer.price)} · queue {qty(offer.queueRemaining)}</span>)}</div>
          {state?.lastDecision.assessment && <div className={styles.assessment}>Jev: {state.lastDecision.assessment.direction} · toxicity {state.lastDecision.assessment.toxicity} · volatility {state.lastDecision.assessment.volatility} · confidence {state.lastDecision.assessment.confidence.toFixed(2)}</div>}
        </article>;
      })}
    </section>
    <section className={styles.tape}><div className={styles.tapeHead}><h2>Ledger audit stream</h2><span>{feed.events.length} events in view</span></div>{feed.events.slice(-30).reverse().map((event) => <div className={styles.row} key={event.eventId}><time>{new Date(event.timestamp).toLocaleTimeString()}</time><b>#{event.market.ledgerIndex}</b><span>{event.market.ledgerHash.slice(0, 12)}</span><span>{event.market.executions.length} direct DEX executions</span><span>{Object.entries(event.strategies).map(([id, s]) => `${id}: ${s.state.fills} fills`).join(" · ")}</span><span>{event.emergencyStop ? "STOPPED" : "active"}</span></div>)}{feed.events.length === 0 && <p className={styles.waiting}>Waiting for a versioned market event…</p>}</section>
    <footer className={styles.footer}>Paper simulation only. Offers are virtual. XRPL modeled fees and Jev inference costs are estimates reported separately.</footer>
  </main>;
}
