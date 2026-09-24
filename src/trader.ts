import { randomUUID } from "node:crypto";
import { config } from "./config";
import type { DecisionModel } from "./model";
import { withTimeout } from "./model";
import { DeterministicRiskPolicy } from "./risk";
import { createStrategies } from "./strategy";
import { AuditStore, initialStrategies, STRATEGY_IDS } from "./storage";
import type { Checkpoint, ControlEvent, CycleEvent, MarketEvent, StrategyId, StrategySnapshot, StrategyState } from "./types";
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
  private lastMid = 0;
  private lastMarketReceivedAt = 0;
  private accepted = 0;
  private shutdown = false;

  constructor(private readonly model: DecisionModel, private readonly store: AuditStore, private readonly publish: (event: CycleEvent | ControlEvent) => void = () => {}) {
    const recovered = store.recover();
    if (recovered) {
      this.states = structuredClone(recovered.strategies);
      this.emergencyStop = recovered.emergencyStop;
      this.lastLedgerIndex = recovered.lastLedgerIndex;
      this.lastMid = recovered.lastMid ?? 0;
      this.lastEventId = recovered.lastEventId;
    }
  }
  get status() { return { mode: "paper", network: "testnet", source: config.source, running: !this.shutdown, marketConnection: this.lastMarketReceivedAt && Date.now() - this.lastMarketReceivedAt <= 15_000 ? "live" : this.lastLedgerIndex ? "stale" : "connecting", emergencyStop: this.emergencyStop, lastLedgerIndex: this.lastLedgerIndex, lastEventId: this.lastEventId, mid: this.lastMid, quoteCurrency: config.quote.currency, strategies: this.snapshots(), market: `${assetName(config.base)}/${assetName(config.quote)}` }; }
  get report() { return { ...this.status, quoteCurrency: config.quote.currency, queueAssumptions: { fixedBaseUnits: config.queueAheadBase, displayedDepthFraction: config.queueAheadFraction }, syntheticSeed: config.source === "synthetic" ? config.seed : undefined, strategies: this.snapshots().map((s) => ({ id: s.id, inventory: s.state.inventory, openOffers: s.state.offers.length, realizedPnl: s.state.realizedPnl, unrealizedPnl: s.unrealizedPnl, totalPnl: s.totalPnl, modeledXrplFeesXrp: s.state.xrplFeesXrp, jevInferenceCostUsd: s.state.jevCostUsd, dailyLoss: s.state.risk.dailyRealizedLoss, riskStopped: s.state.risk.stopped, decisions: s.state.decisions, fills: s.state.fills })) }; }
  get isShutdown() { return this.shutdown; }

  async onMarket(market: MarketEvent) {
    if (this.shutdown || !this.isValidEvent(market) || market.ledgerIndex <= this.lastLedgerIndex) return;
    this.lastMarketReceivedAt = Date.now();
    let assessment = null;
    let jevCostUsd = 0;
    let jevTimedOut = false;
    try {
      assessment = await withTimeout(this.model.assess(market), config.jevTimeoutMs);
      jevCostUsd = assessment.inputTokens / 1_000_000 * config.jevUsdPerMTok;
    } catch (error) {
      jevTimedOut = true;
      if (config.model === "jev") jevCostUsd = Math.ceil(JSON.stringify({ base: market.base, quote: market.quote, bids: market.bids.slice(0, 10), asks: market.asks.slice(0, 10), executions: market.executions.slice(-25) }).length / 4) / 1_000_000 * config.jevUsdPerMTok;
      console.warn(`ledger ${market.ledgerIndex}: Jev assessment unavailable; Jev strategy withholds quotes (${(error as Error).message})`);
    }

    const fills: CycleEvent["fills"] = [];
    const xrplFeeDrops = config.modeledXrplFeeDrops;
    const marketMid = ((market.bids[0]?.price ?? 0) + (market.asks[0]?.price ?? 0)) / 2;
    for (const strategy of this.strategies) {
      const state = this.states[strategy.id];
      this.risk.update(state, market, { maxInventory: config.maxInventory, maxDailyLoss: config.maxDailyLoss, quoteSize: config.quoteSize });
      for (const fill of this.executor.applyLedger(strategy.id, state, market, config.maxInventory)) fills.push(fill);
      this.risk.update(state, market, { maxInventory: config.maxInventory, maxDailyLoss: config.maxDailyLoss, quoteSize: config.quoteSize });
      state.decisions++;
      if (strategy.id === "jev") state.jevCostUsd += jevCostUsd;
      const strategyAssessment = strategy.id === "jev" && !jevTimedOut ? assessment : null;
      const quotes = strategy.decide({ market, assessment: strategyAssessment, state, risk: { maxInventory: config.maxInventory, maxDailyLoss: config.maxDailyLoss, quoteSize: config.quoteSize, spreadBps: config.spreadBps, queueAheadBase: config.queueAheadBase, queueAheadFraction: config.queueAheadFraction, modeledXrplFeeDrops: xrplFeeDrops }, emergencyStop: this.emergencyStop });
      const checked = state.risk.stopped || this.emergencyStop ? [] : this.risk.validate(quotes, state, market, { maxInventory: config.maxInventory, maxDailyLoss: config.maxDailyLoss, quoteSize: config.quoteSize * 2 });
      if (checked.length !== quotes.length) state.lastDecision.reason = "deterministic risk policy rejected quote";
      const fee = this.executor.place(state, checked, xrplFeeDrops);
      if (strategy.id === "jev" && checked.length) state.jevCostUsd += 0;
      void fee;
    }
    const eventId = `cycle:${market.eventId}`;
    this.lastMid = marketMid;
    const event: CycleEvent = {
      schemaVersion: EVENT_VERSION, eventId, type: "cycle", timestamp: market.timestamp, market,
      strategies: Object.fromEntries(STRATEGY_IDS.map((id) => [id, snapshot(id, this.states[id], marketMid)])) as CycleEvent["strategies"],
      fills, emergencyStop: this.emergencyStop, modeledCosts: { xrplFeeDrops, jevUsd: jevCostUsd },
    };
    this.store.append(event);
    this.history.push(event);
    if (this.history.length > config.dataHistory) this.history.shift();
    this.lastLedgerIndex = market.ledgerIndex; this.lastEventId = eventId; this.accepted++;
    if (this.accepted % config.checkpointEveryLedgers === 0) this.writeCheckpoint();
    this.publish(event);
  }

  control(action: ControlEvent["action"]) {
    if (action === "stop") { this.emergencyStop = true; for (const state of Object.values(this.states)) { state.offers = []; state.lastDecision = { assessment: null, quotes: [], reason: "persistent emergency stop" }; } }
    if (action === "reset-stop") this.emergencyStop = false;
    if (action === "cancel-all") for (const state of Object.values(this.states)) state.offers = [];
    const event: ControlEvent = { schemaVersion: EVENT_VERSION, eventId: `control:${randomUUID()}`, type: "control", timestamp: Date.now(), action, emergencyStop: this.emergencyStop, strategies: structuredClone(this.states) };
    this.store.append(event); this.lastEventId = event.eventId; this.writeCheckpoint(); this.publish(event);
    return { ok: true, action, emergencyStop: this.emergencyStop };
  }

  requestShutdown() { this.shutdown = true; }
  get resumeLedger() { return this.lastLedgerIndex; }
  private writeCheckpoint() { this.store.checkpoint({ schemaVersion: EVENT_VERSION, lastEventId: this.lastEventId, lastLedgerIndex: this.lastLedgerIndex, lastMid: this.lastMid, emergencyStop: this.emergencyStop, strategies: structuredClone(this.states) }); }
  private snapshots(): StrategySnapshot[] { return this.strategies.map((strategy) => snapshot(strategy.id, this.states[strategy.id], this.lastMid)); }
  private isValidEvent(event: MarketEvent) {
    const same = (a: typeof config.base, b: MarketEvent["base"]) => a.currency.toUpperCase() === b.currency.toUpperCase() && a.issuer === b.issuer;
    const validLevels = (levels: MarketEvent["bids"], side: "bid" | "ask") => levels.length > 0 && levels.every((level, index) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.baseVolume) && level.baseVolume > 0 && (index === 0 || (side === "bid" ? levels[index - 1]!.price >= level.price : levels[index - 1]!.price <= level.price)));
    const stale = event.source === "testnet" && Date.now() - event.timestamp > 15_000;
    return event.schemaVersion === EVENT_VERSION && event.type === "market" && !stale && Number.isFinite(event.timestamp) && event.ledgerIndex > 0 && event.ledgerHash.length > 0 && same(config.base, event.base) && same(config.quote, event.quote) && validLevels(event.bids, "bid") && validLevels(event.asks, "ask") && event.bids[0]!.price < event.asks[0]!.price && event.executions.every((e) => Number.isFinite(e.price) && e.price > 0 && Number.isFinite(e.baseVolume) && e.baseVolume > 0);
  }
}

function snapshot(id: StrategyId, state: StrategyState, mid: number): StrategySnapshot {
  const unrealizedPnl = state.inventory * (mid - state.averageEntryPrice);
  return { id, state: structuredClone(state), unrealizedPnl, totalPnl: state.realizedPnl + unrealizedPnl };
}
function assetName(asset: { currency: string; issuer?: string }) { return asset.issuer ? `${asset.currency}.${asset.issuer}` : asset.currency; }
