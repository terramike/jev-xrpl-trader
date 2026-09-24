import { Decimal } from "./decimal";
import type { MarketEvent, Offer, StrategyState } from "./types";

export interface RiskLimits { maxInventory: string; maxDailyLoss: string; quoteSize: string }
export class DeterministicRiskPolicy {
  update(state: StrategyState, market: MarketEvent, limits: RiskLimits) {
    const day = new Date(market.timestamp).toISOString().slice(0, 10);
    if (state.risk.day !== day) { state.risk.day = day; state.risk.dailyRealizedLoss = "0"; }
    if (!state.risk.stopped && d(state.risk.dailyRealizedLoss).gte(limits.maxDailyLoss)) {
      state.risk.stopped = true;
      state.risk.reason = `daily realized loss limit reached (${limits.maxDailyLoss})`;
    }
  }
  validate(offers: Offer[], state: StrategyState, market: MarketEvent, limits: RiskLimits) {
    const bid = market.bids[0]?.price, ask = market.asks[0]?.price;
    return offers.filter((offer) => {
      const price = d(offer.price), size = d(offer.remaining), inventory = d(state.inventory), maxInventory = d(limits.maxInventory);
      if (!price.isFinite() || !size.isFinite() || !size.gt(0) || size.gt(limits.quoteSize)) return false;
      if (offer.side === "buy" && (price.gte(ask!) || inventory.plus(size).gt(maxInventory))) return false;
      if (offer.side === "sell" && (price.lte(bid!) || inventory.minus(size).lt(maxInventory.negated()))) return false;
      return true;
    });
  }
}
function d(value: string | number) { return new Decimal(value); }
