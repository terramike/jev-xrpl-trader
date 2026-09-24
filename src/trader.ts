import { randomUUID } from "node:crypto";
import { Decimal } from "./decimal";
import { config } from "./config";
import type { DecisionModel } from "./model";
import { withTimeout } from "./model";
import { DeterministicRiskPolicy } from "./risk";
import { createStrategies } from "./strategy";
import { AuditStore, initialStrategies, STRATEGY_IDS } from "./storage";
import type { Checkpoint, ControlEvent, CycleEvent, MarketEvent, MarketHistoryPoint, StrategyId, StrategySnapshot, StrategyState } from "./types";
import { EVENT_VERSION } from "./types";
import { PaperExecutor } from "./execution/paper";

export class Trader {
  readonly history: CycleEvent[] = [];
  private strategies = createStrategies();
  private states = initialStrategies();
  private executor = new PaperExecutor();
  private risk = new DeterministicRiskPolicy();
  private emergencyStop = false;
  private lastLedgerIndex = 0;
  private lastEventId: string | null = null;
  private lastMid = "0";
  private lastMarketReceivedAt = 0;
  private accepted = 0;
  private shutdown = false;
  private recentMarkets: MarketEvent[] = [];

  constructor(private readonly model: DecisionModel, private readonly store: AuditStore, private readonly publish: (event: CycleEvent | ControlEvent) => void = () => {}) {
    const recovered = store.recover();
    if (recovered) {
      this.states = structuredClone(recovered.strategies);
      this.emergencyStop = recovered.emergencyStop;
      this.lastLedgerIndex = recovered.lastLedgerIndex;
      this.lastMid = recovered.lastMid ?? "0";
      this.lastEventId = recovered.lastEventId;
      this.recentMarkets = recovered.recentMarkets ?? [];
    }
  }
  get status() { return { mode: "paper", network: config.network, source: config.source, running: !this.shutdown, marketConnection: this.lastMarketReceivedAt && Date.now() - this.lastMarketReceivedAt <= 15_000 ? "live" : this.lastLedgerIndex ? "stale" : "connecting", emergencyStop: this.emergencyStop, lastLedgerIndex: this.lastLedgerIndex, lastEventId: this.lastEventId, mid: this.lastMid, quoteCurrency: config.quote.currency, strategies: this.snapshots(), market: `${assetName(config.base)}/${assetName(config.quote)}` }; }
  get report() { return { ...this.status, quoteCurrency: config.quote.currency, queueAssumptions: { fixedBaseUnits: config.queueAheadBase, displayedDepthFraction: config.queueAheadFraction }, offerLifetimeLedgers: config.offerLifetimeLedgers, modeledFeeDropsPerCreateOrCancel: config.modeledXrplFeeDrops, syntheticSeed: config.source === "synthetic" ? config.seed : undefined, strategies: this.snapshots().map((s) => ({ id: s.id, inventory: s.state.inventory, openOffers: s.state.offers.length, realizedPnl: s.state.realizedPnl, unrealizedPnl: s.unrealizedPnl, totalPnl: s.totalPnl, modeledXrplFeesXrp: new Decimal(s.state.xrplFeeDrops).div(1_000_000).toString(), modeledXrplFeeDrops: s.state.xrplFeeDrops, modeledOfferCreates: s.state.modeledOfferCreates, modeledOfferCancels: s.state.modeledOfferCancels, jevInferenceCostUsd: s.state.jevCostUsd, jevCalls: s.state.jevCalls, jevTimeouts: s.state.jevTimeouts, jevMeanLatencyMs: s.state.jevCalls ? s.state.jevLatencyTotalMs / s.state.jevCalls : 0, jevInputTokens: s.state.jevInputTokens, dailyLoss: s.state.risk.dailyRealizedLoss, riskStopped: s.state.risk.stopped, decisions: s.state.decisions, fills: s.state.fills })) }; }
  get isShutdown() { return this.shutdown; }

