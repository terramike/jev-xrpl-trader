import { Client, dropsToXrp } from "xrpl";
import { config } from "./config";
import type { BookLevel, Currency, ExecutableTrade, MarketEvent, Side } from "./types";

export interface MarketDataSource { start(onEvent: (event: MarketEvent) => Promise<void> | void): Promise<void>; close(): Promise<void> }

export function currencyParam(asset: Currency) { return { currency: asset.currency, ...(asset.issuer ? { issuer: asset.issuer } : {}) }; }
function amountValue(value: any): { currency: string; issuer?: string; amount: number } | null {
  if (typeof value === "string") return { currency: "XRP", amount: Number(dropsToXrp(value)) };
  if (!value || typeof value.currency !== "string" || typeof value.value !== "string") return null;
  return { currency: value.currency, issuer: value.issuer, amount: Number(value.value) };
}
function sameAsset(value: any, target: Currency) {
  const parsed = amountValue(value);
  return !!parsed && parsed.currency.toUpperCase() === target.currency.toUpperCase() && (target.currency.toUpperCase() === "XRP" || parsed.issuer === target.issuer);
}
function positive(n: number) { return Number.isFinite(n) && n > 0; }

/** Extract direct XRPL DEX executions from validated Offer ledger nodes; AMM/routed volume is omitted. */
export function executionsFromTransaction(input: any, base: Currency, quote: Currency): ExecutableTrade[] {
  const tx = input?.tx_json ?? input?.transaction ?? input;
  const meta = input?.meta ?? input?.metaData;
  if (!input?.validated || tx?.TransactionType !== "OfferCreate" || (meta?.TransactionResult ?? input?.engine_result) !== "tesSUCCESS") return [];
  const nodes = meta?.AffectedNodes ?? meta?.affected_nodes ?? [];
  const output: ExecutableTrade[] = [];
  for (const wrapper of nodes) {
    const kind = wrapper.ModifiedNode ? "ModifiedNode" : wrapper.DeletedNode ? "DeletedNode" : null;
    if (!kind) continue;
    const node = wrapper[kind];
    if (node.LedgerEntryType !== "Offer") continue;
    const finalFields = node.FinalFields ?? {};
    const previous = node.PreviousFields ?? {};
    const oldFields = { ...finalFields, ...previous };
    const oldGets = amountValue(oldFields.TakerGets), newGets = amountValue(finalFields.TakerGets);
    const oldPays = amountValue(oldFields.TakerPays), newPays = amountValue(finalFields.TakerPays);
    let side: Side, baseDelta: number, quoteDelta: number;
    if (sameAsset(oldFields.TakerGets, base) && sameAsset(oldFields.TakerPays, quote) && oldGets && newGets && oldPays && newPays) {
      side = "buy"; baseDelta = oldGets.amount - newGets.amount; quoteDelta = oldPays.amount - newPays.amount;
    } else if (sameAsset(oldFields.TakerGets, quote) && sameAsset(oldFields.TakerPays, base) && oldGets && newGets && oldPays && newPays) {
      side = "sell"; baseDelta = oldPays.amount - newPays.amount; quoteDelta = oldGets.amount - newGets.amount;
    } else continue;
    if (!positive(baseDelta) || !positive(quoteDelta)) continue;
    output.push({ side, price: quoteDelta / baseDelta, baseVolume: baseDelta, sourceTx: String(tx.hash ?? input.hash ?? "validated-offer") });
  }
  return output;
}

export class XrplMarketDataSource implements MarketDataSource {
  private client = new Client(config.wsUrl, { connectionTimeout: 15_000 });
  private pending = new Map<number, ExecutableTrade[]>();
  private callback: ((event: MarketEvent) => Promise<void> | void) | null = null;
  private lastLedger = 0;
  private closed = false;

  async start(onEvent: (event: MarketEvent) => Promise<void> | void) {
    this.callback = onEvent;
    await this.client.connect();
    await this.client.request({ command: "subscribe", streams: ["ledger", "transactions"] });
    this.client.on("transaction", (message: any) => {
      const index = message.ledger_index;
      if (!Number.isInteger(index) || !message.validated) return;
      const trades = executionsFromTransaction(message, config.base, config.quote);
      if (trades.length) this.pending.set(index, [...(this.pending.get(index) ?? []), ...trades]);
    });
    this.client.on("ledgerClosed", (ledger: any) => {
      const index = Number(ledger.ledger_index);
      if (!Number.isInteger(index) || index <= this.lastLedger) return;
      setTimeout(() => void this.publishLedger(ledger), 300);
    });
  }

  private async publishLedger(ledger: any) {
    if (this.closed || !this.callback) return;
    const ledgerIndex = Number(ledger.ledger_index);
    if (ledgerIndex <= this.lastLedger) return;
    try {
      const [asksResult, bidsResult] = await Promise.all([
        this.client.request({ command: "book_offers", taker_gets: currencyParam(config.base), taker_pays: currencyParam(config.quote), ledger_index: ledgerIndex, limit: 100 }),
        this.client.request({ command: "book_offers", taker_gets: currencyParam(config.quote), taker_pays: currencyParam(config.base), ledger_index: ledgerIndex, limit: 100 }),
      ]);
      const asks = levels(asksResult.result.offers, "ask");
      const bids = levels(bidsResult.result.offers, "bid");
      if (!asks.length || !bids.length || bids[0]!.price >= asks[0]!.price) throw new Error("XRPL returned an empty or crossed book");
      const event: MarketEvent = Object.freeze({
        schemaVersion: 1, eventId: `xrpl:${ledger.ledger_hash ?? ledger.ledgerHash ?? ledgerIndex}`, type: "market",
        timestamp: Date.now(), ledgerIndex, ledgerHash: String(ledger.ledger_hash ?? ledger.ledgerHash ?? ""),
        base: Object.freeze({ ...config.base }), quote: Object.freeze({ ...config.quote }),
        bids: Object.freeze(bids.map((level) => Object.freeze(level))), asks: Object.freeze(asks.map((level) => Object.freeze(level))),
        executions: Object.freeze((this.pending.get(ledgerIndex) ?? []).map((trade) => Object.freeze(trade))), source: "testnet",
      });
      this.pending.delete(ledgerIndex);
      for (const old of this.pending.keys()) if (old < ledgerIndex) this.pending.delete(old);
      this.lastLedger = ledgerIndex;
      await this.callback(event);
    } catch (error) { console.error(`ledger ${ledgerIndex} market read failed: ${(error as Error).message}`); }
  }

  async close() { this.closed = true; if (this.client.isConnected()) await this.client.disconnect(); }
}

function levels(offers: any[], side: "ask" | "bid"): BookLevel[] {
  const grouped = new Map<number, number>();
  for (const offer of offers ?? []) {
    const gets = amountValue(offer.TakerGets), pays = amountValue(offer.TakerPays);
    if (!gets || !pays) continue;
    const baseAmount = side === "ask" ? gets.amount : pays.amount;
    const quoteAmount = side === "ask" ? pays.amount : gets.amount;
    if (!positive(baseAmount) || !positive(quoteAmount)) continue;
    const price = quoteAmount / baseAmount;
    grouped.set(price, (grouped.get(price) ?? 0) + baseAmount);
  }
  return [...grouped].map(([price, baseVolume]) => ({ price, baseVolume })).sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price);
}
