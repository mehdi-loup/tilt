# Transaction Plan Execution

How `EXECUTE_PLAN` deploys a strategy on-chain.

## Current Status

Only **Stable Lender** is fully executable today. It dispatches the user's funded server wallet to Wayfinder's `stablecoin_yield_strategy` on Base and now runs the required `deposit()` + `update()` lifecycle before reporting success.

Base-only strategy steps are wired for `stablecoin_yield_strategy` and `moonwell_wsteth_loop_strategy`. The other four profiles are still **preview-only as complete profiles** because at least one strategy in each profile needs target-chain USDC/gas funding that the current Base-only funding flow does not provide. The modal does not show `SIGN & EXECUTE` and does not create funding transfers for those incomplete profiles.

## Architecture

```
Browser / connected wallet (external preferred, else Privy embedded)
  └─ signs the Wayfinder-built funding transactions (+ a Base ETH gas float)

Next.js API
  ├─ /api/plan/build          (asks Wayfinder to plan + build funding txs)
  ├─ /api/plan/balance        (asks Wayfinder for investable USD, for presets)
  ├─ /api/plan/execute-step
  └─ Privy server-wallet provisioning

Vercel KV / Upstash Redis
  └─ persists userId → Privy server-wallet mapping

Python sidecar — Cloud Run (service tilt-wayfinder), reached via WAYFINDER_SIDECAR_URL
  └─ /api/wayfinder/execute   (wayfinder-paths deps too heavy for a Vercel function)
      ├─ protected by x-tilt-internal-secret
      ├─ wraps Privy wallet RPC as a Wayfinder signing callback
      ├─ operation=fund mode=plan    → Wayfinder builds unsigned funding txs
      ├─ operation=fund mode=balance → Wayfinder reports investable USD
      └─ runs Wayfinder strategy.deposit(...) and update(...) when required
```

## Wallets

- **Funding wallet**: the user-controlled wallet that signs funding transactions. The modal prefers an external connected wallet and falls back to the Privy embedded wallet.
- **Server wallet**: app-owned Privy wallet provisioned per user. Wayfinder delivers USDC to it, then drives it for strategy deposits through the Privy signing adapter.

`lib/wallet-registry.ts` persists `userId -> walletId` through Vercel KV / Upstash Redis when `KV_REST_API_URL` + `KV_REST_API_TOKEN` are configured. Local development falls back to an in-process map if KV is missing; production fails closed instead of silently using ephemeral storage.

### Decision: funding wallet signs every funding tx (revisit later)

The funding/embedded wallet is self-custodial, so moving funds out of it
requires a user signature per tx (external wallet → wallet popup; Privy embedded
→ Privy confirmation UI). We keep it this way for now: the user signs the funding
legs, after which the app-owned server wallet runs the strategy with no further
prompts. Revisit if the per-tx signing UX is a problem — Privy "session
signers" / delegated actions could make embedded-wallet signing promptless, at
the cost of moving toward app-delegated custody of the funding wallet.

## Execution Flow

1. User connects with Privy and chooses a USD amount to invest (25/50/75/100%
   presets are sized off the wallet's investable balance via
   `POST /api/plan/balance`).
2. User opens `EXECUTE_PLAN`.
3. Client calls `POST /api/plan/build`.
4. Server provisions or reuses the server wallet and asks the sidecar to
   **plan + build the funding transactions** (`operation=fund, mode=plan`):
   Wayfinder figures out how to move whatever the wallet holds into the
   server wallet as USDC on Base, and returns the unsigned tx(s). The plan
   carries them as `fund-N` steps. If Wayfinder is unavailable the plan
   returns without funding txs and the modal blocks execution.
5. If `plan.executable === false`, the modal shows preview-only steps and no execute button.
6. If executable, the modal walks steps in order:
   - `fund-gas`: funding wallet sends a `0.001` Base ETH gas float to the server wallet.
   - `fund-N`: funding wallet signs each Wayfinder-built funding tx (swaps/
     bridges that deliver USDC to the server wallet). Receipt-polled in turn.
   - `strategy-*`: Next.js calls the Python sidecar with the concrete `strategyName` to run Wayfinder.
