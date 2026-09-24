export const EVENT_VERSION = 1 as const;
export type Side = "buy" | "sell";
export type Direction = "bullish" | "bearish" | "neutral";
export type Toxicity = "low" | "medium" | "high";
export type Volatility = "calm" | "normal" | "extreme";

export interface Currency { currency: string; issuer?: string }
export interface BookLevel { price: number; baseVolume: number }
export interface ExecutableTrade { side: Side; price: number; baseVolume: number; sourceTx: string }
export interface MarketEvent {
  schemaVersion: typeof EVENT_VERSION;
  eventId: string;
  type: "market";
  timestamp: number;
  ledgerIndex: number;
  ledgerHash: string;
  base: Currency;
  quote: Currency;
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  executions: readonly ExecutableTrade[];
  source: "testnet" | "synthetic" | "replay";
  syntheticSeed?: string;
}

export interface JevAssessment { direction: Direction; toxicity: Toxicity; volatility: Volatility; confidence: number; latencyMs: number; inputTokens: number }
export interface Offer { id: string; side: Side; price: number; remaining: number; queueRemaining: number; placedLedger: number; eligibleLedger: number }
export interface RiskState { stopped: boolean; dailyRealizedLoss: number; reason: string | null; day: string }
export interface StrategyState {
  offers: Offer[];
  inventory: number;
  averageEntryPrice: number;
  realizedPnl: number;
  xrplFeesXrp: number;
  jevCostUsd: number;
  risk: RiskState;
  decisions: number;
  fills: number;
  lastDecision: { assessment: JevAssessment | null; quotes: Offer[]; reason: string };
}
export type StrategyId = "baseline" | "jev" | "control";
export interface StrategySnapshot { id: StrategyId; state: StrategyState; unrealizedPnl: number; totalPnl: number }
export interface CycleEvent {
  schemaVersion: typeof EVENT_VERSION;
  eventId: string;
  type: "cycle";
  timestamp: number;
  market: MarketEvent;
  strategies: Record<StrategyId, StrategySnapshot>;
  fills: Array<{ strategy: StrategyId; side: Side; price: number; baseVolume: number; ledgerIndex: number }>;
  emergencyStop: boolean;
  modeledCosts: { xrplFeeDrops: number; jevUsd: number };
}
export interface ControlEvent { schemaVersion: typeof EVENT_VERSION; eventId: string; type: "control"; timestamp: number; action: "stop" | "reset-stop" | "cancel-all"; emergencyStop: boolean; strategies: Record<StrategyId, StrategyState> }
export interface Checkpoint {
  schemaVersion: typeof EVENT_VERSION;
  lastEventId: string | null;
  lastLedgerIndex: number;
  lastMid: number;
  emergencyStop: boolean;
  strategies: Record<StrategyId, StrategyState>;
}
export interface SessionMeta { schemaVersion: typeof EVENT_VERSION; sessionId: string; startedAt: number; source: string; seed?: string; base: Currency; quote: Currency; assumptions: { spreadBps: number; quoteSize: number; maxInventory: number; maxDailyLoss: number; queueAheadBase: number; queueAheadFraction: number; modeledXrplFeeDrops: number; jevUsdPerMTok: number; model: string; jevModelId: string } }

export interface StrategyContext {
  market: MarketEvent;
  assessment: JevAssessment | null;
  state: StrategyState;
  risk: { maxInventory: number; maxDailyLoss: number; quoteSize: number; spreadBps: number; queueAheadBase: number; queueAheadFraction: number; modeledXrplFeeDrops: number };
  emergencyStop: boolean;
}
