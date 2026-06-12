# Transaction Plan Execution

How `EXECUTE_PLAN` deploys a strategy on-chain.

## Current Status

**All five profiles are executable.** User funding still lands as USDC (+ gas
float) on Base only; strategies that need funds elsewhere declare a `prepare`
spec and the sidecar **self-bridges the server wallet's Base USDC to the
target chain** (BRAP quotes + swaps, signed by the same Privy wallet — no
user prompts), then deposits what actually arrived:

- `stablecoin_yield_rotator` — Base (Wayfinder *path*, vendored in `api/wayfinder/rotator/`)
- `moonwell_wsteth_loop_strategy` — Base
- `multi_vault_split_strategy`, `basis_trading_strategy`, `boros_hype_strategy` — funded via Arbitrum USDC + ETH gas
- `projectx_thbill_usdc_strategy` — funded via HyperEVM USDC + HYPE gas

Execution is recorded in a Postgres ledger and strategy steps run as async
jobs on the sidecar; the browser polls the ledger and is no longer the source
of truth.

## Architecture

```
Browser ──────────── signs funding txs, renders progress (polls; not source of truth)
   │
Next.js on Vercel ── BFF: Privy auth, plan building, persistence, status reads
   │           │       /api/plan/build · /balance · /execute-step
   │           │       /api/plan/execution/:id (status) · /:id/step (fund reports)
   │        Neon Postgres ── THE ledger: executions, steps, tx hashes,
   │           │             server-wallet registry (db/schema.sql)
   │           │
Cloud Run (FastAPI) ── stateless "Wayfinder engine" (api/wayfinder/):
                        POST /fund/plan      → Wayfinder builds unsigned funding txs
                        POST /fund/balance   → investable USD for presets
                        POST /strategy/run   → async job; prep-bridges to the
                                               target chain, runs deposit()/update(),
                                               writes status rows to Postgres
```

### Sidecar Configuration

The Next.js app reaches the sidecar via `WAYFINDER_SIDECAR_URL`. This is required in Vercel Production and Preview env vars.

**Environment variables to set in Vercel:**
- `WAYFINDER_SIDECAR_URL` — the Cloud Run service URL (e.g., `https://tilt-wayfinder-xyz.run.app`)
- `WAYFINDER_INTERNAL_SECRET` — matches the sidecar's `WAYFINDER_INTERNAL_SECRET` (validates `x-tilt-internal-secret` header)
- `WAYFINDER_API_BASE_URL` — override for the Wayfinder SDK API base (defaults to `https://strategies.wayfinder.ai/api/v1`)

**Cloud Run deploy command (project `project-e1f51a28-…`, region `us-east1`):**
```bash
gcloud run deploy tilt-wayfinder \
  --source api/wayfinder \
  --no-cpu-throttling \
  --min-instances 1
```

Set the same `WAYFINDER_INTERNAL_SECRET`, `WAYFINDER_API_KEY`, and `DATABASE_URL` as env vars on the Cloud Run service.

## Wallets

- **Funding wallet**: the user-controlled wallet that signs funding transactions. The modal prefers an external connected wallet and falls back to the Privy embedded wallet.
- **Server wallet**: app-owned Privy wallet provisioned per user. Wayfinder delivers USDC to it, then drives it for strategy deposits through the Privy signing adapter.

`lib/wallet-registry.ts` persists `userId -> walletId` in the Neon Postgres ledger (`server_wallets`, `db/schema.sql`) when `DATABASE_URL` is configured. Local development falls back to an in-process map; production fails closed instead of silently using ephemeral storage. (The old Upstash KV registry is gone — one store.)

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
   **plan + build the funding transactions** (`POST /fund/plan`): Wayfinder
   figures out how to move whatever the wallet holds into the server wallet
   as USDC on Base, and returns the unsigned tx(s). The plan carries them as
   `fund-N` steps. The build **persists an `executions` row + `steps` rows**
   (including the built funding txs and quoted amounts) and returns an
   `executionId`. If Wayfinder is unavailable the plan returns without
   funding txs and the modal blocks execution.
