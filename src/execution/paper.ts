import { Decimal } from "../decimal";
import type { ExecutableTrade, MarketEvent, Offer, Side, StrategyId, StrategyState } from "../types";

export interface SimulatedFill { strategy: StrategyId; side: Side; price: string; baseVolume: string; ledgerIndex: number; sourceTx: string; executionPrice: string; queueVolumeConsumed: string; qualification: string }
export interface Executor { applyLedger(id: StrategyId, state: StrategyState, event: MarketEvent, maxInventory: string, modeledFeeDrops?: string): SimulatedFill[]; place(state: StrategyState, offers: Offer[], modeledFeeDrops: string): void }

/** The only executor shipped by this MVP. It never constructs or submits XRPL transactions. */
export class PaperExecutor implements Executor {
  applyLedger(id: StrategyId, state: StrategyState, event: MarketEvent, maxInventory: string, modeledFeeDrops = "10"): SimulatedFill[] {
    const output: SimulatedFill[] = [];
    const expired = state.offers.filter((offer) => d(offer.remaining).gt(0) && event.ledgerIndex >= (offer.expiresLedger ?? offer.eligibleLedger + 1));
    this.recordCancels(state, expired.length, modeledFeeDrops);
    state.offers = state.offers.filter((offer) => d(offer.remaining).gt(0) && event.ledgerIndex < (offer.expiresLedger ?? offer.eligibleLedger + 1));
    for (const trade of event.executions) {
      let available = d(trade.baseVolume);
      for (const offer of state.offers) {
        const remaining = d(offer.remaining);
        if (!available.gt(0) || !remaining.gt(0) || event.ledgerIndex < offer.eligibleLedger) continue;
        if (!executionMatchesOffer(trade, offer)) continue;
        const queue = Decimal.min(d(offer.queueRemaining), available);
        offer.queueRemaining = d(offer.queueRemaining).minus(queue).toString();
        available = available.minus(queue);
        if (!available.gt(0)) continue;
        const inventory = d(state.inventory), capacity = offer.side === "buy" ? Decimal.max(0, d(maxInventory).minus(inventory)) : Decimal.max(0, d(maxInventory).plus(inventory));
        const fillSize = Decimal.min(remaining, available, capacity);
        if (!fillSize.gt(0)) continue;
        offer.remaining = remaining.minus(fillSize).toString();
        available = available.minus(fillSize);
        applyPosition(state, offer.side, d(offer.price), fillSize);
        state.fills++;
        output.push({ strategy: id, side: offer.side, price: offer.price, baseVolume: fillSize.toString(), ledgerIndex: event.ledgerIndex, sourceTx: trade.sourceTx, executionPrice: trade.price, queueVolumeConsumed: queue.toString(), qualification: "validated direct offer execution crossed an eligible paper offer after configured queue volume" });
      }
    }
    state.offers = state.offers.filter((offer) => d(offer.remaining).gt(0));
    return output;
  }

  place(state: StrategyState, offers: Offer[], modeledFeeDrops: string) {
    const retained = new Set<Offer>();
    const next: Offer[] = [];
    for (const desired of offers) {
      const current = state.offers.find((offer) => !retained.has(offer) && offer.side === desired.side && d(offer.price).eq(desired.price) && d(offer.remaining).lte(desired.remaining) && offer.expiresLedger !== undefined);
      if (current) { retained.add(current); next.push(current); }
      else next.push(structuredClone(desired));
    }
    const canceled = state.offers.filter((offer) => !retained.has(offer));
    const created = next.filter((offer) => !retained.has(offer));
    this.recordCancels(state, canceled.length, modeledFeeDrops);
    this.recordCreates(state, created.length, modeledFeeDrops);
    state.offers = next;
  }
  cancelAll(state: StrategyState, modeledFeeDrops: string) {
    const count = state.offers.length;
    this.recordCancels(state, count, modeledFeeDrops);
    state.offers = [];
  }
  private recordCreates(state: StrategyState, count: number, feeDrops: string) { state.modeledOfferCreates += count; state.xrplFeeDrops = (BigInt(state.xrplFeeDrops) + BigInt(feeDrops) * BigInt(count)).toString(); }
  private recordCancels(state: StrategyState, count: number, feeDrops: string) { state.modeledOfferCancels += count; state.xrplFeeDrops = (BigInt(state.xrplFeeDrops) + BigInt(feeDrops) * BigInt(count)).toString(); }
}

function applyPosition(state: StrategyState, side: Side, price: Decimal, size: Decimal) {
  const signed = side === "buy" ? size : size.negated();
  const old = d(state.inventory), average = d(state.averageEntryPrice);
  if (old.isZero() || old.isPositive() === signed.isPositive()) {
    const denominator = old.abs().plus(size);
    state.averageEntryPrice = denominator.isZero() ? "0" : old.abs().times(average).plus(size.times(price)).div(denominator).toString();
  } else {
    const closed = Decimal.min(old.abs(), size);
    const realized = closed.times(price.minus(average)).times(old.isPositive() ? 1 : -1);
    state.realizedPnl = d(state.realizedPnl).plus(realized).toString();
    state.risk.dailyRealizedLoss = Decimal.max(0, d(state.risk.dailyRealizedLoss).minus(realized)).toString();
    if (size.gt(old.abs())) state.averageEntryPrice = price.toString();
    if (size.eq(old.abs())) state.averageEntryPrice = "0";
  }
  state.inventory = old.plus(signed).toString();
  if (d(state.inventory).isZero()) state.averageEntryPrice = "0";
}

export function executionMatchesOffer(trade: ExecutableTrade, offer: Offer) { return offer.side === "buy" ? trade.side === "sell" && d(trade.price).lte(offer.price) : trade.side === "buy" && d(trade.price).gte(offer.price); }
function d(value: string | number) { return new Decimal(value); }
