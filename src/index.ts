const rawArgs = process.argv.slice(2);
const options = parseOptions(rawArgs[0] === "start" ? rawArgs.slice(1) : rawArgs);
for (const [key, value] of Object.entries(options)) process.env[key] = value;

try {
  const [{ config }, { XrplMarketDataSource }, { SyntheticMarketDataSource, ReplayMarketDataSource }, { createModel }, { AuditStore }, { Trader }, { startServers }] = await Promise.all([
    import("./config"), import("./market"), import("./sources"), import("./model"), import("./storage"), import("./trader"), import("./server"),
  ]);
  const store = new AuditStore(config.dataDir);
  const base = JSON.stringify(config.base), quote = JSON.stringify(config.quote);
  const assumptions = { spreadBps: config.spreadBps, quoteSize: config.quoteSize, maxInventory: config.maxInventory, maxDailyLoss: config.maxDailyLoss, queueAheadBase: config.queueAheadBase, queueAheadFraction: config.queueAheadFraction, offerLifetimeLedgers: config.offerLifetimeLedgers, modeledXrplFeeDrops: config.modeledXrplFeeDrops, jevUsdPerMTok: config.jevUsdPerMTok, model: config.model, jevModelId: config.jevModelId };
  const existing = store.loadSession();
  if (existing && (JSON.stringify(existing.base) !== base || JSON.stringify(existing.quote) !== quote || existing.source !== config.source || existing.seed !== (config.source === "synthetic" ? config.seed : undefined) || JSON.stringify(existing.assumptions) !== JSON.stringify(assumptions))) {
    throw new Error("Configured market/source/seed differs from the persisted session. Set a new DATA_DIR to start a separate paper session.");
  }
  const session = existing ?? { schemaVersion: 3 as const, sessionId: crypto.randomUUID(), startedAt: Date.now(), source: config.source, ...(config.source === "synthetic" ? { seed: config.seed } : {}), base: config.base, quote: config.quote, assumptions };
  store.saveSession(session);
  let server: ReturnType<typeof startServers> | undefined;
  const trader = new Trader(createModel(), store, (event) => server?.publish(event));
  server = startServers(trader, { ...session, mode: "paper", network: "testnet", model: config.model === "jev" ? config.jevModelId : "deterministic-mock" }, `${config.dataDir}/admin.token`);
  const source = config.source === "testnet" ? new XrplMarketDataSource() : config.source === "synthetic" ? new SyntheticMarketDataSource(config.seed, trader.resumeLedger) : new ReplayMarketDataSource(trader.resumeLedger);
  console.log(`jev-xrpl-trader · paper only · testnet · source=${config.source} · market=${asset(config.base)}/${asset(config.quote)} · API=http://127.0.0.1:${config.port} · admin=http://127.0.0.1:${config.adminPort}`);
  if (config.source === "synthetic") console.log(`reproducible synthetic seed=${config.seed}`);
  await source.start((event) => trader.onMarket(event));
  const shutdown = async () => { trader.requestShutdown(); await source.close(); await server?.close(); process.exit(0); };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
} catch (error) {
  console.error(`Startup rejected: ${(error as Error).message}`);
  process.exitCode = 1;
}

function parseOptions(args: string[]) {
  const allowed: Record<string, string> = { "--mode": "MODE", "--network": "NETWORK", "--source": "SOURCE", "--synthetic-seed": "SYNTHETIC_SEED", "--replay": "REPLAY_PATH", "--base": "BASE_CURRENCY", "--base-issuer": "BASE_ISSUER", "--quote": "QUOTE_CURRENCY", "--quote-issuer": "QUOTE_ISSUER", "--model": "MODEL", "--data-dir": "DATA_DIR" };
  const output: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i]!.split(/=(.*)/s, 2);
    const envName = allowed[flag!];
    if (!envName) throw new Error(`Unknown CLI option ${flag}.`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    output[envName] = value;
  }
  return output;
}
function asset(currency: { currency: string; issuer?: string }) { return currency.issuer ? `${currency.currency}.${currency.issuer}` : currency.currency; }