7. Sidecar runs Wayfinder and returns `{ source: "live", txHashes, status }`.

The Stable Lender strategy was validated against the real `wayfinder-paths` SDK: `deposit()` only moves funds into the strategy wallet, and `update()` is the step that deploys to the selected pool. The funding route is built on real SDK primitives (`BalanceClient.get_enriched_wallet_balances` + `BRAPAdapter.best_quote`) and was verified live against the dev API. `StablecoinYieldStrategy.MIN_GAS` is `0.001` ETH, so the funding plan sends a matching `0.001` ETH gas float before strategy execution. A live on-chain run still requires funded Privy wallets and production secrets.

## Sidecar Auth

`POST /api/wayfinder/execute` is not public API. It requires:

- `x-tilt-internal-secret`: shared internal secret. Uses `WAYFINDER_INTERNAL_SECRET` if set; otherwise falls back to `PRIVY_APP_SECRET`.
- `x-tilt-user-jwt`: forwarded Privy user access token. Cloud Run intercepts `Authorization: Bearer` as Google IAM auth, so the user JWT uses this custom header.

Direct client calls without the internal secret return `403`.

## Running the Sidecar (local & prod)

The sidecar (`api/wayfinder/execute.py`) runs on **Cloud Run** (service `tilt-wayfinder`, project `project-e1f51a28-…`, region `us-east1`), not as a Vercel function — the wayfinder-paths dependency tree (web3/pandas/numpy/ccxt/…) is too heavy for a Vercel Lambda (it 502s on "Installing runtime dependencies"). It's a container (`Dockerfile` + `server.py` = `ThreadingHTTPServer` around the `handler`). The Next app reaches it via the `WAYFINDER_SIDECAR_URL` env var, which is required in Vercel Production and Preview. Deploy with `gcloud run deploy --source api/wayfinder`.

It needs `WAYFINDER_API_KEY` for the SDK's balance/quote calls; with no `config.json` present, `execute.py` sets the SDK API base to `https://strategies.wayfinder.ai/api/v1` (override with `WAYFINDER_API_BASE_URL`). Secrets are set directly on Cloud Run (`gcloud run services update --update-env-vars`) — Vercel's Sensitive env vars can't be read back via `vercel env pull`.

Gotchas:
- The Privy JWT is forwarded as the `x-tilt-user-jwt` header, **not** `Authorization` — Cloud Run intercepts `Authorization: Bearer` as Google IAM auth and 401s non-Google tokens.
- **`next dev`** doesn't serve the Python function, so set `WAYFINDER_SIDECAR_URL` in `.env.local` to the Cloud Run URL (local `PRIVY_APP_SECRET`/`WAYFINDER_INTERNAL_SECRET` must match the sidecar's).
- `.vercelignore` excludes `api/wayfinder/` so Vercel does not build the heavy Python function. Without `WAYFINDER_SIDECAR_URL`, production plan/balance calls fail closed with a configuration error.

## Privy Signing Adapter

The sidecar creates a Wayfinder signing callback around Privy's wallet RPC:

```python
def make_privy_sign_callback(wallet_id, wallet_address, caip2):
    async def sign_callback(transaction: dict) -> bytes:
        transaction = {**transaction, "from": wallet_address}
        resp = await client.post(
            f"https://api.privy.io/v1/wallets/{wallet_id}/rpc",
            auth=(PRIVY_APP_ID, PRIVY_APP_SECRET),
            headers={"privy-app-id": PRIVY_APP_ID},
            json={
                "method": "eth_signTransaction",
                "caip2": caip2,
                "params": {"transaction": _prepare_tx_for_privy(transaction)},
            },
        )
        signed = resp.json()["data"]["signed_transaction"]
        return bytes.fromhex(signed.removeprefix("0x"))
    return sign_callback
```

Wayfinder receives that callback through `main_wallet_signing_callback` and `strategy_wallet_signing_callback`.

## Live Coverage

