import { Decimal } from "./decimal";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Checkpoint, ControlEvent, CycleEvent, SessionMeta, StrategyId, StrategyState } from "./types";
import { EVENT_VERSION } from "./types";

export type AuditEvent = CycleEvent | ControlEvent;
export interface AuditSummary { ledgersProcessed: number; ledgerGapCount: number; lastLedgerIndex: number; eligibleDirectOfferVolume: { buy: string; sell: string; total: string }; unsupportedExecutionsByCategory: Record<string, number>; unsupportedExamplesByCategory: Record<string, Array<{ ledgerIndex: number; transactionHashRedacted: string }>>; fillsByStrategy: Record<StrategyId, number>; fillEvidence: Array<{ strategy: StrategyId; ledgerIndex: number; ledgerHash: string; sourceTx: string; side: string; price: string; executionPrice: string; baseVolume: string; queueVolumeConsumed: string; qualification: string }> }
export const STRATEGY_IDS: StrategyId[] = ["baseline", "jev", "control"];
export function initialStrategyState(): StrategyState { return { offers: [], inventory: "0", averageEntryPrice: "0", realizedPnl: "0", xrplFeeDrops: "0", modeledOfferCreates: 0, modeledOfferCancels: 0, jevCostUsd: "0", jevCalls: 0, jevTimeouts: 0, jevFailures: 0, jevLatencyTotalMs: 0, jevInputTokens: 0, jevAbstentions: {}, peakLongInventory: "0", peakShortInventory: "0", timeHoldingXrpMs: 0, xrpExposureMs: "0", lastInventoryTimestamp: null, analyticsStartedAt: null, quoteCreateCount: 0, quoteReplacementCount: 0, quoteCancellationCount: 0, quoteTurnoverBaseXrp: "0", quoteTurnoverQuote: "0", risk: { stopped: false, dailyRealizedLoss: "0", reason: null, day: "" }, decisions: 0, fills: 0, lastDecision: { assessment: null, quotes: [], reason: "starting" } }; }
export function initialStrategies(): Record<StrategyId, StrategyState> { return { baseline: initialStrategyState(), jev: initialStrategyState(), control: initialStrategyState() }; }

function normalizeStrategyState(value: StrategyState, resetAnalytics = false): StrategyState {
  const normalized = { ...initialStrategyState(), ...value, jevAbstentions: value.jevAbstentions ?? {}, risk: { ...initialStrategyState().risk, ...value.risk }, lastDecision: { ...initialStrategyState().lastDecision, ...value.lastDecision } };
  if (resetAnalytics) {
    const inventory = new Decimal(normalized.inventory);
    normalized.jevAbstentions = {};
    normalized.peakLongInventory = inventory.gt(0) ? inventory.toString() : "0";
    normalized.peakShortInventory = inventory.lt(0) ? inventory.abs().toString() : "0";
    normalized.timeHoldingXrpMs = 0; normalized.xrpExposureMs = "0"; normalized.lastInventoryTimestamp = null; normalized.analyticsStartedAt = null;
    normalized.quoteCreateCount = 0; normalized.quoteReplacementCount = 0; normalized.quoteCancellationCount = 0; normalized.quoteTurnoverBaseXrp = "0"; normalized.quoteTurnoverQuote = "0";
  }
  return normalized;
}
function normalizeStrategies(value: Record<StrategyId, StrategyState>, resetAnalytics = false): Record<StrategyId, StrategyState> { return Object.fromEntries(STRATEGY_IDS.map((id) => [id, normalizeStrategyState(value[id], resetAnalytics)])) as Record<StrategyId, StrategyState>; }

export function assertFreshMainnetDataDir(dataDir: string, source: "mainnet" | "replay" = "mainnet") {
  if (resolve(dataDir) === resolve("data")) throw new Error("Mainnet paper sessions require an explicitly selected fresh DATA_DIR, separate from the default Testnet data directory.");
  if (!existsSync(dataDir)) return;
  const entries = readdirSync(dataDir);
  if (!entries.length) return;
  let session: SessionMeta | null = null;
  try { session = JSON.parse(readFileSync(join(dataDir, "session.json"), "utf8")); } catch { /* A populated directory without a valid session cannot be treated as fresh. */ }
  if (session?.network === "mainnet" && session.source === source) return;
  throw new Error("Mainnet paper sessions require a fresh DATA_DIR. This directory already contains data from another or unidentified session; choose a new empty directory.");
}

