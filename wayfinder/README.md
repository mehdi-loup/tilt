# Wayfinder sidecar

Python FastAPI service on Cloud Run (`api/wayfinder/`): `app.py` (routes) →
`execute.py` (engine), `ledger.py` (Postgres job-status writes), `server.py`
(uvicorn entry). Too heavy for a Vercel function; the Next.js app reaches it
via `WAYFINDER_SIDECAR_URL`.

## What it is for

Wayfinder ([WayfinderFoundation/wayfinder-paths-sdk](https://github.com/WayfinderFoundation/wayfinder-paths-sdk))
is a Python SDK for running DeFi strategies. We use it server-side to drive
the user's per-account **Privy server-side wallet** — the wallet is owned by
the user (so they remain in the trust loop via JWT) but signing happens
server-side so multi-step strategies don't require a wallet popup per step.

## Current status

All seven strategies are wired: the `stablecoin_yield_rotator` path (vendored
in `api/wayfinder/rotator/`), the two Base strategy classes, and the four
multi-chain strategies (Arbitrum/HyperEVM/Hyperliquid), for which the engine
self-bridges the server wallet's Base USDC to the target chain before
deposit. Strategy runs are async jobs that write status to the Neon Postgres
ledger.

The POST endpoints are not public API. Next.js calls them with
`x-tilt-internal-secret`; direct browser/client calls are rejected before any
wallet id is trusted.

## Env vars

| Key | Purpose |
| --- | --- |
| `WAYFINDER_API_KEY` | `wk_…` from strategies.wayfinder.ai. Required for Wayfinder's remote-wallet feature. |
| `PRIVY_APP_SECRET` | Used by the Wayfinder→Privy adapter to authenticate signing requests. |
| `PRIVY_APP_ID` | Same. |
| `WAYFINDER_INTERNAL_SECRET` | **Required** internal Next.js → sidecar shared secret (no fallback). |
| `DATABASE_URL` | Neon Postgres — job status writes. Unset → synchronous fallback (dev). |
| `BASE_RPC_URL` | Base mainnet RPC (Alchemy/QuickNode). For now `https://mainnet.base.org`. |

## Deployment

Cloud Run: `gcloud run deploy tilt-wayfinder --source api/wayfinder`, with
`--no-cpu-throttling` so background strategy jobs keep running after the
response (see EXECUTION.md).

Local invocation:

```bash
curl -X POST "$WAYFINDER_SIDECAR_URL/strategy/run" \
  -H "x-tilt-internal-secret: $WAYFINDER_INTERNAL_SECRET" \
  -H "x-tilt-user-jwt: $PRIVY_USER_JWT" \
  -H "content-type: application/json" \
  -d '{"strategyName":"stablecoin_yield_rotator","walletId":"<wallet-id>","walletAddress":"0x...","amountUsd":250}'
```
