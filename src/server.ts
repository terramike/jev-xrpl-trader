import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { config } from "./config";
import type { Trader } from "./trader";
import type { ControlEvent, CycleEvent } from "./types";

const json = (value: unknown, status = 200, extraHeaders: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders } });
const enc = new TextEncoder();

export function startServers(trader: Trader, meta: Record<string, unknown>, tokenPath: string) {
  const allowedOrigins = new Set(["http://localhost:3002", "http://127.0.0.1:3002"]);
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const push = (event: CycleEvent | ControlEvent) => {
    const payload = enc.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const client of clients) { try { client.enqueue(payload); } catch { clients.delete(client); } }
  };
  const token = tokenFor(tokenPath);
  const publicServer = Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch(req) {
    const { pathname } = new URL(req.url);
    const origin = req.headers.get("origin");
    const cors: Record<string, string> = origin && allowedOrigins.has(origin) ? { "access-control-allow-origin": origin, "vary": "origin" } : {};
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type" } });
    if (req.method === "GET" && ["/", "/status"].includes(pathname)) return json({ ...trader.status, ...meta }, 200, cors);
    if (req.method === "GET" && pathname === "/report") return json({ ...trader.report, ...meta }, 200, cors);
    if (req.method === "GET" && pathname === "/history") return json(trader.history, 200, cors);
    if (req.method === "GET" && pathname === "/events") {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { clients.add(controller); controller.enqueue(enc.encode(`event: snapshot\ndata: ${JSON.stringify({ ...trader.status, ...meta, history: trader.history })}\n\n`)); }, cancel(controller) { clients.delete(controller); } });
      return new Response(stream, { headers: { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
    }
    return json({ error: "not found" }, 404, cors);
  } });
  const adminServer = Bun.serve({ hostname: "127.0.0.1", port: config.adminPort, fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.headers.get("host") !== `127.0.0.1:${config.adminPort}`) return json({ error: "loopback host required" }, 403);
    if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET" && pathname === "/status") return json(trader.status);
    if (req.method === "GET" && pathname === "/report") return json({ ...trader.report, ...meta });
    const actions: Record<string, ControlEvent["action"]> = { "/admin/stop": "stop", "/admin/cancel-all": "cancel-all", "/admin/reset-stop": "reset-stop" };
    if (req.method === "POST" && actions[pathname]) return json(trader.control(actions[pathname]!));
    return json({ error: "not found" }, 404);
  } });
  const heartbeat = setInterval(() => {
    const bytes = enc.encode(`event: ping\ndata: ${JSON.stringify({ timestamp: Date.now(), marketConnection: trader.status.marketConnection })}\n\n`);
    for (const client of clients) { try { client.enqueue(bytes); } catch { clients.delete(client); } }
  }, 15_000);
  return { token, publish: push, close: async () => { clearInterval(heartbeat); clients.clear(); await publicServer.stop(true); await adminServer.stop(true); } };
}

function tokenFor(path: string) {
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600, flag: "w" });
  return token;
}
