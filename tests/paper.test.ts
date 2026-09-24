import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MODE = "paper";
process.env.NETWORK = "testnet";
process.env.SOURCE = "synthetic";
process.env.JEV_TIMEOUT_MS = "5";
process.env.BASE_CURRENCY = "XRP";
delete process.env.BASE_ISSUER;
process.env.QUOTE_CURRENCY = "USD";
process.env.QUOTE_ISSUER = "rrrrrrrrrrrrrrrrrrrrBZbvji";
process.env.PORT = String(31_000 + process.pid % 2_000);
process.env.ADMIN_PORT = String(33_000 + process.pid % 2_000);

const [{ config, parseConfig }, { SyntheticMarketDataSource }, { PaperExecutor }, { initialStrategyState, AuditStore }, { Trader }, { startServers }, { executionsFromTransaction }] = await Promise.all([
  import("../src/config"), import("../src/sources"), import("../src/execution/paper"), import("../src/storage"), import("../src/trader"), import("../src/server"), import("../src/market"),
]);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(join(tmpdir(), "jev-paper-")); dirs.push(dir); return dir; }
function marketEvent(ledgerIndex: number, executions: any[] = [], source: "synthetic" | "testnet" = "synthetic") {
  return Object.freeze({ schemaVersion: 1 as const, eventId: `${source}:${ledgerIndex}`, type: "market" as const, timestamp: source === "testnet" ? Date.now() : 1_700_000_000_000 + ledgerIndex * 4_000, ledgerIndex, ledgerHash: `hash-${ledgerIndex}`, base: Object.freeze({ currency: "XRP" }), quote: Object.freeze({ currency: "USD", issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji" }), bids: Object.freeze([{ price: 0.4995, baseVolume: 20 }]), asks: Object.freeze([{ price: 0.5005, baseVolume: 20 }]), executions: Object.freeze(executions), source, ...(source === "synthetic" ? { syntheticSeed: "unit-test" } : {}) });
}

describe("paper configuration", () => {
  test("accepts the explicit paper/Testnet configuration", () => expect(config.mode).toBe("paper"));
  test("rejects live, Mainnet, missing issuer, identical pair, and replay without a file", () => {
    expect(() => parseConfig({ ...config, mode: "live" })).toThrow();
    expect(() => parseConfig({ ...config, network: "mainnet" })).toThrow();
    expect(() => parseConfig({ ...config, quote: { currency: "USD" } })).toThrow();
    expect(() => parseConfig({ ...config, base: config.quote })).toThrow();
    expect(() => parseConfig({ ...config, source: "replay", replayPath: undefined })).toThrow();
    expect(() => parseConfig({ ...config, wsUrl: "wss://xrplcluster.com" })).toThrow();
    expect(() => parseConfig({ ...config, signer: { type: "unknown" } })).toThrow();
  });
});

describe("market events and paper fills", () => {
  test("synthetic input is reproducible for a seed and immutable", async () => {
    const run = async () => { const source = new SyntheticMarketDataSource("stable-seed"); let event: unknown; await source.start((value) => { event = value; }); await source.close(); return event; };
    const first = await run(), second = await run();
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen((first as any).bids)).toBe(true);
  });
  test("extracts only validated direct offer executions with normalized direction", () => {
    const message = { validated: true, tx_json: { TransactionType: "OfferCreate", hash: "abc" }, meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [{ ModifiedNode: { LedgerEntryType: "Offer", FinalFields: { TakerGets: { currency: "XRP", value: "5" }, TakerPays: { currency: "USD", issuer: config.quote.issuer, value: "10" } }, PreviousFields: { TakerGets: { currency: "XRP", value: "6" }, TakerPays: { currency: "USD", issuer: config.quote.issuer, value: "12" } } } }] } };
    expect(executionsFromTransaction(message, config.base, config.quote)).toEqual([{ side: "buy", price: 2, baseVolume: 1, sourceTx: "abc" }]);
    expect(executionsFromTransaction({ ...message, validated: false }, config.base, config.quote)).toEqual([]);
  });
  test("enforces one-ledger latency, consumes queue first, and caps partial fills", () => {
    const executor = new PaperExecutor(), state = initialStrategyState();
    state.offers = [{ id: "b", side: "buy", price: 0.5, remaining: 4, queueRemaining: 2, placedLedger: 1, eligibleLedger: 2 }];
    const before = marketEvent(1, [{ side: "sell", price: 0.49, baseVolume: 10, sourceTx: "one" }]);
    expect(executor.applyLedger("baseline", state, before, 50)).toHaveLength(0);
    const after = marketEvent(2, [{ side: "sell", price: 0.49, baseVolume: 3, sourceTx: "two" }]);
    expect(executor.applyLedger("baseline", state, after, 50)).toEqual([{ strategy: "baseline", side: "buy", price: 0.5, baseVolume: 1, ledgerIndex: 2 }]);
    expect(state.inventory).toBe(1);
    expect(state.offers[0]?.queueRemaining).toBe(0);
  });
  test("applies the same executable volume independently to each virtual strategy", () => {
    const executor = new PaperExecutor();
    const states = [initialStrategyState(), initialStrategyState(), initialStrategyState()];
    const event = marketEvent(2, [{ side: "sell", price: 0.49, baseVolume: 10, sourceTx: "shared-ledger" }]);
    states.forEach((state, index) => { state.offers = [{ id: `strategy-${index}`, side: "buy", price: 0.5, remaining: 3, queueRemaining: 0, placedLedger: 1, eligibleLedger: 2 }]; });
    states.forEach((state, index) => executor.applyLedger((['baseline', 'jev', 'control'] as const)[index]!, state, event, 10));
    expect(states.map((state) => state.inventory)).toEqual([3, 3, 3]);
    expect(new Set(states.map((state) => state.offers)).size).toBe(3);
  });
  test("deterministic risk stops a strategy at the daily loss limit", async () => {
    const { DeterministicRiskPolicy } = await import("../src/risk");
    const policy = new DeterministicRiskPolicy(), state = initialStrategyState();
    state.risk.dailyRealizedLoss = 25;
    const event = marketEvent(1);
    state.risk.day = new Date(event.timestamp).toISOString().slice(0, 10);
    policy.update(state, event, { maxInventory: 50, maxDailyLoss: 25, quoteSize: 5 });
    expect(state.risk.stopped).toBe(true);
  });
});

describe("recovery, risk and administration", () => {
  test("ignores duplicate and invalid events and persists strategy state plus emergency stop", async () => {
    const store = new AuditStore(tempDir());
    const model = { assess: async () => ({ direction: "neutral" as const, toxicity: "low" as const, volatility: "calm" as const, confidence: 0.5, latencyMs: 0, inputTokens: 0 }) };
    const trader = new Trader(model, store);
    await trader.onMarket(marketEvent(1));
    const decisions = trader.report.strategies[0]!.decisions;
    await trader.onMarket(marketEvent(1));
    await trader.onMarket({ ...marketEvent(2), schemaVersion: 2 } as any);
    await trader.onMarket({ ...marketEvent(3, [], "testnet"), timestamp: Date.now() - 30_000 });
    expect(trader.report.strategies[0]!.decisions).toBe(decisions);
    trader.control("stop");
    appendFileSync(store.auditPath, '{"schemaVersion":1,"type":"cycle"');
    const restored = new Trader(model, store);
    expect(restored.status.emergencyStop).toBe(true);
    expect(restored.status.lastLedgerIndex).toBe(1);
    expect(restored.report.strategies.every((strategy) => strategy.openOffers === 0)).toBe(true);
    restored.control("reset-stop");
    expect(new Trader(model, store).status.emergencyStop).toBe(false);
  });
  test("Jev timeout withholds only Jev strategy exposure", async () => {
    const trader = new Trader({ assess: async () => { throw new Error("offline"); } }, new AuditStore(tempDir()));
    await trader.onMarket(marketEvent(1));
    const report = trader.report.strategies;
    expect(report.find((strategy) => strategy.id === "baseline")!.openOffers).toBe(2);
    expect(report.find((strategy) => strategy.id === "control")!.openOffers).toBe(2);
    expect(report.find((strategy) => strategy.id === "jev")!.openOffers).toBe(0);
  });
  test("admin operations require the local bearer token and stop persists", async () => {
    const dir = tempDir(), store = new AuditStore(dir);
    const model = { assess: async () => ({ direction: "neutral" as const, toxicity: "low" as const, volatility: "calm" as const, confidence: 0.5, latencyMs: 0, inputTokens: 0 }) };
    const trader = new Trader(model, store);
    const server = startServers(trader, { source: "synthetic" }, join(dir, "admin.token"));
    try {
      const url = `http://127.0.0.1:${config.adminPort}/admin/stop`;
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${server.token}` } });
      expect(response.status).toBe(200);
      expect((await response.json() as any).emergencyStop).toBe(true);
      expect(new Trader(model, store).status.emergencyStop).toBe(true);
    } finally { await server.close(); }
  });
});
