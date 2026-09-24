# Jev XRPL Trader dashboard

Local Next.js App Router UI for the paper-only XRPL trading daemon.

```sh
bun install
bun run dev -- --port 3002
```

The browser connects to `http://127.0.0.1:3000/events` by default. Override with `NEXT_PUBLIC_API_URL` if the local data API uses another loopback port. The read-only dashboard cannot access the bearer token for admin controls.

`src/lib/useFeed.ts` handles the versioned cycle SSE, reconnects with backoff, and retains the latest 500 cycles. The page shows XRPL/Testnet status and independent results for baseline, Jev-skewed baseline, and static passive control.