5. If `plan.executable === false`, the modal shows preview-only steps and no execute button.
6. If executable, the modal walks steps in order:
   - `fund-gas`: funding wallet sends a `0.001` Base ETH gas float to the server wallet.
   - `fund-N`: funding wallet signs each Wayfinder-built funding tx; the
     client reports the hash + receipt outcome to
     `POST /api/plan/execution/:id/step`, so the ledger records them.
   - `strategy-*`: client calls `POST /api/plan/execute-step` with only
     `{ executionId, stepId }`. The server validates against the stored
     record (nothing client-sent is trusted), dispatches
     `POST /strategy/run` on the sidecar, which returns a `jobId`
     immediately and runs prep-bridge + deposit()/update() in the
     background, writing status to Postgres. The client polls
     `GET /api/plan/execution/:id` until the step settles. Retries are
     idempotent — a step the ledger marks `succeeded` is never re-run.

The Stable Lender strategy was validated against the real `wayfinder-paths` SDK: `deposit()` only moves funds into the strategy wallet, and `update()` is the step that deploys to the selected pool. The funding route is built on real SDK primitives (`BalanceClient.get_enriched_wallet_balances` + `BRAPAdapter.best_quote`) and was verified live against the dev API. `StablecoinYieldStrategy.MIN_GAS` is `0.001` ETH, so the funding plan sends a matching `0.001` ETH gas float before strategy execution. A live on-chain run still requires funded Privy wallets and production secrets.

## Sidecar Auth

The sidecar's POST routes are not public API. Every one requires:

- `x-tilt-internal-secret`: must equal `WAYFINDER_INTERNAL_SECRET` (required; no `PRIVY_APP_SECRET` fallback — one secret, one purpose).
- `x-tilt-user-jwt`: forwarded Privy user access token. Cloud Run intercepts `Authorization: Bearer` as Google IAM auth, so the user JWT uses this custom header.

Direct client calls without the internal secret return `403`.

## Running the Sidecar (local & prod)

The sidecar runs on **Cloud Run** (service `tilt-wayfinder`, project `project-e1f51a28-…`, region `us-east1`), not as a Vercel function — the wayfinder-paths dependency tree (web3/pandas/numpy/ccxt/…) is too heavy for a Vercel Lambda (it 502s on "Installing runtime dependencies"). It's a container: `Dockerfile` + `server.py` (uvicorn) serving the FastAPI app in `app.py`, which adapts HTTP onto the engine in `execute.py`. The Next app reaches it via the `WAYFINDER_SIDECAR_URL` env var, which is required in Vercel Production and Preview. Deploy with `gcloud run deploy --source api/wayfinder` — and because strategy jobs keep running after the response is sent, the service must keep CPU allocated between requests: `gcloud run services update tilt-wayfinder --no-cpu-throttling` (consider `--min-instances 1` so a scale-to-zero doesn't kill an in-flight job).

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

Strategy classes receive that callback through `main_wallet_signing_callback` and `strategy_wallet_signing_callback`. The rotator path instead resolves its signer by wallet *label*: the sidecar encodes the Privy wallet into the label (`tilt:<wallet-id>:<address>`) and patches the SDK's label resolver to return the same Privy callback for it.

## Live Coverage

The plan splits the amount equally across steps, so a profile's minimum is
`steps × max(step minimum)`. Step minimums include bridging/gas headroom over
the strategy's own minimum (see `STRATEGY_SPECS` in `api/wayfinder/execute.py`).

| Profile | Status | Minimum |
| --- | --- | ---: |
| Stable Lender | **LIVE**: `stablecoin_yield_rotator` | $2 |
| Conservative Yield | **LIVE**: rotator + `multi_vault_split_strategy` (Arbitrum prep) | $90 |
| Balanced DeFi | **LIVE**: rotator + `moonwell_wsteth_loop_strategy` + `multi_vault_split_strategy` | $135 |
| Aggressive Growth | **LIVE**: moonwell + `basis_trading_strategy` (Arbitrum prep) + `projectx_thbill_usdc_strategy` (HyperEVM prep) | $90 |
| Max Speculation | **LIVE**: moonwell + `basis_trading_strategy` + `boros_hype_strategy` (Arbitrum prep) | $480 |

## Environment

| Key | Purpose |
| --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Client-side Privy app id |
| `PRIVY_APP_SECRET` | Server-side Privy auth (signing adapter) |
| `WAYFINDER_INTERNAL_SECRET` | **Required** Next.js -> sidecar shared secret (no fallback) |
| `WAYFINDER_SIDECAR_URL` | Required in Vercel production/preview; Cloud Run sidecar URL |
| `WAYFINDER_API_KEY` | Required by the Python sidecar for Wayfinder balance/quote API calls |
| `WAYFINDER_API_BASE_URL` | Optional Wayfinder SDK API host override; defaults to `https://strategies.wayfinder.ai/api/v1` |
| `DATABASE_URL` | Neon Postgres connection string — required on **both** Vercel (ledger reads/writes) and Cloud Run (sidecar job status writes). Apply `db/schema.sql` once. |

