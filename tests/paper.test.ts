import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const [{ config, parseConfig, assertNoSigningCredentials }, { SyntheticMarketDataSource }, { PaperExecutor }, { initialStrategyState, initialStrategies, AuditStore, assertFreshMainnetDataDir }, { Trader }, { startServers }, { executionsFromTransaction, transactionExecutionResult }] = await Promise.all([
  import("../src/config"), import("../src/sources"), import("../src/execution/paper"), import("../src/storage"), import("../src/trader"), import("../src/server"), import("../src/market"),
]);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(join(tmpdir(), "jev-paper-")); dirs.push(dir); return dir; }
function marketEvent(ledgerIndex: number, executions: any[] = [], source: "synthetic" | "testnet" = "synthetic") {
  return Object.freeze({ schemaVersion: 3 as const, eventId: `${source}:${ledgerIndex}`, type: "market" as const, timestamp: source === "testnet" ? Date.now() : 1_700_000_000_000 + ledgerIndex * 4_000, ledgerIndex, ledgerHash: `hash-${ledgerIndex}`, base: Object.freeze({ currency: "XRP" }), quote: Object.freeze({ currency: "USD", issuer: "rrrrrrrrrrrrrrrrrrrrBZbvji" }), bids: Object.freeze([{ price: "0.4995", baseVolume: "20" }]), asks: Object.freeze([{ price: "0.5005", baseVolume: "20" }]), executions: Object.freeze(executions.map((trade) => ({ ...trade, price: String(trade.price), baseVolume: String(trade.baseVolume) }))), unsupportedExecutions: Object.freeze([]), source, ...(source === "synthetic" ? { syntheticSeed: "unit-test" } : {}) });
}

