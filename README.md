# tilt

A single-question crypto investing app: **how loud do you want to be?**

The user drags one dial (0–100). That risk score maps to one of five discrete strategy profiles (Stable Lender → Max Speculation), each with an allocation across eight asset classes and a routing map of execution venues per class. Live APYs are blended from DefiLlama and rendered next to each venue.

- **Strategies & routing:** [`STRATEGIES.md`](./STRATEGIES.md)
- **EXECUTE_PLAN flow + Wayfinder integration:** [`EXECUTION.md`](./EXECUTION.md)
- **Stack:** Next.js 15 (App Router) · React 19 · TypeScript · Privy embedded + server wallets · viem · DefiLlama (live yields) · Wayfinder Python sidecar · Vercel

## Local dev

```bash
pnpm install
cp .env.example .env.local      # fill in Privy credentials
pnpm dev                        # http://localhost:3000
```

## Environment

| Key | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy dashboard → Settings | Public |
| `PRIVY_APP_SECRET` | Privy dashboard → Settings | Server-only |
| `WAYFINDER_INTERNAL_SECRET` | Generate a random server secret | Optional; protects internal Next.js → Python sidecar POSTs. Falls back to `PRIVY_APP_SECRET`. |

## Architecture notes

- **Rates resilience** — `lib/rates.ts` layers three caches so plans always render:
  1. In-process memo (per Lambda)
  2. Vercel Runtime Cache (per region, survives deploys, tagged `rates`)
  3. Bundled snapshot (`lib/rates-snapshot.json`) — last-known-good if DefiLlama is unreachable on a cold start
- **Server-only boundary** — `lib/rates.ts` imports `server-only`; UI code uses `lib/rates-shared.ts` so `@vercel/functions` and the snapshot stay out of the client bundle.
- **Theme** — dial color morphs from cool blue → red as risk rises (sRGB interpolation, see `themeForRisk` in `lib/tilt.ts`).

## Deploy

This repo deploys to Vercel automatically on push to `main`. Preview deployments are created for every PR. Set the env vars above in the Vercel dashboard under **Project → Settings → Environment Variables**.
