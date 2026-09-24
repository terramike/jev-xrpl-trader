import { Decimal } from "./decimal";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Checkpoint, ControlEvent, CycleEvent, SessionMeta, StrategyId, StrategyState } from "./types";
import { EVENT_VERSION } from "./types";

export type AuditEvent = CycleEvent | ControlEvent;
export const STRATEGY_IDS: StrategyId[] = ["baseline", "jev", "control"];
export function initialStrategyState(): StrategyState { return { offers: [], inventory: "0", averageEntryPrice: "0", realizedPnl: "0", xrplFeeDrops: "0", modeledOfferCreates: 0, modeledOfferCancels: 0, jevCostUsd: "0", jevCalls: 0, jevTimeouts: 0, jevLatencyTotalMs: 0, jevInputTokens: 0, risk: { stopped: false, dailyRealizedLoss: "0", reason: null, day: "" }, decisions: 0, fills: 0, lastDecision: { assessment: null, quotes: [], reason: "starting" } }; }
export function initialStrategies(): Record<StrategyId, StrategyState> { return { baseline: initialStrategyState(), jev: initialStrategyState(), control: initialStrategyState() }; }

export class AuditStore {
  readonly auditPath: string;
  readonly checkpointPath: string;
  readonly sessionPath: string;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.auditPath = join(dataDir, "audit.jsonl");
    this.checkpointPath = join(dataDir, "checkpoint.json");
    this.sessionPath = join(dataDir, "session.json");
  }
  append(event: AuditEvent) { appendFileSync(this.auditPath, JSON.stringify(event) + "\n", "utf8"); }
  loadSession(): SessionMeta | null { if (!existsSync(this.sessionPath)) return null; try { return JSON.parse(readFileSync(this.sessionPath, "utf8")); } catch { return null; } }
  saveSession(session: SessionMeta) { atomicWrite(this.sessionPath, JSON.stringify(session, null, 2)); }
  recover(): Checkpoint | null {
    let state: Checkpoint | null = null;
    let checkpointProblem: string | null = null;
    if (existsSync(this.checkpointPath)) {
      try {
        const cp = JSON.parse(readFileSync(this.checkpointPath, "utf8"));
        if (cp.schemaVersion !== EVENT_VERSION) checkpointProblem = `schema version ${String(cp.schemaVersion)} is incompatible with supported version ${EVENT_VERSION}`;
        else if (!cp.strategies || typeof cp.emergencyStop !== "boolean" || !Number.isInteger(cp.lastLedgerIndex)) checkpointProblem = "required state fields are missing or invalid";
        else state = cp;
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
    let afterCheckpoint = state === null;
    let recentMarkets = state?.recentMarkets ? [...state.recentMarkets] : [];
    for (let i = 0; i < events.length; i++) {
      let event: AuditEvent;
      try { event = JSON.parse(events[i]!); } catch { throw new Error(`Corrupt audit record at line ${i + 1}.`); }
      if (event.schemaVersion !== EVENT_VERSION) throw new Error(checkpointProblem ? `Checkpoint recovery failed (${checkpointProblem}); audit record at line ${i + 1} uses unsupported schema version ${event.schemaVersion}, so replay cannot safely proceed.` : `Unsupported audit schema version at line ${i + 1}.`);
      if (!afterCheckpoint) { if (event.eventId === state!.lastEventId) afterCheckpoint = true; continue; }
      if (event.type === "cycle") {
        recentMarkets.push(event.market);
        if (recentMarkets.length > 50) recentMarkets.shift();
        state = { schemaVersion: EVENT_VERSION, lastEventId: event.eventId, lastLedgerIndex: event.market.ledgerIndex, lastMid: new Decimal(event.market.bids[0]!.price).plus(event.market.asks[0]!.price).div(2).toString(), recentMarkets: structuredClone(recentMarkets), emergencyStop: event.emergencyStop, strategies: Object.fromEntries(STRATEGY_IDS.map((id) => [id, structuredClone(event.strategies[id]!.state)])) as Checkpoint["strategies"] };
      }
      else if (event.type === "control") state = { schemaVersion: EVENT_VERSION, lastEventId: event.eventId, lastLedgerIndex: state?.lastLedgerIndex ?? 0, lastMid: state?.lastMid ?? "0", recentMarkets: structuredClone(recentMarkets), emergencyStop: event.emergencyStop, strategies: structuredClone(event.strategies) };
    }
    if (state && !afterCheckpoint) throw new Error("Checkpoint event was not found in the audit log.");
    if (checkpointProblem) console.warn(`Checkpoint recovery: ${checkpointProblem}; the audit journal was validated and replayed from its beginning.`);
    return state;
  }
  checkpoint(state: Checkpoint) { atomicWrite(this.checkpointPath, JSON.stringify(state, null, 2)); }
}

function atomicWrite(path: string, contents: string) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, contents, "utf8");
  renameSync(temp, path);
}