describe("paper configuration", () => {
  test("preserves the existing paper/Testnet defaults", () => {
    expect(config.mode).toBe("paper");
    expect(config.network).toBe("testnet");
    const testnet = parseConfig({ ...config, source: undefined, wsUrl: undefined });
    expect(testnet.source).toBe("testnet");
    expect(testnet.wsUrl).toBe("wss://s.altnet.rippletest.net:51233");
  });
  test("selects read-only Mainnet explicitly and permits Jev only in paper mode", () => {
    const mainnet = parseConfig({ ...config, network: "mainnet", source: "mainnet", dataDir: "data/mainnet-shadow-test" });
    expect(mainnet.network).toBe("mainnet");
    expect(mainnet.source).toBe("mainnet");
    expect(mainnet.mainnetWsUrl).toBe("wss://xrplcluster.com/");
    expect(() => parseConfig({ ...config, network: "mainnet" })).toThrow();
    expect(() => parseConfig({ ...config, source: "mainnet" })).toThrow();
    const previousKey = process.env.TYPESAFE_AI_API_KEY;
    process.env.TYPESAFE_AI_API_KEY = "test-only-credential";
    try { expect(parseConfig({ ...mainnet, model: "jev", mainnetWsUrl: "wss://s1.ripple.com/" }).model).toBe("jev"); }
    finally { if (previousKey === undefined) delete process.env.TYPESAFE_AI_API_KEY; else process.env.TYPESAFE_AI_API_KEY = previousKey; }
    expect(() => parseConfig({ ...mainnet, model: "jev", mode: "live" })).toThrow();
    expect(() => parseConfig({ ...mainnet, mainnetWsUrl: "wss://s.altnet.rippletest.net:51233" })).toThrow();
    expect(() => parseConfig({ ...mainnet, mainnetWsUrl: "ws://xrplcluster.com/" })).toThrow();
    expect(() => parseConfig({ ...config, wsUrl: "wss://s1.ripple.com/" })).toThrow();
  });
  test("requires a fresh Mainnet DATA_DIR and refuses Testnet data reuse", () => {
    const fresh = join(tempDir(), "mainnet-fresh");
    mkdirSync(fresh);
    expect(() => assertFreshMainnetDataDir(fresh)).not.toThrow();
    expect(() => assertFreshMainnetDataDir("data")).toThrow("fresh DATA_DIR");
    const occupied = join(tempDir(), "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "session.json"), JSON.stringify({ network: "testnet", source: "testnet" }));
    expect(() => assertFreshMainnetDataDir(occupied)).toThrow("choose a new empty directory");
    const resumable = join(tempDir(), "mainnet-resume");
    mkdirSync(resumable);
    writeFileSync(join(resumable, "session.json"), JSON.stringify({ network: "mainnet", source: "mainnet" }));
    expect(() => assertFreshMainnetDataDir(resumable)).not.toThrow();
  });
  test("rejects live, Mainnet, missing issuer, identical pair, and replay without a file", () => {
    expect(() => parseConfig({ ...config, mode: "live" })).toThrow();
    expect(() => parseConfig({ ...config, network: "mainnet" })).toThrow();
    expect(() => parseConfig({ ...config, quote: { currency: "USD" } })).toThrow();
    expect(() => parseConfig({ ...config, base: config.quote })).toThrow();
    expect(() => parseConfig({ ...config, source: "replay", replayPath: undefined })).toThrow();
    expect(() => parseConfig({ ...config, wsUrl: "wss://xrplcluster.com" })).toThrow();
    expect(() => parseConfig({ ...config, signer: { type: "unknown" } })).toThrow();
    expect(() => parseConfig({ ...config, modeledXrplFeeDrops: "0.1" })).toThrow();
    expect(() => assertNoSigningCredentials({ XRPL_SEED: "dummy-test-value" })).toThrow("paper-only");
  });
  test("keeps configured asset precision instead of coercing amounts through JavaScript number", () => {
    const precise = parseConfig({ ...config, quoteSize: "0.000000000000000001", maxInventory: "999999999999999999.123456789012345678" });
    expect(precise.quoteSize).toBe("0.000000000000000001");
    expect(precise.maxInventory).toBe("999999999999999999.123456789012345678");
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
    expect(executionsFromTransaction(message, config.base, config.quote)).toEqual([{ side: "buy", price: "2", baseVolume: "1", sourceTx: "abc" }]);
    expect(executionsFromTransaction({ ...message, validated: false }, config.base, config.quote)).toEqual([]);
  });
  test("parses saved validated Testnet OfferCreate and Payment offer crossings, including sub-cent partial volume", () => {
    const market = { currency: "524C555344000000000000000000000000000000", issuer: "rxgWsz3eoNK1fmA3t3Q34FMrhTJTFb1PR" };
    const offerCreate = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "testnet-offercreate-crossing.json"), "utf8"));
    const payment = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "testnet-payment-crossing.json"), "utf8"));
    const offerFill = executionsFromTransaction(offerCreate, config.base, market);
    const paymentFill = executionsFromTransaction(payment, { currency: "XRP" }, { currency: "03E93DC0CBC531CDDFC2E0BA0447ACF86D6E778C", issuer: "rBG5vJkxbppTTAWkSCL5iym28HE7bFhZF4" });
    expect(offerFill).toHaveLength(1);
    expect(offerFill[0]!.sourceTx).toBe(offerCreate.hash);
    expect(paymentFill).toEqual([{ side: "sell", price: "300000000000", baseVolume: "0.000001", sourceTx: payment.hash }]);
    expect(transactionExecutionResult({ ...payment, meta: { ...payment.meta, AffectedNodes: [] } }, config.base, market).unsupportedReason).toBe("payment-without-direct-target-offer-delta");
  });
  test("routes saved validated Testnet OfferCreate and Payment executions through paper fills", () => {
    const offerCreate = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "testnet-offercreate-crossing.json"), "utf8"));
    const payment = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "testnet-payment-crossing.json"), "utf8"));
    const executions = [
      ...executionsFromTransaction(offerCreate, config.base, { currency: "524C555344000000000000000000000000000000", issuer: "rxgWsz3eoNK1fmA3t3Q34FMrhTJTFb1PR" }),
      ...executionsFromTransaction(payment, config.base, { currency: "03E93DC0CBC531CDDFC2E0BA0447ACF86D6E778C", issuer: "rBG5vJkxbppTTAWkSCL5iym28HE7bFhZF4" }),
    ];
    expect(executions).toHaveLength(2);
    for (const [index, trade] of executions.entries()) {
      const ledgerIndex = 21_023_461 + index;
      const state = initialStrategyState();
      state.offers = [{ id: `fixture-${index}`, side: trade.side === "sell" ? "buy" : "sell", price: trade.price, remaining: trade.baseVolume, queueRemaining: "0", placedLedger: ledgerIndex - 1, eligibleLedger: ledgerIndex }];
      const fills = new PaperExecutor().applyLedger("baseline", state, marketEvent(ledgerIndex, [trade], "testnet"), "50");
      expect(fills).toHaveLength(1);
      expect(fills[0]?.sourceTx).toBe(trade.sourceTx);
      expect(fills[0]?.baseVolume).toBe(trade.baseVolume);
      expect(fills[0]?.qualification).toContain("validated direct offer execution");
    }
  });
  test("enforces one-ledger latency, consumes queue first, and caps partial fills", () => {
    const executor = new PaperExecutor(), state = initialStrategyState();
    state.offers = [{ id: "b", side: "buy", price: "0.5", remaining: "4", queueRemaining: "2", placedLedger: 1, eligibleLedger: 2 }];
    const before = marketEvent(1, [{ side: "sell", price: 0.49, baseVolume: 10, sourceTx: "one" }]);
    expect(executor.applyLedger("baseline", state, before, 50)).toHaveLength(0);
    const after = marketEvent(2, [{ side: "sell", price: 0.49, baseVolume: 3, sourceTx: "two" }]);
    expect(executor.applyLedger("baseline", state, after, 50)).toEqual([{ strategy: "baseline", side: "buy", price: "0.5", baseVolume: "1", ledgerIndex: 2, sourceTx: "two", executionPrice: "0.49", queueVolumeConsumed: "2", qualification: "validated direct offer execution crossed an eligible paper offer after configured queue volume" }]);
    expect(state.inventory).toBe("1");
    expect(state.offers[0]?.queueRemaining).toBe("0");
  });
  test("keeps sub-precision issued-asset partial fills and realized P&L in exact decimal strings", () => {
    const executor = new PaperExecutor(), state = initialStrategyState();
    state.offers = [{ id: "tiny", side: "buy", price: "2", remaining: "0.000000000000000002", queueRemaining: "0", placedLedger: 1, eligibleLedger: 2 }];
    executor.applyLedger("baseline", state, marketEvent(2, [{ side: "sell", price: "1", baseVolume: "0.0000000000000000015", sourceTx: "tiny-buy" }]), 1);
    expect(state.inventory).toBe("0.0000000000000000015");
    expect(state.averageEntryPrice).toBe("2");
    state.offers = [{ id: "close", side: "sell", price: "3", remaining: state.inventory, queueRemaining: "0", placedLedger: 2, eligibleLedger: 3 }];
    executor.applyLedger("baseline", state, marketEvent(3, [{ side: "buy", price: "3", baseVolume: "0.0000000000000000015", sourceTx: "tiny-sell" }]), 1);
    expect(state.inventory).toBe("0");
    expect(state.realizedPnl).toBe("0.0000000000000000015");
  });
  test("applies the same executable volume independently to each virtual strategy", () => {
    const executor = new PaperExecutor();
    const states = [initialStrategyState(), initialStrategyState(), initialStrategyState()];
    const event = marketEvent(2, [{ side: "sell", price: 0.49, baseVolume: 10, sourceTx: "shared-ledger" }]);
    states.forEach((state, index) => { state.offers = [{ id: `strategy-${index}`, side: "buy", price: "0.5", remaining: "3", queueRemaining: "0", placedLedger: 1, eligibleLedger: 2 }]; });
    states.forEach((state, index) => executor.applyLedger((['baseline', 'jev', 'control'] as const)[index]!, state, event, 10));
    expect(states.map((state) => state.inventory)).toEqual(["3", "3", "3"]);
    expect(new Set(states.map((state) => state.offers)).size).toBe(3);
  });
  test("models create, replacement, and cancellation costs while retaining unchanged offers", () => {
    const executor = new PaperExecutor(), state = initialStrategyState();
    const first = { id: "one", side: "buy" as const, price: "1", remaining: "1", queueRemaining: "2", placedLedger: 1, eligibleLedger: 2, expiresLedger: 5 };
    executor.place(state, [first], 10);
    executor.place(state, [{ ...first, id: "two", queueRemaining: 99 }], 10);
    expect(state.modeledOfferCreates).toBe(1);
    expect(state.modeledOfferCancels).toBe(0);
    executor.place(state, [{ ...first, id: "three", price: "1.1" }], 10);
    expect(state.modeledOfferCreates).toBe(2);
    expect(state.modeledOfferCancels).toBe(1);
    executor.cancelAll(state, 10);
    expect(state.modeledOfferCancels).toBe(2);
    expect(state.xrplFeeDrops).toBe("40");
  });
  test("expires offers after the configured eligible lifetime and models the cancel drop cost", () => {
    const executor = new PaperExecutor(), state = initialStrategyState();
    executor.place(state, [{ id: "short", side: "buy", price: "1", remaining: "1", queueRemaining: "0", placedLedger: 1, eligibleLedger: 2, expiresLedger: 3 }], 12);
    executor.applyLedger("baseline", state, marketEvent(3), 5, 12);
    expect(state.offers).toHaveLength(0);
    expect(state.modeledOfferCancels).toBe(1);
    expect(state.xrplFeeDrops).toBe("24");
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
    await trader.onMarket({ ...marketEvent(2), schemaVersion: 4 } as any);
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
  test("explains intact-audit recovery when a checkpoint is corrupt and fails clearly without audit", () => {
    const dir = tempDir(), store = new AuditStore(dir);
    const model = { assess: async () => ({ direction: "neutral" as const, toxicity: "low" as const, volatility: "calm" as const, confidence: 0.5, latencyMs: 0, inputTokens: 0 }) };
    const trader = new Trader(model, store);
    trader.control("stop");
    writeFileSync(store.checkpointPath, "{broken", "utf8");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(new Trader(model, store).status.emergencyStop).toBe(true);
      expect(warning.mock.calls.map((call) => call[0]).join(" ")).toContain("audit journal was validated and replayed");
    } finally { warning.mockRestore(); }
    const other = new AuditStore(tempDir());
    writeFileSync(other.checkpointPath, "{broken", "utf8");
    expect(() => other.recover()).toThrow("no audit journal is available for replay");
  });
  test("restores exact decimal inventory, P&L, fee drops, offers, and risk state from a checkpoint", () => {
    const store = new AuditStore(tempDir()), strategies = initialStrategies();
    strategies.baseline.inventory = "0.0000000000000000015";
    strategies.baseline.averageEntryPrice = "12345678901234567890.12345678901234567890";
    strategies.baseline.realizedPnl = "0.00000000000000000000017";
    strategies.baseline.xrplFeeDrops = "900719925474099312345";
    strategies.baseline.risk.dailyRealizedLoss = "0.00000000000000000000003";
    strategies.baseline.offers = [{ id: "persisted", side: "buy", price: "0.000000000000000001", remaining: "0.000000000000000002", queueRemaining: "0.000000000000000003", placedLedger: 1, eligibleLedger: 2, expiresLedger: 3 }];
    store.checkpoint({ schemaVersion: 3, lastEventId: "cycle:test", lastLedgerIndex: 1, lastMid: "0.0000000000000000001", emergencyStop: true, strategies });
    const restored = store.recover()!;
    expect(restored.strategies.baseline.inventory).toBe("0.0000000000000000015");
    expect(restored.strategies.baseline.realizedPnl).toBe("0.00000000000000000000017");
    expect(restored.strategies.baseline.xrplFeeDrops).toBe("900719925474099312345");
    expect(restored.strategies.baseline.offers[0]?.remaining).toBe("0.000000000000000002");
    expect(restored.strategies.baseline.risk.dailyRealizedLoss).toBe("0.00000000000000000000003");
    expect(restored.emergencyStop).toBe(true);
  });
  test("Jev timeout withholds only Jev strategy exposure", async () => {
    const trader = new Trader({ assess: async () => { throw new Error("offline"); } }, new AuditStore(tempDir()));
    await trader.onMarket(marketEvent(1));
    const report = trader.report.strategies;
    expect(report.find((strategy) => strategy.id === "baseline")!.openOffers).toBe(2);
    expect(report.find((strategy) => strategy.id === "control")!.openOffers).toBe(2);
    expect(report.find((strategy) => strategy.id === "jev")!.openOffers).toBe(0);
    expect(trader.status.strategies.find((strategy) => strategy.id === "jev")!.state.lastDecision.reason).toBe("Jev assessment unavailable; quote withheld");
  });
  test("records the Jev assessment and exact abstention gates in the per-ledger quote decision", async () => {
    const assessment = { direction: "bearish" as const, toxicity: "high" as const, volatility: "extreme" as const, confidence: 1, latencyMs: 0, inputTokens: 0 };
    const store = new AuditStore(tempDir());
    const trader = new Trader({ assess: async () => assessment }, store);
    await trader.onMarket(marketEvent(1));
    const jev = trader.status.strategies.find((strategy) => strategy.id === "jev")!;
    expect(jev.state.lastDecision.assessment).toEqual(assessment);
    expect(jev.state.lastDecision.reason).toBe("Jev withheld quotes: high toxicity and extreme volatility");
    expect(jev.state.lastDecision.quotes).toHaveLength(0);
    const cycle = JSON.parse(readFileSync(store.auditPath, "utf8").trim().split(/\r?\n/).at(-1)!);
    expect(cycle.eligibleDirectOfferVolume).toEqual({ buy: "0", sell: "0", total: "0" });
    expect(cycle.strategies.jev.state.lastDecision.assessment).toEqual(assessment);
  });
  test("records eligible volume, quote decisions, unsupported cases and detailed fill evidence in each cycle", async () => {
    const store = new AuditStore(tempDir()), strategies = initialStrategies();
    strategies.baseline.offers = [{ id: "resting", side: "buy", price: "0.5", remaining: "2", queueRemaining: "0", placedLedger: 1, eligibleLedger: 2, expiresLedger: 5 }];
    store.append({ schemaVersion: 3, eventId: "control:prior", type: "control", timestamp: 1, action: "reset-stop", emergencyStop: false, strategies });
    store.checkpoint({ schemaVersion: 3, lastEventId: "control:prior", lastLedgerIndex: 1, lastMid: "0.5", emergencyStop: false, strategies });
    const trader = new Trader({ assess: async () => ({ direction: "neutral", toxicity: "low", volatility: "calm", confidence: 0.5, latencyMs: 1, inputTokens: 10 }) }, store);
    const event = marketEvent(2, [{ side: "sell", price: "0.49", baseVolume: "3", sourceTx: "validated-source-tx" }]);
    const market = { ...event, unsupportedExecutions: [{ sourceTx: "unmatched-tx", transactionType: "Payment", reason: "payment-without-direct-target-offer-delta" }] };
    await trader.onMarket(market);
    const cycle = JSON.parse(readFileSync(store.auditPath, "utf8").trim().split(/\r?\n/).at(-1)!);
    expect(cycle.eligibleDirectOfferVolume).toEqual({ buy: "0", sell: "3", total: "3" });
    expect(cycle.market.unsupportedExecutions[0].sourceTx).toBe("unmatched-tx");
    expect(cycle.strategies.baseline.state.lastDecision.quotes.length).toBeGreaterThan(0);
    expect(cycle.fills).toHaveLength(1);
    expect(cycle.fills[0]).toMatchObject({ side: "buy", baseVolume: "2", sourceTx: "validated-source-tx", executionPrice: "0.49", queueVolumeConsumed: "0" });
    expect(cycle.fills[0].qualification).toContain("validated direct offer execution");
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
