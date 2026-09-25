"use client";

import { useEffect, useState } from "react";
import type { CycleEvent } from "./types";

export function useFeed(apiUrl: string) {
  const [events, setEvents] = useState<CycleEvent[]>([]);
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [marketConnection, setMarketConnection] = useState<"connecting" | "live" | "stale" | "replay">("connecting");
  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      if (stopped) return;
      setConnection(retry ? "reconnecting" : "connecting");
      source = new EventSource(`${apiUrl.replace(/\/+$/, "")}/events`);
      source.onopen = () => { retry = 0; setConnection("live"); };
      source.onerror = () => {
        source?.close();
        setConnection("reconnecting");
        const delay = Math.min(10_000, 500 * 2 ** retry++);
        retryTimer = setTimeout(connect, delay);
      };
      source.addEventListener("snapshot", (message) => {
        try { const value = JSON.parse((message as MessageEvent).data); if (Array.isArray(value.history)) setEvents(value.history.filter((item: any) => item.type === "cycle").slice(-500)); if (["connecting", "live", "stale", "replay"].includes(value.marketConnection)) setMarketConnection(value.marketConnection); }
        catch { /* ignore malformed snapshots; a later reconnect requests another */ }
      });
      source.addEventListener("cycle", (message) => {
        try {
          const event = JSON.parse((message as MessageEvent).data) as CycleEvent;
          if (event.schemaVersion !== 1 || event.type !== "cycle" || typeof event.eventId !== "string") return;
          setMarketConnection("live");
          setEvents((current) => current.at(-1)?.eventId === event.eventId ? current : [...current, event].slice(-500));
        } catch { /* ignore invalid stream events */ }
      });
      source.addEventListener("ping", (message) => { setConnection("live"); try { const value = JSON.parse((message as MessageEvent).data); if (["connecting", "live", "stale", "replay"].includes(value.marketConnection)) setMarketConnection(value.marketConnection); } catch { /* ignore heartbeat parsing errors */ } });
    };
    connect();
    return () => { stopped = true; source?.close(); clearTimeout(retryTimer); };
  }, [apiUrl]);
  return { events, connection, marketConnection } satisfies FeedState;
}
import type { FeedState } from "./types";
