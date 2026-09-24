export type Side = "buy" | "sell";
export interface Currency { currency: string; issuer?: string }
export interface Offer { id: string; side: Side; price: number; remaining: number; queueRemaining: number; eligibleLedger: number }
export interface StrategyState { offers: Offer[]; inventory: number; realizedPnl: number; xrplFeesXrp: number; jevCostUsd: number; fills: number; risk: { stopped: boolean }; lastDecision: { reason: string; assessment: null | { direction: string; toxicity: string; volatility: string; confidence: number } } }
export interface StrategySnapshot { state: StrategyState; totalPnl: number; unrealizedPnl: number }
export interface MarketEvent { source: string; ledgerIndex: number; ledgerHash: string; base: Currency; quote: Currency; bids: Array<{ price: number; baseVolume: number }>; asks: Array<{ price: number; baseVolume: number }>; executions: Array<{ side: Side; price: number; baseVolume: number }> }
export interface CycleEvent { schemaVersion: number; eventId: string; type: "cycle"; timestamp: number; market: MarketEvent; strategies: Record<"baseline" | "jev" | "control", StrategySnapshot>; emergencyStop: boolean }
export interface FeedState { events: CycleEvent[]; connection: "connecting" | "live" | "reconnecting"; marketConnection: "connecting" | "live" | "stale" }
