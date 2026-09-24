import type { MarketEvent, Offer, StrategyState } from "./types";

export interface RiskLimits { maxInventory: number; maxDailyLoss: number; quoteSize: number }
export class DeterministicRiskPolicy {
  update(state: StrategyState, market: MarketEvent, limits: RiskLimits) {
    const day = new Date(market.timestamp).toISOString().slice(0, 10);
    if (state.risk.day !== day) { state.risk.day = day; state.risk.dailyRealizedLoss = 0; }
    if (!state.risk.stopped && state.risk.dailyRealizedLoss >= limits.maxDailyLoss) {
      state.risk.stopped = true;
      state.risk.reason = `daily realized loss limit reached (${limits.maxDailyLoss})`;
    }
  }
  validate(offers: Offer[], state: StrategyState, market: MarketEvent, limits: RiskLimits) {
    const bid = market.bids[0]?.price, ask = market.asks[0]?.price;
    return offers.filter((offer) => {
      if (!Number.isFinite(offer.price) || !Number.isFinite(offer.remaining) || offer.remaining <= 0 || offer.remaining > limits.quoteSize) return false;
      if (offer.side === "buy" && (offer.price >= ask! || state.inventory + offer.remaining > limits.maxInventory)) return false;
      if (offer.side === "sell" && (offer.price <= bid! || state.inventory - offer.remaining < -limits.maxInventory)) return false;
      return true;
    });
  }
}
