import { Client, dropsToXrp } from "xrpl";
import { Decimal } from "./decimal";
import { config } from "./config";
import { EVENT_VERSION, type BookLevel, type Currency, type ExecutableTrade, type MarketEvent, type Side } from "./types";

export interface MarketDataSource { start(onEvent: (event: MarketEvent) => Promise<void> | void): Promise<void>; close(): Promise<void> }

export function currencyParam(asset: Currency) { return { currency: asset.currency, ...(asset.issuer ? { issuer: asset.issuer } : {}) }; }
function amountValue(value: any): { currency: string; issuer?: string; amount: Decimal } | null {
  if (typeof value === "string") return { currency: "XRP", amount: new Decimal(dropsToXrp(value)) };
  if (!value || typeof value.currency !== "string" || typeof value.value !== "string") return null;
  try { return { currency: value.currency, issuer: value.issuer, amount: new Decimal(value.value) }; } catch { return null; }
}
function sameAsset(value: any, target: Currency) {
  const parsed = amountValue(value);
  return !!parsed && parsed.currency.toUpperCase() === target.currency.toUpperCase() && (target.currency.toUpperCase() === "XRP" || parsed.issuer === target.issuer);
}
function positive(n: Decimal | null | undefined) { return !!n && n.isFinite() && n.gt(0); }

export type TransactionExecutionResult = { trades: ExecutableTrade[]; unsupportedReason?: string };
/** Parse direct Offer-ledger deltas from validated OfferCreate or Payment metadata only. */
export function executionsFromTransaction(input: any, base: Currency, quote: Currency): ExecutableTrade[] {
  return transactionExecutionResult(input, base, quote).trades;
}
export function transactionExecutionResult(input: any, base: Currency, quote: Currency): TransactionExecutionResult {
  const tx = input?.tx_json ?? input?.transaction ?? input;
  const meta = input?.meta ?? input?.metaData ?? input?.metadata;
  const txType = tx?.TransactionType;
  if (!["OfferCreate", "Payment"].includes(txType)) return { trades: [] };
  if (!input?.validated) return { trades: [], unsupportedReason: "transaction-metadata-not-validated" };
  if ((meta?.TransactionResult ?? input?.engine_result) !== "tesSUCCESS") return { trades: [], unsupportedReason: "transaction-result-not-successful" };
  const nodes = meta?.AffectedNodes ?? meta?.affected_nodes ?? [];
  const output: ExecutableTrade[] = [];
  for (const wrapper of nodes) {
    const kind = wrapper.ModifiedNode ? "ModifiedNode" : wrapper.DeletedNode ? "DeletedNode" : null;
    if (!kind) continue;
    const node = wrapper[kind];
    if (node.LedgerEntryType !== "Offer") continue;
    // A transaction may delete its own previous offer while replacing it; this is not executed volume.
    if (node.FinalFields?.Account && node.FinalFields.Account === tx.Account) continue;
    const finalFields = node.FinalFields ?? {};
    const previous = node.PreviousFields ?? {};
    // Without explicit before/after amount changes a deleted offer could simply have expired or been unfunded.
    if (!previous.TakerGets || !previous.TakerPays || !finalFields.TakerGets || !finalFields.TakerPays) continue;
    const oldFields = { ...finalFields, ...previous };
    const oldGets = amountValue(oldFields.TakerGets), newGets = amountValue(finalFields.TakerGets);
    const oldPays = amountValue(oldFields.TakerPays), newPays = amountValue(finalFields.TakerPays);
    let side: Side, baseDelta: Decimal, quoteDelta: Decimal;
    if (sameAsset(oldFields.TakerGets, base) && sameAsset(oldFields.TakerPays, quote) && oldGets && oldPays) {
      side = "buy";
      baseDelta = oldGets.amount.minus(newGets?.amount ?? 0);
      quoteDelta = oldPays.amount.minus(newPays?.amount ?? 0);
    } else if (sameAsset(oldFields.TakerGets, quote) && sameAsset(oldFields.TakerPays, base) && oldGets && oldPays) {
      side = "sell";
      baseDelta = oldPays.amount.minus(newPays?.amount ?? 0);
      quoteDelta = oldGets.amount.minus(newGets?.amount ?? 0);
    } else continue;
    if (!positive(baseDelta) || !positive(quoteDelta)) continue;
    output.push({ side, price: quoteDelta.div(baseDelta).toString(), baseVolume: baseDelta.toString(), sourceTx: String(tx.hash ?? input.hash ?? "validated-offer") });
  }
  // Payments without an affected offer can still be AMM/routed/unrelated. Never infer book volume from delivered_amount.
  if (output.length === 0) return { trades: [], unsupportedReason: txType === "Payment" ? "payment-without-direct-target-offer-delta" : "offercreate-without-direct-target-offer-delta" };
  return { trades: output };
}

export class XrplMarketDataSource implements MarketDataSource {
  private client = new Client(config.network === "mainnet" ? config.mainnetWsUrl : config.wsUrl, { connectionTimeout: 15_000 });
  private callback: ((event: MarketEvent) => Promise<void> | void) | null = null;
  private lastLedger = 0;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private paused = false;