export class AuditStore {
  readonly auditPath: string;
  readonly checkpointPath: string;
  readonly sessionPath: string;
  private summaryCache: AuditSummary | null = null;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.auditPath = join(dataDir, "audit.jsonl");
    this.checkpointPath = join(dataDir, "checkpoint.json");
    this.sessionPath = join(dataDir, "session.json");
  }
  append(event: AuditEvent) { appendFileSync(this.auditPath, JSON.stringify(event) + "\n", "utf8"); if (this.summaryCache && event.type === "cycle") addCycleToSummary(this.summaryCache, event); }
  summary(): AuditSummary {
    if (this.summaryCache) return this.summaryCache;
    const summary: AuditSummary = { ledgersProcessed: 0, ledgerGapCount: 0, lastLedgerIndex: 0, eligibleDirectOfferVolume: { buy: "0", sell: "0", total: "0" }, unsupportedExecutionsByCategory: {}, unsupportedExamplesByCategory: {}, fillsByStrategy: { baseline: 0, jev: 0, control: 0 }, fillEvidence: [] };
    if (existsSync(this.auditPath)) for (const [index, line] of readFileSync(this.auditPath, "utf8").split(/\r?\n/).filter(Boolean).entries()) {
      let event: AuditEvent; try { event = JSON.parse(line); } catch { throw new Error(`Corrupt audit record at line ${index + 1} while building report summary.`); }
      if (event.type === "cycle") addCycleToSummary(summary, event);
    }
    this.summaryCache = summary;
    return summary;
  }
  loadSession(): SessionMeta | null { if (!existsSync(this.sessionPath)) return null; try { return JSON.parse(readFileSync(this.sessionPath, "utf8")); } catch { return null; } }
  saveSession(session: SessionMeta) { atomicWrite(this.sessionPath, JSON.stringify(session, null, 2)); }
  recover(): Checkpoint | null {
    let state: Checkpoint | null = null;
    let checkpointProblem: string | null = null;
    if (existsSync(this.checkpointPath)) {
      try {
        const cp = JSON.parse(readFileSync(this.checkpointPath, "utf8"));
        if (![3, 4, 5, EVENT_VERSION].includes(cp.schemaVersion)) checkpointProblem = `schema version ${String(cp.schemaVersion)} is incompatible with supported versions 3, 4, 5, and ${EVENT_VERSION}`;
        else if (!cp.strategies || typeof cp.emergencyStop !== "boolean" || !Number.isInteger(cp.lastLedgerIndex)) checkpointProblem = "required state fields are missing or invalid";
        else state = { ...cp, schemaVersion: EVENT_VERSION, strategies: normalizeStrategies(cp.strategies, cp.schemaVersion < 5) };
      } catch (error) { checkpointProblem = `JSON is corrupt (${(error as Error).message})`; }
    }
    if (!existsSync(this.auditPath)) {
      if (checkpointProblem) throw new Error(`Checkpoint recovery failed: ${checkpointProblem}; no audit journal is available for replay.`);
      return state;
    }
    let journal = readFileSync(this.auditPath, "utf8");
    if (journal && !journal.endsWith("\n")) {
      const lastBreak = journal.lastIndexOf("\n") + 1;
      const tail = journal.slice(lastBreak);
      try { JSON.parse(tail); journal += "\n"; }
      catch { journal = journal.slice(0, lastBreak); }
      writeFileSync(this.auditPath, journal, "utf8");
    }
    const events = journal.split(/\r?\n/).filter(Boolean);
    let afterCheckpoint = state === null || !state.lastEventId;
    let recentMarkets = state?.recentMarkets ? [...state.recentMarkets] : [];
    for (let i = 0; i < events.length; i++) {
      let event: AuditEvent;
      try { event = JSON.parse(events[i]!); } catch { throw new Error(`Corrupt audit record at line ${i + 1}.`); }
      const eventVersion = (event as any).schemaVersion;
      if (![3, 4, 5, EVENT_VERSION].includes(eventVersion)) throw new Error(checkpointProblem ? `Checkpoint recovery failed (${checkpointProblem}); audit record at line ${i + 1} uses unsupported schema version ${eventVersion}, so replay cannot safely proceed.` : `Unsupported audit schema version at line ${i + 1}.`);
      if (!afterCheckpoint) { if (event.eventId === state!.lastEventId) afterCheckpoint = true; continue; }
      if (event.type === "cycle") {
        recentMarkets.push(event.market);
        if (recentMarkets.length > 50) recentMarkets.shift();
        state = { schemaVersion: EVENT_VERSION, lastEventId: event.eventId, lastLedgerIndex: event.market.ledgerIndex, lastMid: new Decimal(event.market.bids[0]!.price).plus(event.market.asks[0]!.price).div(2).toString(), recentMarkets: structuredClone(recentMarkets), emergencyStop: event.emergencyStop, strategies: Object.fromEntries(STRATEGY_IDS.map((id) => [id, normalizeStrategyState(event.strategies[id]!.state, eventVersion < 5)])) as Checkpoint["strategies"] };
      }
      else if (event.type === "control") state = { schemaVersion: EVENT_VERSION, lastEventId: event.eventId, lastLedgerIndex: state?.lastLedgerIndex ?? 0, lastMid: state?.lastMid ?? "0", recentMarkets: structuredClone(recentMarkets), emergencyStop: event.emergencyStop, strategies: normalizeStrategies(event.strategies, eventVersion < 5) };
    }
    if (state && !afterCheckpoint) throw new Error("Checkpoint event was not found in the audit log.");
    if (checkpointProblem) console.warn(`Checkpoint recovery: ${checkpointProblem}; the audit journal was validated and replayed from its beginning.`);
    return state;
  }
  checkpoint(state: Checkpoint) { atomicWrite(this.checkpointPath, JSON.stringify(state, null, 2)); }
}