  async onMarket(market: MarketEvent) {
    if (this.shutdown || !this.isValidEvent(market) || market.ledgerIndex <= this.lastLedgerIndex) return;
    this.lastMarketReceivedAt = Date.now();
    let assessment = null;
    let jevCostUsd = new Decimal(0);
    let jevTimedOut = false;
    const jevStartedAt = performance.now();
    try {
      const history = this.historyPoints();
      assessment = await withTimeout(this.model.assess(market, history), config.jevTimeoutMs);
      jevCostUsd = new Decimal(assessment.inputTokens).div(1_000_000).times(config.jevUsdPerMTok);
    } catch (error) {
      jevTimedOut = true;
      if (config.model === "jev") jevCostUsd = new Decimal(Math.ceil(JSON.stringify({ base: market.base, quote: market.quote, bids: market.bids.slice(0, 10), asks: market.asks.slice(0, 10), executions: market.executions.slice(-25), history: this.historyPoints() }).length / 4)).div(1_000_000).times(config.jevUsdPerMTok);
      console.warn(`ledger ${market.ledgerIndex}: Jev assessment unavailable; Jev strategy withholds quotes (${(error as Error).message})`);
    }

    const fills: CycleEvent["fills"] = [];
    const xrplFeeDrops = config.modeledXrplFeeDrops;
    const eligibleVolume = market.executions.reduce((total, execution) => {
      total[execution.side] = total[execution.side].plus(execution.baseVolume);
      return total;
    }, { buy: new Decimal(0), sell: new Decimal(0) });
    const marketMid = new Decimal(market.bids[0]?.price ?? 0).plus(market.asks[0]?.price ?? 0).div(2).toString();
    for (const strategy of this.strategies) {
      const state = this.states[strategy.id];
      this.risk.update(state, market, { maxInventory: config.maxInventory, maxDailyLoss: config.maxDailyLoss, quoteSize: config.quoteSize });
      for (const fill of this.executor.applyLedger(strategy.id, state, market, config.maxInventory, xrplFeeDrops)) fills.push(fill);
      this.risk.update(state, market, { maxInventory: config.maxInventory, maxDailyLoss: config.maxDailyLoss, quoteSize: config.quoteSize });
      state.decisions++;
      if (strategy.id === "jev") {
        state.jevCalls++;
        state.jevLatencyTotalMs += assessment?.latencyMs ?? performance.now() - jevStartedAt;
        if (jevTimedOut) state.jevTimeouts++;
        state.jevInputTokens += assessment?.inputTokens ?? 0;
        state.jevCostUsd = new Decimal(state.jevCostUsd).plus(jevCostUsd).toString();
      }
      const strategyAssessment = strategy.id === "jev" && !jevTimedOut ? assessment : null;
      const quotes = strategy.decide({ market, history: this.historyPoints(), assessment: strategyAssessment, state, risk: { maxInventory: config.maxInventory, maxDailyLoss: config.maxDailyLoss, quoteSize: config.quoteSize, spreadBps: config.spreadBps, queueAheadBase: config.queueAheadBase, queueAheadFraction: config.queueAheadFraction, modeledXrplFeeDrops: xrplFeeDrops }, emergencyStop: this.emergencyStop });
      const checked = state.risk.stopped || this.emergencyStop ? [] : this.risk.validate(quotes, state, market, { maxInventory: config.maxInventory, maxDailyLoss: config.maxDailyLoss, quoteSize: new Decimal(config.quoteSize).times(2).toString() });
      if (checked.length !== quotes.length) state.lastDecision.reason = "deterministic risk policy rejected quote";
      state.lastDecision.quotes = structuredClone(checked);
      const fee = this.executor.place(state, checked, xrplFeeDrops);
      if (strategy.id === "jev" && checked.length) state.jevCostUsd += 0;
      void fee;
    }
    const eventId = `cycle:${market.eventId}`;
    this.lastMid = marketMid;
    const event: CycleEvent = {
      schemaVersion: EVENT_VERSION, eventId, type: "cycle", timestamp: market.timestamp, market,
      eligibleDirectOfferVolume: { buy: eligibleVolume.buy.toString(), sell: eligibleVolume.sell.toString(), total: eligibleVolume.buy.plus(eligibleVolume.sell).toString() },
      strategies: Object.fromEntries(STRATEGY_IDS.map((id) => [id, snapshot(id, this.states[id], marketMid)])) as CycleEvent["strategies"],
      fills, emergencyStop: this.emergencyStop, modeledCosts: { xrplFeeDrops: String(xrplFeeDrops), jevUsd: jevCostUsd.toString() },
    };
    this.store.append(event);
    this.history.push(event);
    if (this.history.length > config.dataHistory) this.history.shift();
    this.recentMarkets.push(market);
    if (this.recentMarkets.length > 50) this.recentMarkets.shift();
    this.lastLedgerIndex = market.ledgerIndex; this.lastEventId = eventId; this.accepted++;
    if (this.accepted % config.checkpointEveryLedgers === 0) this.writeCheckpoint();
    this.publish(event);
  }

