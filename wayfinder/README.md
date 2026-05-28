# Wayfinder sidecar

Python serverless function colocated with the Next.js app. Vercel detects
`api/wayfinder/execute.py` and deploys it as its own Fluid-Compute Python
lambda. Same project, same domain, separate runtime.

## What it is for

Wayfinder ([WayfinderFoundation/wayfinder-paths-sdk](https://github.com/WayfinderFoundation/wayfinder-paths-sdk))
is a Python SDK for running DeFi strategies. We use it server-side to drive
the user's per-account **Privy server-side wallet** — the wallet is owned by
the user (so they remain in the trust loop via JWT) but signing happens
server-side so multi-step strategies don't require a wallet popup per step.

## Current status

Stable Lender dispatches to Wayfinder's `stablecoin_yield_strategy` through
the Privy signing callback in `api/wayfinder/execute.py`. The other four
profiles are preview-only until bridging and composition are implemented.

The POST endpoint is not public API. Next.js calls it with
`x-tilt-internal-secret`; direct browser/client calls are rejected before any
wallet id is trusted.

## Env vars

| Key | Purpose |
| --- | --- |
| `WAYFINDER_API_KEY` | `wk_…` from strategies.wayfinder.ai. Required for Wayfinder's remote-wallet feature. |
| `PRIVY_APP_SECRET` | Used by the Wayfinder→Privy adapter to authenticate signing requests. |
| `PRIVY_APP_ID` | Same. |
| `WAYFINDER_INTERNAL_SECRET` | Optional internal Next.js → sidecar shared secret. Falls back to `PRIVY_APP_SECRET`. |
| `BASE_RPC_URL` | Base mainnet RPC (Alchemy/QuickNode). For now `https://mainnet.base.org`. |

## Deployment

Vercel auto-deploys `api/wayfinder/execute.py` as a Python serverless function.
Python deps come from `api/wayfinder/requirements.txt` (Vercel uses pip).

Local invocation:

```bash
curl -X POST https://tilt-hazel.vercel.app/api/wayfinder/execute \
  -H "x-tilt-internal-secret: $WAYFINDER_INTERNAL_SECRET" \
  -H "authorization: Bearer $PRIVY_USER_JWT" \
  -H "content-type: application/json" \
  -d '{"profileId":"stable_lender","walletId":"<wallet-id>","walletAddress":"0x...","amountUsd":250}'
```
