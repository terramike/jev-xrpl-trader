import type { ExecutableTrade, MarketEvent, Offer, Side, StrategyId, StrategyState } from "../types";

export interface SimulatedFill { strategy: StrategyId; side: Side; price: number; baseVolume: number; ledgerIndex: number }
export interface Executor { applyLedger(id: StrategyId, state: StrategyState, event: MarketEvent, maxInventory: number): SimulatedFill[]; place(state: StrategyState, offers: Offer[], modeledFeeDrops: number): number }

/** The only executor shipped by this MVP. It never constructs or submits XRPL transactions. */
export class PaperExecutor implements Executor {
  applyLedger(id: StrategyId, state: StrategyState, event: MarketEvent, maxInventory: number): SimulatedFill[] {
    const output: SimulatedFill[] = [];
    for (const trade of event.executions) {
      let available = trade.baseVolume;
      for (const offer of state.offers) {
        if (available <= 0 || offer.remaining <= 0 || event.ledgerIndex < offer.eligibleLedger) continue;
        const crosses = offer.side === "buy" ? trade.side === "sell" && trade.price <= offer.price : trade.side === "buy" && trade.price >= offer.price;
        if (!crosses) continue;
        const queue = Math.min(offer.queueRemaining, available);
        offer.queueRemaining -= queue;
        available -= queue;
        if (available <= 0) continue;
        const inventoryCapacity = offer.side === "buy" ? Math.max(0, maxInventory - state.inventory) : Math.max(0, maxInventory + state.inventory);
        const fillSize = Math.min(offer.remaining, available, inventoryCapacity);
        if (fillSize <= 0) continue;
        offer.remaining -= fillSize;
        available -= fillSize;
        applyPosition(state, offer.side, offer.price, fillSize);
        state.fills++;
        output.push({ strategy: id, side: offer.side, price: offer.price, baseVolume: fillSize, ledgerIndex: event.ledgerIndex });
      }
    }
    state.offers = state.offers.filter((offer) => offer.remaining > 1e-10 && event.ledgerIndex < offer.eligibleLedger + 1);
    return output;
  }
  place(state: StrategyState, offers: Offer[], modeledFeeDrops: number) {
    state.offers = structuredClone(offers);
    state.xrplFeesXrp += offers.length * modeledFeeDrops / 1_000_000;
    return offers.length * modeledFeeDrops / 1_000_000;
  }
}

function applyPosition(state: StrategyState, side: Side, price: number, size: number) {
  const signed = side === "buy" ? size : -size;
  const old = state.inventory;
  if (old === 0 || Math.sign(old) === Math.sign(signed)) state.averageEntryPrice = (Math.abs(old) * state.averageEntryPrice + size * price) / (Math.abs(old) + size);
  else {
    const closed = Math.min(Math.abs(old), size);
    const realized = closed * (price - state.averageEntryPrice) * Math.sign(old);
    state.realizedPnl += realized;
    state.risk.dailyRealizedLoss = Math.max(0, state.risk.dailyRealizedLoss - realized);
    if (size > Math.abs(old)) state.averageEntryPrice = price;
    if (size === Math.abs(old)) state.averageEntryPrice = 0;
  }
  state.inventory += signed;
  if (Math.abs(state.inventory) < 1e-10) { state.inventory = 0; state.averageEntryPrice = 0; }
}

export function executionMatchesOffer(trade: ExecutableTrade, offer: Offer) { return offer.side === "buy" ? trade.side === "sell" && trade.price <= offer.price : trade.side === "buy" && trade.price >= offer.price; }
