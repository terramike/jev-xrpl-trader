import { z } from "zod";
import { isValidClassicAddress } from "xrpl";
import { Decimal } from "./decimal";

const decimalSetting = (fallback: string, allowZero = false) => z.union([z.string(), z.number().finite()]).transform(String).refine((value) => {
  try { const amount = new Decimal(value); return amount.isFinite() && (allowZero ? amount.gte(0) : amount.gt(0)); } catch { return false; }
}, allowZero ? "Must be a non-negative decimal amount." : "Must be a positive decimal amount.").default(fallback);

const currencySchema = z.object({ currency: z.string().min(3).max(40).regex(/^(?:[A-Za-z0-9]{3}|[A-Fa-f0-9]{40})$/), issuer: z.string().optional() }).strict().superRefine((value, ctx) => {
  if (value.currency.toUpperCase() === "XRP" && value.issuer) ctx.addIssue({ code: "custom", message: "Native XRP must not have an issuer." });
  if (value.currency.toUpperCase() !== "XRP" && !value.issuer) ctx.addIssue({ code: "custom", message: `Issued currency ${value.currency} requires an exact issuer address.` });
  if (value.issuer && !isValidClassicAddress(value.issuer)) ctx.addIssue({ code: "custom", path: ["issuer"], message: "Issuer must be a valid XRPL classic address." });
});
const websocketUrl = (hosts: string[], networkName: string) => z.string().url().superRefine((value, ctx) => {
  const url = new URL(value);
  if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password) ctx.addIssue({ code: "custom", message: `${networkName} WebSocket URL must be credential-free.` });
  if (networkName === "Mainnet" && url.protocol !== "wss:") ctx.addIssue({ code: "custom", message: "Mainnet market data requires a TLS-protected WebSocket URL." });
  if (!hosts.includes(url.hostname.toLowerCase())) ctx.addIssue({ code: "custom", message: `WebSocket URL must point to an approved XRPL ${networkName} endpoint.` });
});
const configSchema = z.object({
  mode: z.literal("paper"), network: z.enum(["testnet", "mainnet"]).default("testnet"), source: z.enum(["testnet", "mainnet", "synthetic", "replay"]).default("testnet"),
  base: currencySchema, quote: currencySchema, seed: z.string().default("jev-xrpl-paper-v1"), replayPath: z.string().optional(),
  wsUrl: websocketUrl(["s.altnet.rippletest.net", "testnet.xrpl-labs.com"], "Testnet").default("wss://s.altnet.rippletest.net:51233"),
  mainnetWsUrl: websocketUrl(["xrplcluster.com", "xrpl.ws", "s1.ripple.com", "s2.ripple.com", "honeycluster.io"], "Mainnet").default("wss://xrplcluster.com/"), dataDir: z.string().default("data"),
  model: z.enum(["mock", "jev"]).default("mock"), jevModelId: z.string().default("jev-latest"), jevTimeoutMs: z.coerce.number().int().positive().default(1500),
  jevUsdPerMTok: decimalSetting("0.042", true), modeledXrplFeeDrops: z.string().regex(/^\d+$/).default("10"),
  usdToQuoteRate: decimalSetting("1"),
  spreadBps: decimalSetting("30"), quoteSize: decimalSetting("5"), maxInventory: decimalSetting("50"), maxDailyLoss: decimalSetting("25"),
  offerLifetimeLedgers: z.coerce.number().int().positive().default(1),
  queueAheadBase: decimalSetting("5", true), queueAheadFraction: z.coerce.number().min(0).max(1).default(0.5), checkpointEveryLedgers: z.coerce.number().int().positive().default(20),
  port: z.coerce.number().int().min(1024).max(65535).default(3000), adminPort: z.coerce.number().int().min(1024).max(65535).default(3001), dataHistory: z.coerce.number().int().positive().default(500),
}).strict().superRefine((value, ctx) => {
  if (value.network === "mainnet" && value.source !== "mainnet") ctx.addIssue({ code: "custom", path: ["source"], message: "Mainnet is available only through the explicitly selected read-only mainnet source." });
  if (value.network === "testnet" && value.source === "mainnet") ctx.addIssue({ code: "custom", path: ["network"], message: "SOURCE=mainnet requires NETWORK=mainnet." });
  if (value.model === "jev" && !process.env.TYPESAFE_AI_API_KEY?.trim()) ctx.addIssue({ code: "custom", path: ["model"], message: "MODEL=jev requires TYPESAFE_AI_API_KEY in the process environment. Set it in your untracked local .env; the key is never stored in the paper session." });
  if (value.source === "replay" && !value.replayPath) ctx.addIssue({ code: "custom", path: ["replayPath"], message: "REPLAY_PATH is required when SOURCE=replay." });
  if (value.base.currency.toUpperCase() === value.quote.currency.toUpperCase() && value.base.issuer === value.quote.issuer) ctx.addIssue({ code: "custom", path: ["quote"], message: "Base and quote assets must differ." });
  if (value.port === value.adminPort) ctx.addIssue({ code: "custom", path: ["adminPort"], message: "API and administrative ports must differ." });
});
export function assertNoSigningCredentials(env: Record<string, string | undefined>) {
  for (const forbidden of ["PRIVATE_KEY", "XRPL_SEED", "XRPL_SECRET", "SECRET_KEY", "MNEMONIC", "SEED", "SIGNER", "SIGNER_TYPE", "SIGNING_SERVICE_URL"]) if (env[forbidden]) throw new Error(`${forbidden} is not supported. This build is paper-only and does not load signing credentials.`);
}
assertNoSigningCredentials(process.env);
const currency = (symbol: string | undefined, issuer: string | undefined) => ({ currency: symbol ?? "", ...(issuer ? { issuer } : {}) });
export const parseConfig = (input: unknown) => configSchema.parse(input);
export const config = parseConfig({
  mode: process.env.MODE ?? "paper", network: process.env.NETWORK ?? "testnet", source: process.env.SOURCE,
  base: currency(process.env.BASE_CURRENCY, process.env.BASE_ISSUER), quote: currency(process.env.QUOTE_CURRENCY, process.env.QUOTE_ISSUER),
  seed: process.env.SYNTHETIC_SEED, replayPath: process.env.REPLAY_PATH, wsUrl: process.env.XRPL_WS_URL, mainnetWsUrl: process.env.XRPL_MAINNET_WS_URL, dataDir: process.env.DATA_DIR,
  model: process.env.MODEL, jevModelId: process.env.JEV_MODEL_ID, jevTimeoutMs: process.env.JEV_TIMEOUT_MS, jevUsdPerMTok: process.env.JEV_USD_PER_MILLION_TOKENS,
  modeledXrplFeeDrops: process.env.MODELED_XRPL_FEE_DROPS, usdToQuoteRate: process.env.USD_TO_QUOTE_RATE, spreadBps: process.env.SPREAD_BPS, quoteSize: process.env.QUOTE_SIZE,
  offerLifetimeLedgers: process.env.OFFER_LIFETIME_LEDGERS,
  maxInventory: process.env.MAX_INVENTORY, maxDailyLoss: process.env.MAX_DAILY_LOSS, queueAheadBase: process.env.QUEUE_AHEAD_BASE, queueAheadFraction: process.env.QUEUE_AHEAD_FRACTION,
  checkpointEveryLedgers: process.env.CHECKPOINT_EVERY_LEDGERS, port: process.env.PORT, adminPort: process.env.ADMIN_PORT, dataHistory: process.env.DATA_HISTORY,
});
