import { readFileSync } from "node:fs";
import { config } from "./config";
import type { MarketDataSource } from "./market";
import type { MarketEvent } from "./types";

export class SyntheticMarketDataSource implements MarketDataSource {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private state: number;
  private ledger = 0;
  private mid = 0.5;
  constructor(private readonly seed: string, resumeLedger = 0) { this.state = hashSeed(seed) || 1; while (this.ledger < resumeLedger) this.advance(); }
  async start(callback: (event: MarketEvent) => Promise<void> | void) {
    const tick = async () => {
      if (this.stopped) return;
      const { spread, volume, executions } = this.advance();
      const event: MarketEvent = Object.freeze({
        schemaVersion: 1, eventId: `synthetic:${this.seed}:${this.ledger}`, type: "market",
        timestamp: 1_700_000_000_000 + this.ledger * 4_000, ledgerIndex: this.ledger,
        ledgerHash: hashText(`${this.seed}:${this.ledger}`), base: Object.freeze({ ...config.base }), quote: Object.freeze({ ...config.quote }),
        bids: Object.freeze([{ price: this.mid - spread / 2, baseVolume: volume }, { price: this.mid - spread, baseVolume: volume * 1.5 }].map((level) => Object.freeze(level))),
        asks: Object.freeze([{ price: this.mid + spread / 2, baseVolume: volume }, { price: this.mid + spread, baseVolume: volume * 1.5 }].map((level) => Object.freeze(level))),
        executions: Object.freeze(executions.map((trade) => Object.freeze(trade))), source: "synthetic", syntheticSeed: this.seed,
      });
      await callback(event);
      this.timer = setTimeout(() => void tick(), 4_000);
    };
    await tick();
  }
  private advance() {
    this.ledger++;
    const move = (this.random() - 0.5) * 0.006;
    this.mid = Math.max(0.005, this.mid * (1 + move));
    const spread = this.mid * 0.0015;
    const volume = 10 + this.random() * 15;
    const executions = this.ledger % 3 === 0 ? (() => { const side = this.random() > 0.5 ? "buy" as const : "sell" as const; return [{ side, price: this.mid * (side === "buy" ? 1.005 : 0.995), baseVolume: 20 + this.random() * 40, sourceTx: `synthetic:${this.seed}:${this.ledger}` }]; })() : [];
    return { spread, volume, executions };
  }
  private random() { this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0; return this.state / 0x1_0000_0000; }
  async close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}

export class ReplayMarketDataSource implements MarketDataSource {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly resumeLedger = 0) {}
  async start(callback: (event: MarketEvent) => Promise<void> | void) {
    const events = readFileSync(config.replayPath!, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
      const value = JSON.parse(line);
      if (value.schemaVersion !== 1 || value.type !== "market" || !Number.isInteger(value.ledgerIndex)) throw new Error(`Replay line ${index + 1} is not a version 1 market event.`);
      return deepFreeze(value as MarketEvent);
    });
    let i = events.findIndex((event) => event.ledgerIndex > this.resumeLedger);
    if (i < 0) return;
    const tick = async () => {
      if (this.stopped || i >= events.length) return;
      await callback(events[i++]!);
      this.timer = setTimeout(() => void tick(), 4_000);
    };
    await tick();
  }
  async close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}

export function syntheticSeedHash(seed: string) { return hashText(seed); }
function hashSeed(seed: string) { return Number.parseInt(hashText(seed).slice(0, 8), 16) >>> 0; }
function hashText(text: string) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16).padStart(8, "0"); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as any)) deepFreeze(child); } return value; }