  control(action: ControlEvent["action"]) {
    if (action === "stop") { this.emergencyStop = true; for (const state of Object.values(this.states)) { this.executor.cancelAll(state, config.modeledXrplFeeDrops); state.lastDecision = { assessment: null, quotes: [], reason: "persistent emergency stop" }; } }
    if (action === "reset-stop") this.emergencyStop = false;
    if (action === "cancel-all") for (const state of Object.values(this.states)) this.executor.cancelAll(state, config.modeledXrplFeeDrops);
    const event: ControlEvent = { schemaVersion: EVENT_VERSION, eventId: `control:${randomUUID()}`, type: "control", timestamp: Date.now(), action, emergencyStop: this.emergencyStop, strategies: structuredClone(this.states) };
    this.store.append(event); this.lastEventId = event.eventId; this.writeCheckpoint(); this.publish(event);
    return { ok: true, action, emergencyStop: this.emergencyStop };
  }

  requestShutdown() { this.shutdown = true; }
  get resumeLedger() { return this.lastLedgerIndex; }
  private writeCheckpoint() { this.store.checkpoint({ schemaVersion: EVENT_VERSION, lastEventId: this.lastEventId, lastLedgerIndex: this.lastLedgerIndex, lastMid: this.lastMid, recentMarkets: structuredClone(this.recentMarkets), emergencyStop: this.emergencyStop, strategies: structuredClone(this.states) }); }
  private historyPoints(): MarketHistoryPoint[] {
    return this.recentMarkets.map((market) => {
      const bid = new Decimal(market.bids[0]!.price), ask = new Decimal(market.asks[0]!.price), mid = bid.plus(ask).div(2);
      return { ledgerIndex: market.ledgerIndex, mid: mid.toString(), buyFlow: market.executions.filter((trade) => trade.side === "buy").reduce((sum, trade) => sum.plus(trade.baseVolume), new Decimal(0)).toString(), sellFlow: market.executions.filter((trade) => trade.side === "sell").reduce((sum, trade) => sum.plus(trade.baseVolume), new Decimal(0)).toString(), spreadBps: ask.minus(bid).div(mid).times(10_000).toString() };
    });
  }
  private snapshots(): StrategySnapshot[] { return this.strategies.map((strategy) => snapshot(strategy.id, this.states[strategy.id], this.lastMid)); }
  private isValidEvent(event: MarketEvent) {
    const same = (a: typeof config.base, b: MarketEvent["base"]) => a.currency.toUpperCase() === b.currency.toUpperCase() && a.issuer === b.issuer;
    const validLevels = (levels: MarketEvent["bids"], side: "bid" | "ask") => levels.length > 0 && levels.every((level, index) => validPositive(level.price) && validPositive(level.baseVolume) && (index === 0 || (side === "bid" ? new Decimal(levels[index - 1]!.price).gte(level.price) : new Decimal(levels[index - 1]!.price).lte(level.price))));
    const stale = (event.source === "testnet" || event.source === "mainnet") && Date.now() - event.timestamp > 15_000;
    return event.schemaVersion === EVENT_VERSION && event.type === "market" && !stale && Number.isFinite(event.timestamp) && event.ledgerIndex > 0 && event.ledgerHash.length > 0 && same(config.base, event.base) && same(config.quote, event.quote) && validLevels(event.bids, "bid") && validLevels(event.asks, "ask") && new Decimal(event.bids[0]!.price).lt(event.asks[0]!.price) && event.executions.every((e) => validPositive(e.price) && validPositive(e.baseVolume));
  }
}

function snapshot(id: StrategyId, state: StrategyState, mid: string): StrategySnapshot {
  const unrealizedPnl = new Decimal(state.inventory).times(new Decimal(mid).minus(state.averageEntryPrice)).toString();
  return { id, state: structuredClone(state), unrealizedPnl, totalPnl: new Decimal(state.realizedPnl).plus(unrealizedPnl).toString() };
}
function assetName(asset: { currency: string; issuer?: string }) { return asset.issuer ? `${asset.currency}.${asset.issuer}` : asset.currency; }
function validPositive(value: string) { try { const d = new Decimal(value); return d.isFinite() && d.gt(0); } catch { return false; } }
