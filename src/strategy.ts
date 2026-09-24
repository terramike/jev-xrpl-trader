import { Decimal } from "./decimal";
import { config } from "./config";
import type { MarketEvent, Offer, Side, StrategyContext, StrategyId, StrategyState } from "./types";

export interface Strategy { readonly id: StrategyId; decide(context: StrategyContext): Offer[] }
type QuoteParameters = { center: Decimal; spreadBps: Decimal; bidSize: Decimal; askSize: Decimal; reason: string };

abstract class PassiveStrategy implements Strategy {
  abstract readonly id: StrategyId;
  protected abstract parameters(context: StrategyContext): QuoteParameters | null;
  decide(context: StrategyContext): Offer[] {
    const { state, market, risk } = context;
    if (context.emergencyStop) return this.cancel(state, "persistent emergency stop");
    if (state.risk.stopped) return this.cancel(state, state.risk.reason ?? "risk stop");
    const bestBid = market.bids[0]?.price, bestAsk = market.asks[0]?.price;
    if (!bestBid || !bestAsk || d(bestBid).gte(bestAsk)) return this.cancel(state, "book unavailable or crossed");
    const params = this.parameters(context);
    if (!params) return this.cancel(state, "strategy withheld quotes");
    const half = params.center.times(params.spreadBps).div(20_000);
    const bid = Decimal.min(d(bestBid), params.center.minus(half));
    const ask = Decimal.max(d(bestAsk), params.center.plus(half));
    if (!bid.gt(0) || !ask.gt(bid)) return this.cancel(state, "quote would cross or be invalid");
    const inventory = d(state.inventory), maxInventory = d(risk.maxInventory);
    const bidCapacity = Decimal.max(0, maxInventory.minus(inventory));
    const askCapacity = Decimal.max(0, maxInventory.plus(inventory));
    const quotes: Offer[] = [];
    if (bidCapacity.gt(0) && params.bidSize.gt(0)) quotes.push(this.offer(market, risk, "buy", bid, Decimal.min(params.bidSize, bidCapacity)));
    if (askCapacity.gt(0) && params.askSize.gt(0)) quotes.push(this.offer(market, risk, "sell", ask, Decimal.min(params.askSize, askCapacity)));
    state.lastDecision = { assessment: context.assessment, quotes: structuredClone(quotes), reason: params.reason };
    return quotes;
  }
  protected cancel(state: StrategyState, reason: string) { state.lastDecision = { assessment: null, quotes: [], reason }; return []; }
  private offer(market: MarketEvent, risk: StrategyContext["risk"], side: Side, price: Decimal, size: Decimal): Offer {
    const queueLevels = side === "buy" ? market.bids.filter((item) => d(item.price).gte(price)) : market.asks.filter((item) => d(item.price).lte(price));
    const visibleAhead = queueLevels.reduce((sum, item) => sum.plus(item.baseVolume), new Decimal(0));
    return { id: `${this.id}:${market.ledgerIndex}:${side}`, side, price: price.toString(), remaining: size.toString(), queueRemaining: d(risk.queueAheadBase).plus(visibleAhead.times(risk.queueAheadFraction)).toString(), placedLedger: market.ledgerIndex, eligibleLedger: market.ledgerIndex + 1, expiresLedger: market.ledgerIndex + 1 + config.offerLifetimeLedgers };
  }
}

export class DeterministicBaseline extends PassiveStrategy {
  readonly id = "baseline" as const;
  protected parameters({ market, risk, history }: StrategyContext): QuoteParameters {
    const mids = history.slice(-20).map((point) => d(point.mid));
    const center = mid(market), range = mids.length > 1 ? Decimal.max(...mids).minus(Decimal.min(...mids)) : new Decimal(0);
    const rangeBps = center.gt(0) ? range.div(center).times(10_000) : new Decimal(0);
    const widen = Decimal.min(2, new Decimal(1).plus(rangeBps.div(100)));
    return { center, spreadBps: d(risk.spreadBps).times(widen), bidSize: d(risk.quoteSize), askSize: d(risk.quoteSize), reason: `deterministic baseline; history range ${rangeBps.toFixed(2)} bps` };
  }
}
export class JevSkewedBaseline extends PassiveStrategy {
  readonly id = "jev" as const;
  protected parameters({ market, risk, assessment, history }: StrategyContext): QuoteParameters | null {
    if (!assessment || assessment.toxicity === "high" || assessment.volatility === "extreme") return null;
    const sign = assessment.direction === "bullish" ? 1 : assessment.direction === "bearish" ? -1 : 0;
    const skewBps = d(assessment.confidence).times(sign).times(Decimal.min(d(risk.spreadBps).div(2), 20));
    const center = mid(market).times(new Decimal(1).plus(skewBps.div(10_000)));
    const factor = assessment.direction === "bullish" ? new Decimal(1).plus(assessment.confidence) : assessment.direction === "bearish" ? new Decimal(1).minus(d(assessment.confidence).times(0.5)) : new Decimal(1);
    const mids = history.slice(-20).map((point) => d(point.mid));
    const range = mids.length > 1 ? Decimal.max(...mids).minus(Decimal.min(...mids)) : new Decimal(0);
    const historyBps = mid(market).gt(0) ? range.div(mid(market)).times(10_000) : new Decimal(0);
    const volatilityFactor = assessment.volatility === "normal" ? new Decimal("1.25") : new Decimal(1);
    return { center, spreadBps: d(risk.spreadBps).times(volatilityFactor).times(Decimal.min(2, new Decimal(1).plus(historyBps.div(100)))), bidSize: d(risk.quoteSize).times(assessment.direction === "bullish" ? factor : 1), askSize: d(risk.quoteSize).times(assessment.direction === "bearish" ? factor : 1), reason: `Jev ${assessment.direction}/${assessment.toxicity}/${assessment.volatility} confidence ${assessment.confidence.toFixed(2)}; history range ${historyBps.toFixed(2)} bps` };
  }
}
export class StaticPassiveControl extends PassiveStrategy {
  readonly id = "control" as const;
  protected parameters({ market, risk }: StrategyContext): QuoteParameters { return { center: mid(market), spreadBps: d(risk.spreadBps).times(2), bidSize: d(risk.quoteSize).times("0.5"), askSize: d(risk.quoteSize).times("0.5"), reason: "static passive control; double spread and half size" }; }
}
export const createStrategies = (): Strategy[] => [new DeterministicBaseline(), new JevSkewedBaseline(), new StaticPassiveControl()];
function mid(event: MarketEvent) { return d(event.bids[0]!.price).plus(event.asks[0]!.price).div(2); }
function d(value: string | number) { return new Decimal(value); }