| Profile | Status |
| --- | --- |
| Stable Lender | **LIVE**: Base `stablecoin_yield_strategy`, minimum `$2` |
| Conservative Yield | Preview-only: `stablecoin_yield_strategy` wired; `multi_vault_split_strategy` needs target-chain funding |
| Balanced DeFi | Preview-only: Base `stablecoin_yield_strategy` + `moonwell_wsteth_loop_strategy` wired; `multi_vault_split_strategy` needs target-chain funding |
| Aggressive Growth | Preview-only: Base `moonwell_wsteth_loop_strategy` wired; `basis_trading_strategy` + `projectx_thbill_usdc_strategy` need target-chain funding |
| Max Speculation | Preview-only: Base `moonwell_wsteth_loop_strategy` wired; `basis_trading_strategy` + `boros_hype_strategy` need multi-chain funding |

## Environment

| Key | Purpose |
| --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Client-side Privy app id |
| `PRIVY_APP_SECRET` | Server-side Privy auth and fallback sidecar secret |
| `WAYFINDER_INTERNAL_SECRET` | Optional explicit Next.js -> sidecar shared secret |
| `WAYFINDER_SIDECAR_URL` | Required in Vercel production/preview; Cloud Run sidecar URL |
| `WAYFINDER_API_KEY` | Required by the Python sidecar for Wayfinder balance/quote API calls |
| `WAYFINDER_API_BASE_URL` | Optional Wayfinder SDK API host override; defaults to `https://strategies.wayfinder.ai/api/v1` |
| `KV_REST_API_URL` | Vercel KV / Upstash Redis REST URL for persistent server-wallet mappings |
| `KV_REST_API_TOKEN` | Vercel KV / Upstash Redis REST token |
| `SERVER_WALLET_REGISTRY_PREFIX` | Optional Redis key prefix for server-wallet mappings |

Privy dashboard requirement: server wallet creation must be enabled for the app before production calls to `walletApi.createWallet`.

## What Still Needs Work

1. **Run funded Stable Lender live transaction**
   - Preflight is automated by `scripts/stable_lender_deploy_test.py`.
   - Live app mode needs a connected funding wallet with routeable assets and enough Base ETH for the gas float; the server wallet receives Base USDC and `0.001` Base ETH before strategy execution.
   - Run with risk `0-20`, amount `>= $2`, and confirm `deposit()` + `update()` both return success.

2. **Strategy receipt polling**
   - Funding txs are receipt-polled.
   - Wayfinder strategy tx hashes are still trusted as returned; add receipt polling after Wayfinder returns.

3. **Withdrawal / recovery**
   - Add a way to withdraw idle USDC/ETH from the server wallet.

4. **Profiles 2-5**
   - Add target-chain funding/bridge steps for Arbitrum, HyperEVM, and Hyperliquid.
   - Split amounts per strategy and reconcile status/receipts.

## Local Checks

```bash
pnpm build
python3.12 -m py_compile api/wayfinder/execute.py api/wayfinder/server.py scripts/stable_lender_deploy_test.py
PYTHONPATH=/private/tmp/tilt-wayfinder-deploytest python3.12 scripts/stable_lender_deploy_test.py
```

`pnpm lint` currently prompts for Next.js ESLint setup and is not non-interactive yet.

`GET $WAYFINDER_SIDECAR_URL` reports sidecar health and whether `wayfinder_paths` is importable in that Python runtime.

When running with `pnpm dev`, only the Next.js app routes are served. Set `WAYFINDER_SIDECAR_URL` to the Cloud Run sidecar or a separately running local sidecar; otherwise `/api/plan/balance` will report a sidecar 404 in development. Production requires the env var and fails closed when it is missing.

## Stable Lender Deploy Test

Safe preflight, no transactions:

```bash
python3.12 -m pip install --target /private/tmp/tilt-wayfinder-deploytest -r requirements.txt
PYTHONPATH=/private/tmp/tilt-wayfinder-deploytest python3.12 scripts/stable_lender_deploy_test.py
```

Live mode submits real transactions from the provided Privy server wallet:

```bash
PYTHONPATH=/private/tmp/tilt-wayfinder-deploytest python3.12 scripts/stable_lender_deploy_test.py --live \
  --wallet-id "$STABLE_LENDER_TEST_WALLET_ID" \
  --wallet-address "$STABLE_LENDER_TEST_WALLET_ADDRESS" \
  --amount-usd "$STABLE_LENDER_TEST_AMOUNT_USD"
```
