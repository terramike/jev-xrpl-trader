import { z } from "zod";
import { isValidClassicAddress } from "xrpl";

const currencySchema = z.object({ currency: z.string().min(3).max(40).regex(/^(?:[A-Za-z0-9]{3}|[A-Fa-f0-9]{40})$/), issuer: z.string().optional() }).strict().superRefine((value, ctx) => {
  if (value.currency.toUpperCase() === "XRP" && value.issuer) ctx.addIssue({ code: "custom", message: "Native XRP must not have an issuer." });
  if (value.currency.toUpperCase() !== "XRP" && !value.issuer) ctx.addIssue({ code: "custom", message: `Issued currency ${value.currency} requires an exact issuer address.` });
  if (value.issuer && !isValidClassicAddress(value.issuer)) ctx.addIssue({ code: "custom", path: ["issuer"], message: "Issuer must be a valid XRPL classic address." });
});
const configSchema = z.object({
  mode: z.literal("paper"), network: z.literal("testnet"), source: z.enum(["testnet", "synthetic", "replay"]).default("testnet"),
  base: currencySchema, quote: currencySchema, seed: z.string().default("jev-xrpl-paper-v1"), replayPath: z.string().optional(),
  wsUrl: z.string().url().superRefine((value, ctx) => { const url = new URL(value); if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password) ctx.addIssue({ code: "custom", message: "XRPL_WS_URL must be a credential-free WebSocket URL." }); if (!['s.altnet.rippletest.net', 'testnet.xrpl-labs.com'].includes(url.hostname.toLowerCase())) ctx.addIssue({ code: "custom", message: "XRPL_WS_URL must point to an approved XRPL Testnet endpoint." }); }).default("wss://s.altnet.rippletest.net:51233"), dataDir: z.string().default("data"),
  model: z.enum(["mock", "jev"]).default("mock"), jevModelId: z.string().default("jev-latest"), jevTimeoutMs: z.coerce.number().int().positive().default(1500),
  jevUsdPerMTok: z.coerce.number().nonnegative().default(0.042), modeledXrplFeeDrops: z.coerce.number().nonnegative().default(10),
  spreadBps: z.coerce.number().positive().default(30), quoteSize: z.coerce.number().positive().default(5), maxInventory: z.coerce.number().positive().default(50), maxDailyLoss: z.coerce.number().positive().default(25),
  queueAheadBase: z.coerce.number().nonnegative().default(5), queueAheadFraction: z.coerce.number().min(0).max(1).default(0.5), checkpointEveryLedgers: z.coerce.number().int().positive().default(20),
  port: z.coerce.number().int().min(1024).max(65535).default(3000), adminPort: z.coerce.number().int().min(1024).max(65535).default(3001), dataHistory: z.coerce.number().int().positive().default(500),
}).strict().superRefine((value, ctx) => {
  if (value.source === "replay" && !value.replayPath) ctx.addIssue({ code: "custom", path: ["replayPath"], message: "REPLAY_PATH is required when SOURCE=replay." });
  if (value.base.currency.toUpperCase() === value.quote.currency.toUpperCase() && value.base.issuer === value.quote.issuer) ctx.addIssue({ code: "custom", path: ["quote"], message: "Base and quote assets must differ." });
  if (value.port === value.adminPort) ctx.addIssue({ code: "custom", path: ["adminPort"], message: "API and administrative ports must differ." });
});
for (const forbidden of ["PRIVATE_KEY", "XRPL_SEED", "XRPL_SECRET", "SECRET_KEY", "MNEMONIC", "SEED", "SIGNER", "SIGNER_TYPE", "SIGNING_SERVICE_URL"]) if (process.env[forbidden]) throw new Error(`${forbidden} is not supported. This build is paper-only and does not load signing credentials.`);
const currency = (symbol: string | undefined, issuer: string | undefined) => ({ currency: symbol ?? "", ...(issuer ? { issuer } : {}) });
export const parseConfig = (input: unknown) => configSchema.parse(input);
export const config = parseConfig({
  mode: process.env.MODE ?? "paper", network: process.env.NETWORK ?? "testnet", source: process.env.SOURCE,
  base: currency(process.env.BASE_CURRENCY, process.env.BASE_ISSUER), quote: currency(process.env.QUOTE_CURRENCY, process.env.QUOTE_ISSUER),
  seed: process.env.SYNTHETIC_SEED, replayPath: process.env.REPLAY_PATH, wsUrl: process.env.XRPL_WS_URL, dataDir: process.env.DATA_DIR,
  model: process.env.MODEL, jevModelId: process.env.JEV_MODEL_ID, jevTimeoutMs: process.env.JEV_TIMEOUT_MS, jevUsdPerMTok: process.env.JEV_USD_PER_MILLION_TOKENS,
  modeledXrplFeeDrops: process.env.MODELED_XRPL_FEE_DROPS, spreadBps: process.env.SPREAD_BPS, quoteSize: process.env.QUOTE_SIZE,
  maxInventory: process.env.MAX_INVENTORY, maxDailyLoss: process.env.MAX_DAILY_LOSS, queueAheadBase: process.env.QUEUE_AHEAD_BASE, queueAheadFraction: process.env.QUEUE_AHEAD_FRACTION,
  checkpointEveryLedgers: process.env.CHECKPOINT_EVERY_LEDGERS, port: process.env.PORT, adminPort: process.env.ADMIN_PORT, dataHistory: process.env.DATA_HISTORY,
});
