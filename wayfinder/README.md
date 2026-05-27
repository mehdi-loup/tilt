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

**Scaffolded, not yet wired to live strategy execution.**

The function currently validates inputs (`strategy`, `walletId`, `amountUsd`,
user JWT) and returns a deterministic placeholder so the Next.js execution
flow can be exercised end-to-end.

To finish wiring:

1. **Wayfinder Privy adapter** — Wayfinder's `WalletClient.list_wallets`
   pattern fetches Privy server wallets via `system.api_key`. We need
   either: (a) register our app's Privy app secret with Wayfinder, or (b)
   patch Wayfinder's `core.utils.wallets` to accept a wallet id + user JWT
   directly and call `privy.walletApi.rpc(...)` with that auth context.

2. **Strategy mapping** — Our `RiskProfileId` (5 profiles) needs to compose
   one or more Wayfinder strategies. See `SUPPORTED_STRATEGIES` in
   `execute.py` for the proposed mapping; the real strategy-to-profile
   composition is in `lib/strategy-plan.ts` on the Next.js side.

3. **Chain config** — Wayfinder strategies are chain-pinned (Base, Hyperliquid,
   HyperEVM, etc.). Confirm RPC URLs + chain ids in env vars before live runs.

## Env vars

| Key | Purpose |
| --- | --- |
| `WAYFINDER_API_KEY` | `wk_…` from strategies.wayfinder.ai. Required for Wayfinder's remote-wallet feature. |
| `PRIVY_APP_SECRET` | Used by the Wayfinder→Privy adapter to authenticate signing requests. |
| `PRIVY_APP_ID` | Same. |
| `BASE_RPC_URL` | Base mainnet RPC (Alchemy/QuickNode). For now `https://mainnet.base.org`. |

## Deployment

Vercel auto-deploys `api/wayfinder/execute.py` as a Python serverless function.
Python deps come from `api/wayfinder/requirements.txt` (Vercel uses pip).

Local invocation:

```bash
curl -X POST https://tilt-hazel.vercel.app/api/wayfinder/execute \
  -H "authorization: Bearer $PRIVY_USER_JWT" \
  -H "content-type: application/json" \
  -d '{"strategy":"stable_lender","walletId":"<wallet-id>","amountUsd":250}'
```