function addCycleToSummary(summary: AuditSummary, event: CycleEvent) {
  summary.ledgersProcessed++;
  if (summary.lastLedgerIndex && event.market.ledgerIndex > summary.lastLedgerIndex + 1) summary.ledgerGapCount += event.market.ledgerIndex - summary.lastLedgerIndex - 1;
  summary.lastLedgerIndex = event.market.ledgerIndex;
  summary.eligibleDirectOfferVolume.buy = new Decimal(summary.eligibleDirectOfferVolume.buy).plus(event.eligibleDirectOfferVolume.buy).toString();
  summary.eligibleDirectOfferVolume.sell = new Decimal(summary.eligibleDirectOfferVolume.sell).plus(event.eligibleDirectOfferVolume.sell).toString();
  summary.eligibleDirectOfferVolume.total = new Decimal(summary.eligibleDirectOfferVolume.total).plus(event.eligibleDirectOfferVolume.total).toString();
  for (const item of event.market.unsupportedExecutions) {
    const category = `${item.transactionType}:${item.reason}`;
    summary.unsupportedExecutionsByCategory[category] = (summary.unsupportedExecutionsByCategory[category] ?? 0) + 1;
    const examples = summary.unsupportedExamplesByCategory[category] ??= [];
    if (examples.length < 3) examples.push({ ledgerIndex: event.market.ledgerIndex, transactionHashRedacted: redactHash(item.sourceTx) });
  }
  for (const fill of event.fills) {
    summary.fillsByStrategy[fill.strategy]++;
    summary.fillEvidence.push({ strategy: fill.strategy, ledgerIndex: fill.ledgerIndex, ledgerHash: event.market.ledgerHash, sourceTx: fill.sourceTx, side: fill.side, price: fill.price, executionPrice: fill.executionPrice, baseVolume: fill.baseVolume, queueVolumeConsumed: fill.queueVolumeConsumed, qualification: fill.qualification });
  }
}

function redactHash(hash: string) { return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash; }

function atomicWrite(path: string, contents: string) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, contents, "utf8");
  renameSync(temp, path);
}