  async start(onEvent: (event: MarketEvent) => Promise<void> | void) {
    this.callback = onEvent;
    await this.client.connect();
    await this.client.request({ command: "subscribe", streams: ["ledger"] });
    this.client.on("ledgerClosed", (ledger: any) => {
      this.queue = this.queue.then(() => this.processThrough(Number(ledger.ledger_index), ledger)).catch((error) => {
        this.paused = true;
        console.error(`${config.network} feed paused at ledger ${ledger.ledger_index}: ${(error as Error).message}`);
      });
    });
  }

  private async processThrough(targetIndex: number, latestHeader: any) {
    if (this.closed || !this.callback || this.paused || !Number.isInteger(targetIndex) || targetIndex <= this.lastLedger) return;
    // Reconcile every missed index via validated expanded ledger contents. Failed/gapped reads fail closed.
    const first = this.lastLedger ? this.lastLedger + 1 : targetIndex;
    for (let index = first; index <= targetIndex; index++) {
      const ledgerResult = await this.client.request({ command: "ledger", ledger_index: index, transactions: true, expand: true });
      const ledger = ledgerResult.result;
      if (!ledger.validated || ledger.ledger_index !== index || !ledger.ledger_hash) throw new Error(`ledger ${index} was not returned as the requested validated ledger`);
      const txs: any[] = ledger.ledger?.transactions ?? [];
      if (txs.some((entry) => !entry.metaData && !entry.meta && !entry.metadata)) throw new Error(`ledger ${index} contains a transaction without final metadata`);
      const parsed = txs.map((entry) => ({ entry, result: transactionExecutionResult({ ...entry, validated: true }, config.base, config.quote) }));
      const executions = parsed.flatMap(({ result }) => result.trades);
      const unsupportedExecutions = parsed.flatMap(({ entry, result }) => result.unsupportedReason ? [{ sourceTx: String(entry.tx_json?.hash ?? entry.hash ?? "unknown"), transactionType: String(entry.tx_json?.TransactionType ?? entry.transaction?.TransactionType ?? "unknown"), reason: result.unsupportedReason }] : []);
      const [asksResult, bidsResult] = await Promise.all([
        this.client.request({ command: "book_offers", taker_gets: currencyParam(config.base), taker_pays: currencyParam(config.quote), ledger_index: index, limit: 100 }),
        this.client.request({ command: "book_offers", taker_gets: currencyParam(config.quote), taker_pays: currencyParam(config.base), ledger_index: index, limit: 100 }),
      ]);
      const asks = levels(asksResult.result.offers, "ask");
      const bids = levels(bidsResult.result.offers, "bid");
      if (!asks.length || !bids.length || bids[0]!.price >= asks[0]!.price) throw new Error(`ledger ${index} returned an empty or crossed book`);
      const hash = String(ledger.ledger_hash ?? (index === targetIndex ? latestHeader.ledger_hash ?? latestHeader.ledgerHash : ""));
      if (!hash) throw new Error(`ledger ${index} has no hash`);
      const event: MarketEvent = Object.freeze({
        schemaVersion: EVENT_VERSION, eventId: `xrpl:${hash}`, type: "market", timestamp: Date.now(), ledgerIndex: index, ledgerHash: hash,
        base: Object.freeze({ ...config.base }), quote: Object.freeze({ ...config.quote }),
        bids: Object.freeze(bids.map((level) => Object.freeze(level))), asks: Object.freeze(asks.map((level) => Object.freeze(level))),
        executions: Object.freeze(executions.map((trade) => Object.freeze(trade))), unsupportedExecutions: Object.freeze(unsupportedExecutions.map((item) => Object.freeze(item))), source: config.network,
      });
      await this.callback(event);
      this.lastLedger = index;
    }
  }

  async close() { this.closed = true; await this.queue; if (this.client.isConnected()) await this.client.disconnect(); }
}

function levels(offers: any[], side: "ask" | "bid"): BookLevel[] {
  const grouped = new Map<string, { price: Decimal; volume: Decimal }>();
  for (const offer of offers ?? []) {
    const gets = amountValue(offer.TakerGets), pays = amountValue(offer.TakerPays);
    if (!gets || !pays) continue;
    const baseAmount = side === "ask" ? gets.amount : pays.amount;
    const quoteAmount = side === "ask" ? pays.amount : gets.amount;
    if (!positive(baseAmount) || !positive(quoteAmount)) continue;
    const price = quoteAmount.div(baseAmount), key = price.toString();
    const current = grouped.get(key);
    grouped.set(key, { price, volume: (current?.volume ?? new Decimal(0)).plus(baseAmount) });
  }
  return [...grouped.values()].map(({ price, volume }) => ({ price: price.toString(), baseVolume: volume.toString() })).sort((a, b) => side === "bid" ? new Decimal(b.price).comparedTo(a.price) : new Decimal(a.price).comparedTo(b.price));
}