Privy dashboard requirement: server wallet creation must be enabled for the app before production calls to `walletApi.createWallet`.

## What Still Needs Work

1. **Run funded Stable Lender live transaction**
   - Preflight is automated by `scripts/stable_lender_deploy_test.py`.
   - Live app mode needs a connected funding wallet with routeable assets and enough Base ETH for the gas float; the server wallet receives Base USDC and `0.001` Base ETH before strategy execution.
   - Run with risk `0-20`, amount `>= $2`, and confirm `deposit()` + `update()` both return success.

2. **Run a funded multi-chain profile live**
   - Profiles 2–5 are wired (target-chain prep + async jobs) but have not
     moved real funds end-to-end. Start with Conservative Yield (smallest
     multi-chain surface: one Arbitrum prep) before the Hyperliquid/HyperEVM
     profiles.
   - The Privy typed-data callback (`eth_signTypedData_v4`) is exercised by
     Hyperliquid actions — verify against a live wallet before relying on it.

3. **Strategy receipt polling**
   - Funding txs are receipt-polled.
   - Wayfinder strategy tx hashes are still trusted as returned; add receipt polling after Wayfinder returns.

4. **Withdrawal / recovery**
   - Add a way to withdraw idle USDC/ETH from the server wallet (the rotator
     path has a withdraw action; the strategies have withdraw flows too).

5. **Ledger-driven resume UI**
   - The ledger records everything, but the modal still starts fresh per
     session; surface in-flight/past executions from
     `GET /api/plan/execution/:id`.

## Local Checks

```bash
pnpm build
python3.12 -m py_compile api/wayfinder/execute.py api/wayfinder/app.py api/wayfinder/ledger.py api/wayfinder/server.py scripts/stable_lender_deploy_test.py
PYTHONPATH=/private/tmp/tilt-wayfinder-deploytest python3.12 scripts/stable_lender_deploy_test.py
```

`pnpm lint` currently prompts for Next.js ESLint setup and is not non-interactive yet.

`GET $WAYFINDER_SIDECAR_URL` reports sidecar health and whether `wayfinder_paths` is importable in that Python runtime.

When running with `pnpm dev`, only the Next.js app routes are served. Set `WAYFINDER_SIDECAR_URL` to the Cloud Run sidecar or a separately running local sidecar; otherwise `/api/plan/balance` will report a sidecar 404 in development. Production requires the env var and fails closed when it is missing.

## Backend Re-architecture (implemented 2026-06-11)

The re-architecture decided 2026-06-10 has shipped. What changed, by
migration step:

1. **FastAPI sidecar** — `app.py` (FastAPI) + `server.py` (uvicorn) replaced
   the hand-rolled `ThreadingHTTPServer`/`BaseHTTPRequestHandler` and the
   manually managed background event loop; uvicorn's single process loop
   keeps the SDK's module-level httpx clients valid across requests.
   `execute.py` is now a pure engine module with no HTTP plumbing. A legacy
   `POST /` route still answers the old single-endpoint body contract —
   remove it once no pre-ledger Next.js deploy is live.
2. **Neon Postgres** (`db/schema.sql`, `lib/db.ts`) — the wallet registry
   moved from Upstash KV to `server_wallets`; Upstash is gone.
3. **Execution ledger** — `plan/build` persists `executions` + `steps`
   (including Wayfinder-built funding txs and quoted amounts) and returns an
   `executionId`; `execute-step` takes only `{executionId, stepId}` and
   validates against the stored record; the client reports funding tx hashes
   to `POST /api/plan/execution/:id/step`; "resume" reads the rows (the
   on-chain shortfall check in plan/build stays as a safety net).
4. **Async strategy jobs** — `POST /strategy/run` returns a `jobId`
   immediately and runs prep + deposit/update in the background, writing
   status to Postgres (`ledger.py`, asyncpg); the client polls
   `GET /api/plan/execution/:id`. No more 300s Vercel ceiling; retries are
   idempotent via the ledger. Requires Cloud Run `--no-cpu-throttling`.
   Without `DATABASE_URL` the sidecar falls back to synchronous execution
   (local dev).
5. **Auth tightened** — `WAYFINDER_INTERNAL_SECRET` is required on both
   sides; the `PRIVY_APP_SECRET` fallback is gone. (Cloud Run IAM with
   Vercel OIDC federation remains a possible future hardening.)

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
