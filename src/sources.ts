import { readFileSync } from "node:fs";
import { Decimal } from "./decimal";
import { config } from "./config";
import type { MarketDataSource } from "./market";
import { EVENT_VERSION, type MarketEvent } from "./types";

export class SyntheticMarketDataSource implements MarketDataSource {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private state: number;
  private ledger = 0;
  private mid = new Decimal("0.5");
  constructor(private readonly seed: string, resumeLedger = 0) { this.state = hashSeed(seed) || 1; while (this.ledger < resumeLedger) this.advance(); }
  async start(callback: (event: MarketEvent) => Promise<void> | void) {
    const tick = async () => {
      if (this.stopped) return;
      const { spread, volume, executions } = this.advance();
      const event: MarketEvent = Object.freeze({
        schemaVersion: EVENT_VERSION, eventId: `synthetic:${this.seed}:${this.ledger}`, type: "market",
        timestamp: 1_700_000_000_000 + this.ledger * 4_000, ledgerIndex: this.ledger,
        ledgerHash: hashText(`${this.seed}:${this.ledger}`), base: Object.freeze({ ...config.base }), quote: Object.freeze({ ...config.quote }),
        bids: Object.freeze([{ price: this.mid.minus(spread.div(2)).toString(), baseVolume: volume.toString() }, { price: this.mid.minus(spread).toString(), baseVolume: volume.times("1.5").toString() }].map((level) => Object.freeze(level))),
        asks: Object.freeze([{ price: this.mid.plus(spread.div(2)).toString(), baseVolume: volume.toString() }, { price: this.mid.plus(spread).toString(), baseVolume: volume.times("1.5").toString() }].map((level) => Object.freeze(level))),
        executions: Object.freeze(executions.map((trade) => Object.freeze(trade))), unsupportedExecutions: Object.freeze([]), source: "synthetic", syntheticSeed: this.seed,
      });
      await callback(event);
      this.timer = setTimeout(() => void tick(), 4_000);
    };
    await tick();
  }
  private advance() {
    this.ledger++;
    const movePpm = Math.floor(this.random() * 6_000) - 3_000;
    this.mid = Decimal.max("0.005", this.mid.times(new Decimal(1).plus(new Decimal(movePpm).div(1_000_000))));
    const spread = this.mid.times("0.0015");
    const volume = new Decimal(10).plus(new Decimal(Math.floor(this.random() * 1_000_000)).div(1_000_000).times(15));
    const executions = this.ledger % 3 === 0 ? (() => { const side = this.random() > 0.5 ? "buy" as const : "sell" as const; return [{ side, price: this.mid.times(side === "buy" ? "1.005" : "0.995").toString(), baseVolume: new Decimal(20).plus(new Decimal(Math.floor(this.random() * 1_000_000)).div(1_000_000).times(40)).toString(), sourceTx: `synthetic:${this.seed}:${this.ledger}` }]; })() : [];
    return { spread, volume, executions };
  }
  private random() { this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0; return this.state / 0x1_0000_0000; }
  async close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}

export class ReplayMarketDataSource implements MarketDataSource {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly resumeLedger = 0, private readonly replayPath = config.replayPath!, private readonly intervalMs = config.replayIntervalMs, private readonly expectedNetwork: "mainnet" | "testnet" = config.network) {}
  async start(callback: (event: MarketEvent) => Promise<void> | void) {
    const events = readReplayMarketEvents(readFileSync(this.replayPath, "utf8"), this.expectedNetwork);
    let i = events.findIndex((event) => event.ledgerIndex > this.resumeLedger);
    if (i < 0) return;
    const tick = async () => {
      if (this.stopped || i >= events.length) return;
      await callback(events[i++]!);
      if (!this.stopped && i < events.length) this.timer = setTimeout(() => void tick(), this.intervalMs);
    };
    await tick();
  }
  async close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}

export function readReplayMarketEvents(contents: string, expectedNetwork: "mainnet" | "testnet" = config.network): MarketEvent[] {
  const events = contents.split(/\r?\n/).filter(Boolean).flatMap((line, index) => {
    let record: any;
    try { record = JSON.parse(line); } catch { throw new Error(`Replay line ${index + 1} is not valid JSON.`); }
    if (record.type === "control") return [];
    const value = record.type === "cycle" ? record.market : record;
    if (![5, EVENT_VERSION].includes(value?.schemaVersion) || value.type !== "market" || !Number.isInteger(value.ledgerIndex)) throw new Error(`Replay line ${index + 1} is not a supported version 5 or ${EVENT_VERSION} market event.`);
    if (value.source !== expectedNetwork || typeof value.ledgerHash !== "string" || typeof value.eventId !== "string") throw new Error(`Replay line ${index + 1} does not match the selected ${expectedNetwork} network or lacks ledger provenance.`);
    const original = value.recordedProvenance ?? { source: expectedNetwork, network: expectedNetwork, eventId: value.eventId, ledgerIndex: value.ledgerIndex, ledgerHash: value.ledgerHash, ...(Number.isFinite(value.receivedAt) ? { receivedAt: value.receivedAt } : {}) };
    if (original.source !== expectedNetwork || original.network !== expectedNetwork || original.eventId !== value.eventId || original.ledgerIndex !== value.ledgerIndex || original.ledgerHash !== value.ledgerHash) throw new Error(`Replay line ${index + 1} contains inconsistent recorded-source provenance.`);
    return [deepFreeze({ ...value, schemaVersion: EVENT_VERSION, replayMarker: true, recordedProvenance: original } as MarketEvent)];
  });
  for (let index = 1; index < events.length; index++) if (events[index]!.ledgerIndex <= events[index - 1]!.ledgerIndex) throw new Error(`Replay event order is invalid at market record ${index + 1}; Mainnet ledger indices must increase strictly.`);
  return events;
}

export function syntheticSeedHash(seed: string) { return hashText(seed); }
function hashSeed(seed: string) { return Number.parseInt(hashText(seed).slice(0, 8), 16) >>> 0; }
function hashText(text: string) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16).padStart(8, "0"); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as any)) deepFreeze(child); } return value; }
