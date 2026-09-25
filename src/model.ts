import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";
import type { JevAssessment, MarketEvent, MarketHistoryPoint } from "./types";

export interface DecisionModel { assess(event: MarketEvent, history?: readonly MarketHistoryPoint[]): Promise<JevAssessment> }

export class JevAssessmentValidationError extends Error {
  constructor(message: string) { super(message); this.name = "JevAssessmentValidationError"; }
}

export class JevTimeoutError extends Error {
  constructor() { super("Jev assessment timed out"); this.name = "JevTimeoutError"; }
}

/** TypeSafe AI exposes its calibrated confidence separately from the choice probabilities. */
export function requireDirectionConfidence(result: unknown): number {
  const confidence = (result as any)?.providerMetadata?.typesafe?.confidence?.direction;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new JevAssessmentValidationError("Jev returned missing or invalid direction confidence");
  }
  return confidence;
}

const QUESTIONS = {
  direction: { type: "choice", instructions: { question: "Over the next several validated ledgers, is price direction bullish, bearish, or neutral?", goal: "Classify direction only for passive quoting. Do not propose a transaction, price, or size.", inputs: "Use the exact configured XRP/issued-currency pair, book imbalance, spread, validated direct offer executions, and current book levels." }, criteria: { bullish: "Evidence favors a higher midpoint.", bearish: "Evidence favors a lower midpoint.", neutral: "Evidence does not favor either direction." } },
  toxicity: { type: "choice", instructions: { question: "How toxic is this market for a passive quote?", goal: "High toxicity means market makers should withdraw.", inputs: "Consider spread, book depth, and validated direct-offer execution flow." }, criteria: { low: "Conditions appear orderly.", medium: "Conditions are mixed or less stable.", high: "Adverse selection risk appears elevated." } },
  volatility: { type: "choice", instructions: { question: "Is current volatility calm, normal, or extreme?", goal: "Classify current market volatility for passive quote sizing.", inputs: "Compare the spread and recent price movement in the provided snapshot." }, criteria: { calm: "Price movement is subdued.", normal: "Price movement is ordinary.", extreme: "Price movement is unusually large or unstable." } },
} as const;

export class JevModel implements DecisionModel {
  private readonly model = typeSafeAi.evaluationModel(config.jevModelId);
  async assess(event: MarketEvent, history: readonly MarketHistoryPoint[] = []): Promise<JevAssessment> {
    const started = performance.now();
    const result = await experimental_evaluate({
      model: this.model,
      state: {
        ledger: event.ledgerIndex,
        base: event.base,
        quote: event.quote,
        bids: event.bids.slice(0, 10),
        asks: event.asks.slice(0, 10),
        spreadBps: spreadBps(event),
        validatedExecutions: event.executions.slice(-25),
        recentHistory: history.slice(-50),
      } as any,
      questions: QUESTIONS as any,
      maxRetries: 0,
    });
    const direction = (result.answers.direction as any)?.choice;
    const toxicity = (result.answers.toxicity as any)?.choice;
    const volatility = (result.answers.volatility as any)?.choice;
    const confidence = requireDirectionConfidence(result);
    if (!["bullish", "bearish", "neutral"].includes(direction) || !["low", "medium", "high"].includes(toxicity) || !["calm", "normal", "extreme"].includes(volatility)) throw new JevAssessmentValidationError("Jev returned an invalid typed assessment");
    return { direction, toxicity, volatility, confidence, latencyMs: performance.now() - started, inputTokens: result.usage?.inputTokens ?? 0 };
  }
}

/** Deterministic local stand-in; seed is recorded in events, not used to add hidden strategy noise. */
export class MockModel implements DecisionModel {
  async assess(event: MarketEvent, history: readonly MarketHistoryPoint[] = []): Promise<JevAssessment> {
    const first = Number(event.bids[0]?.price ?? event.asks[0]?.price ?? 0);
    const last = Number(event.asks[0]?.price ?? first);
    const mid = (first + last) / 2;
    const prior = Number(event.bids[0]?.baseVolume ?? 0);
    const ask = Number(event.asks[0]?.baseVolume ?? 0);
    const imbalance = prior + ask ? (prior - ask) / (prior + ask) : 0;
    const netFlow = event.executions.reduce((sum, t) => sum + (t.side === "buy" ? Number(t.baseVolume) : -Number(t.baseVolume)), 0);
    const recent = history.slice(-20);
    const recentReturn = recent.length > 1 ? (Number(recent.at(-1)!.mid) - Number(recent[0]!.mid)) / Number(recent[0]!.mid) : 0;
    const signal = imbalance + (mid ? netFlow / Math.max(prior + ask, 1e-9) : 0) + recentReturn * 10;
    const spread = spreadBps(event);
    return {
      direction: signal > 0.12 ? "bullish" : signal < -0.12 ? "bearish" : "neutral",
      toxicity: spread > Number(config.spreadBps) * 3 ? "high" : spread > Number(config.spreadBps) * 1.5 ? "medium" : "low",
      volatility: spread > Number(config.spreadBps) * 3 || Math.abs(recentReturn) > 0.01 ? "extreme" : spread > Number(config.spreadBps) || Math.abs(recentReturn) > 0.002 ? "normal" : "calm",
      confidence: Math.min(1, Math.abs(signal)), latencyMs: 0, inputTokens: 0,
    };
  }
}

export function createModel(): DecisionModel { return config.model === "jev" ? new JevModel() : new MockModel(); }
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new JevTimeoutError()), timeoutMs))]);
}
function spreadBps(event: MarketEvent) { const bid = Number(event.bids[0]?.price), ask = Number(event.asks[0]?.price); const mid = bid && ask ? (bid + ask) / 2 : 0; return mid ? ((ask - bid) / mid) * 10_000 : Infinity; }
