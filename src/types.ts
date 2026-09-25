export const EVENT_VERSION = 6 as const;
export type Side = "buy" | "sell";
export type Direction = "bullish" | "bearish" | "neutral";
export type Toxicity = "low" | "medium" | "high";
export type Volatility = "calm" | "normal" | "extreme";

export interface Currency { currency: string; issuer?: string }
export type Amount = string;
export interface BookLevel { price: Amount; baseVolume: Amount }
export interface ExecutableTrade { side: Side; price: Amount; baseVolume: Amount; sourceTx: string }
export interface UnsupportedExecution { sourceTx: string; transactionType: string; reason: string }
export interface MarketEvent {
  schemaVersion: typeof EVENT_VERSION;
  eventId: string;
  type: "market";
  timestamp: number;
  receivedAt?: number;
  ledgerCloseTimestamp?: number;
  ledgerIndex: number;
  ledgerHash: string;
  base: Currency;
  quote: Currency;
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  executions: readonly ExecutableTrade[];
  unsupportedExecutions: readonly UnsupportedExecution[];
  source: "testnet" | "mainnet" | "synthetic" | "replay";
  replayMarker?: boolean;
  recordedProvenance?: { source: "mainnet" | "testnet"; network: "mainnet" | "testnet"; eventId: string; ledgerIndex: number; ledgerHash: string; receivedAt?: number };
  syntheticSeed?: string;
}
export interface MarketHistoryPoint { ledgerIndex: number; mid: Amount; buyFlow: Amount; sellFlow: Amount; spreadBps: Amount }

export interface JevAssessment { direction: Direction; toxicity: Toxicity; volatility: Volatility; confidence: number; latencyMs: number; inputTokens: number }
export interface Offer { id: string; side: Side; price: Amount; remaining: Amount; queueRemaining: Amount; placedLedger: number; eligibleLedger: number; expiresLedger?: number }
export interface RiskState { stopped: boolean; dailyRealizedLoss: Amount; reason: string | null; day: string }
export interface StrategyState {
  offers: Offer[];
  inventory: Amount;
  averageEntryPrice: Amount;
  realizedPnl: Amount;
  xrplFeeDrops: Amount;
  modeledOfferCreates: number;
  modeledOfferCancels: number;
  jevCostUsd: Amount;
  jevCalls: number;
  jevTimeouts: number;
  jevFailures: number;
  jevLatencyTotalMs: number;
  jevInputTokens: number;
  jevAbstentions: Record<string, number>;
  peakLongInventory: Amount;
  peakShortInventory: Amount;
  timeHoldingXrpMs: number;
  xrpExposureMs: Amount;
  lastInventoryTimestamp: number | null;
  analyticsStartedAt: number | null;
  quoteCreateCount: number;
  quoteReplacementCount: number;
  quoteCancellationCount: number;
  quoteTurnoverBaseXrp: Amount;
  quoteTurnoverQuote: Amount;
  risk: RiskState;
  decisions: number;
  fills: number;
  lastDecision: { assessment: JevAssessment | null; quotes: Offer[]; reason: string };
}
export type StrategyId = "baseline" | "jev" | "control";
export interface StrategySnapshot { id: StrategyId; state: StrategyState; unrealizedPnl: Amount; totalPnl: Amount }
export interface CycleEvent {
  schemaVersion: typeof EVENT_VERSION;
  eventId: string;
  type: "cycle";
  timestamp: number;
  market: MarketEvent;
  eligibleDirectOfferVolume: { buy: Amount; sell: Amount; total: Amount };
  strategies: Record<StrategyId, StrategySnapshot>;
  fills: Array<{ strategy: StrategyId; side: Side; price: Amount; baseVolume: Amount; ledgerIndex: number; sourceTx: string; executionPrice: Amount; queueVolumeConsumed: Amount; qualification: string }>;
  emergencyStop: boolean;
  modeledCosts: { xrplFeeDrops: Amount; jevUsd: Amount };
}
export interface ControlEvent { schemaVersion: typeof EVENT_VERSION; eventId: string; type: "control"; timestamp: number; action: "stop" | "reset-stop" | "cancel-all"; emergencyStop: boolean; strategies: Record<StrategyId, StrategyState> }
export interface Checkpoint {
  schemaVersion: typeof EVENT_VERSION;
  lastEventId: string | null;
  lastLedgerIndex: number;
  lastMid: Amount;
  recentMarkets?: MarketEvent[];
  emergencyStop: boolean;
  strategies: Record<StrategyId, StrategyState>;
}
export interface SessionMeta { schemaVersion: typeof EVENT_VERSION; sessionId: string; startedAt: number; source: string; network?: "testnet" | "mainnet"; seed?: string; replayHash?: string; replayIntervalMs?: number; base: Currency; quote: Currency; assumptions: { spreadBps: Amount; quoteSize: Amount; maxInventory: Amount; maxDailyLoss: Amount; queueAheadBase: Amount; queueAheadFraction: number; offerLifetimeLedgers?: number; modeledXrplFeeDrops: Amount; jevUsdPerMTok: Amount; usdToQuoteRate: Amount; model: string; jevModelId: string } }

export interface StrategyContext {
  market: MarketEvent;
  history: readonly MarketHistoryPoint[];
  assessment: JevAssessment | null;
  state: StrategyState;
  risk: { maxInventory: Amount; maxDailyLoss: Amount; quoteSize: Amount; spreadBps: Amount; queueAheadBase: Amount; queueAheadFraction: number; modeledXrplFeeDrops: Amount };
  emergencyStop: boolean;
}
