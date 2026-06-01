# tilt

A single-question crypto investing app: **how loud do you want to be?**

The user drags one dial (0–100). That risk score maps to one of five discrete strategy profiles (Stable Lender → Max Speculation), each with an allocation across eight asset classes and a routing map of execution venues per class. Live APYs are blended from DefiLlama and rendered next to each venue.

- **Strategies & routing:** [`STRATEGIES.md`](./STRATEGIES.md)
- **EXECUTE_PLAN flow + Wayfinder integration:** [`EXECUTION.md`](./EXECUTION.md)
- **Stack:** Next.js 15 (App Router) · React 19 · TypeScript · Privy connected + server wallets · viem · DefiLlama (live yields) · Wayfinder Python sidecar on Cloud Run · Vercel

## Local dev

```bash
pnpm install
cp .env.example .env.local      # fill in Privy credentials
pnpm dev                        # http://localhost:3000
```

Set `WAYFINDER_SIDECAR_URL` in `.env.local` to the Cloud Run sidecar when testing `EXECUTE_PLAN`; plain `next dev` does not serve the Python sidecar.

## Environment

| Key | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy dashboard → Settings | Public |
| `PRIVY_APP_SECRET` | Privy dashboard → Settings | Server-only |
| `WAYFINDER_INTERNAL_SECRET` | Generate a random server secret | Optional; protects internal Next.js → Python sidecar POSTs. Falls back to `PRIVY_APP_SECRET`. |
| `WAYFINDER_SIDECAR_URL` | Cloud Run service URL | Required in Vercel production/preview for `EXECUTE_PLAN`. |
| `WAYFINDER_API_KEY` | Wayfinder | Required on the Cloud Run sidecar for balance/quote calls. |
| `WAYFINDER_API_BASE_URL` | Wayfinder | Optional; defaults to `https://strategies.wayfinder.ai/api/v1`. |
| `KV_REST_API_URL` | Vercel KV / Upstash Redis | Required in production for persistent server-wallet mappings. |
| `KV_REST_API_TOKEN` | Vercel KV / Upstash Redis | Required in production for persistent server-wallet mappings. |

## Architecture notes

- **Rates resilience** — `lib/rates.ts` layers three caches so plans always render:
  1. In-process memo (per Lambda)
  2. Vercel Runtime Cache (per region, survives deploys, tagged `rates`)
  3. Bundled snapshot (`lib/rates-snapshot.json`) — last-known-good if DefiLlama is unreachable on a cold start
- **Server-only boundary** — `lib/rates.ts` imports `server-only`; UI code uses `lib/rates-shared.ts` so `@vercel/functions` and the snapshot stay out of the client bundle.
- **Theme** — dial color morphs from cool blue → red as risk rises (sRGB interpolation, see `themeForRisk` in `lib/tilt.ts`).

## Deploy

This repo deploys the Next.js app to Vercel automatically on push to `main`. Preview deployments are created for every PR. Set the Vercel env vars above in **Project → Settings → Environment Variables**.

The Wayfinder sidecar is separate: deploy `api/wayfinder` to Cloud Run and put that service URL in `WAYFINDER_SIDECAR_URL`. `.vercelignore` excludes `api/wayfinder/` so Vercel does not build the heavy Python dependency tree.
