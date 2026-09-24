import type { MarketEvent, Offer, Side, StrategyContext, StrategyId, StrategyState } from "./types";

export interface Strategy { readonly id: StrategyId; decide(context: StrategyContext): Offer[] }

abstract class PassiveStrategy implements Strategy {
  abstract readonly id: StrategyId;
  protected abstract parameters(context: StrategyContext): { center: number; spreadBps: number; bidSize: number; askSize: number; reason: string } | null;
  decide(context: StrategyContext): Offer[] {
    const { state, market, risk } = context;
    if (context.emergencyStop) return this.cancel(state, "persistent emergency stop");
    if (state.risk.stopped) return this.cancel(state, state.risk.reason ?? "risk stop");
    const bestBid = market.bids[0]?.price, bestAsk = market.asks[0]?.price;
    if (!bestBid || !bestAsk || bestBid >= bestAsk) return this.cancel(state, "book unavailable or crossed");
    const params = this.parameters(context);
    if (!params) return this.cancel(state, "strategy withheld quotes");
    const half = params.center * params.spreadBps / 20_000;
    const bid = Math.min(bestBid, params.center - half);
    const ask = Math.max(bestAsk, params.center + half);
    if (!(bid > 0 && ask > bid)) return this.cancel(state, "quote would cross or be invalid");
    const bidCapacity = Math.max(0, risk.maxInventory - state.inventory);
    const askCapacity = Math.max(0, risk.maxInventory + state.inventory);
    const quotes: Offer[] = [];
    if (bidCapacity > 0 && params.bidSize > 0) quotes.push(this.offer(market, risk, state, "buy", bid, Math.min(params.bidSize, bidCapacity)));
    if (askCapacity > 0 && params.askSize > 0) quotes.push(this.offer(market, risk, state, "sell", ask, Math.min(params.askSize, askCapacity)));
    state.lastDecision = { assessment: context.assessment, quotes: structuredClone(quotes), reason: params.reason };
    return quotes;
  }
  protected cancel(state: StrategyState, reason: string) { state.offers = []; state.lastDecision = { assessment: null, quotes: [], reason }; return []; }
  private offer(market: MarketEvent, risk: StrategyContext["risk"], state: StrategyState, side: Side, price: number, size: number): Offer {
    const queueLevels = side === "buy" ? market.bids.filter((item) => item.price >= price) : market.asks.filter((item) => item.price <= price);
    const visibleAhead = queueLevels.reduce((sum, item) => sum + item.baseVolume, 0);
    return { id: `${this.id}:${market.ledgerIndex}:${side}`, side, price: significant(price), remaining: significant(size), queueRemaining: risk.queueAheadBase + visibleAhead * risk.queueAheadFraction, placedLedger: market.ledgerIndex, eligibleLedger: market.ledgerIndex + 1 };
  }
}

export class DeterministicBaseline extends PassiveStrategy {
  readonly id = "baseline" as const;
  protected parameters({ market, risk }: StrategyContext) { return { center: mid(market), spreadBps: risk.spreadBps, bidSize: risk.quoteSize, askSize: risk.quoteSize, reason: "deterministic two-sided baseline" }; }
}
export class JevSkewedBaseline extends PassiveStrategy {
  readonly id = "jev" as const;
  protected parameters({ market, risk, assessment }: StrategyContext) {
    if (!assessment || assessment.toxicity === "high" || assessment.volatility === "extreme") return null;
    const sign = assessment.direction === "bullish" ? 1 : assessment.direction === "bearish" ? -1 : 0;
    const skewBps = sign * assessment.confidence * Math.min(risk.spreadBps / 2, 20);
    const center = mid(market) * (1 + skewBps / 10_000);
    const factor = assessment.direction === "bullish" ? 1 + assessment.confidence : assessment.direction === "bearish" ? 1 - assessment.confidence * 0.5 : 1;
    return { center, spreadBps: risk.spreadBps * (assessment.volatility === "normal" ? 1.25 : 1), bidSize: risk.quoteSize * (assessment.direction === "bullish" ? factor : 1), askSize: risk.quoteSize * (assessment.direction === "bearish" ? factor : 1), reason: `Jev ${assessment.direction}/${assessment.toxicity}/${assessment.volatility} confidence ${assessment.confidence.toFixed(2)}` };
  }
}
export class StaticPassiveControl extends PassiveStrategy {
  readonly id = "control" as const;
  protected parameters({ market, risk }: StrategyContext) { return { center: mid(market), spreadBps: risk.spreadBps * 2, bidSize: risk.quoteSize * 0.5, askSize: risk.quoteSize * 0.5, reason: "static passive control; double spread and half size" }; }
}
export const createStrategies = (): Strategy[] => [new DeterministicBaseline(), new JevSkewedBaseline(), new StaticPassiveControl()];
function mid(event: MarketEvent) { return (event.bids[0]!.price + event.asks[0]!.price) / 2; }
function significant(value: number) { return Number(value.toPrecision(12)); }
