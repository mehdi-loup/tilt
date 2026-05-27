# Transaction Plan Execution

How EXECUTE_PLAN deploys the user's strategy on-chain.

## Architecture

```
┌──────────────┐    ┌─────────────────────────┐    ┌──────────────────────┐
│   Browser    │    │  Next.js (Vercel)       │    │  Wayfinder sidecar   │
│              │    │                         │    │  (Python, Vercel)    │
│  Privy       │    │  /api/wallet/server     │    │                      │
│  embedded    │    │  /api/plan/build        │    │  /api/wayfinder/     │
│  wallet      │◄──►│  /api/plan/execute-step │◄──►│       execute        │
│              │    │  - thin orchestrator    │    │  - Privy→Wayfinder   │
└──────────────┘    └─────────────┬───────────┘    │    sign adapter      │
                                  │                │  - Wayfinder strategy│
                                  ▼                │    .deposit()        │
                       ┌───────────────────┐       └──────────────────────┘
                       │  Privy walletApi  │                  │
                       │  (signs as user-  │                  ▼
                       │  owned server     │      ┌───────────────────┐
                       │  wallet)          │      │  Base / HyperEVM  │
                       └───────────────────┘      │  / Hyperliquid    │
                                                  │  (Wayfinder picks)│
                                                  └───────────────────┘
```

## Two wallets per user

1. **Embedded wallet** — user owns it. Privy holds the key in a TEE; only the user signs. Holds the user's funds.
2. **Server wallet** — provisioned on first EXECUTE_PLAN. App-owned via Privy's `walletApi.createWallet`. Drives Wayfinder strategy steps without per-tx popups.

## The flow

1. **Connect** — user clicks CONNECT, Privy modal opens, user authenticates.
2. **Dial** — user picks risk score; the Plan panel shows the profile, allocation, and live APYs.
3. **EXECUTE_PLAN** → modal opens.
4. **Build plan** — `POST /api/plan/build` with `{ risk, amountUsd }`. Server provisions a Privy server wallet for this user (or reuses), generates the `Plan` (`lib/strategy-plan.ts`): one funding step + one step per Wayfinder strategy in the profile's composition.
5. **Sign & execute** — modal walks the steps:
   - **Step 0 (fund)** — `useSendTransaction()` (Privy embedded wallet) signs the USDC.transfer from embedded → server wallet. The only step with a wallet popup.
   - **Steps 1..N (strategy)** — `POST /api/plan/execute-step`. The Next.js handler:
     1. Verifies the user's JWT
     2. Looks up the server wallet
     3. Forwards `{ profileId, amountUsd, walletId, walletAddress, userJwt }` to `/api/wayfinder/execute`
   - The Python sidecar:
     1. Builds a `privy_sign_callback` that calls Privy's wallet RPC (`POST /v1/wallets/{walletId}/rpc` method `eth_signTransaction`) with the app's HTTP basic auth, returns raw signed-tx bytes
     2. Instantiates the Wayfinder `Strategy` class with `main_wallet_signing_callback=privy_sign_callback`
     3. Calls `await strategy.deposit(main_token_amount=amountUsd)`
     4. Returns `{ source: "live", txHashes: [...], status: <StatusDict> }`
6. **Status** — each step row shows READY → PENDING → DONE | STUB | FAIL. Each Wayfinder strategy may emit multiple tx hashes (the modal renders all as Basescan links).

## The Privy adapter

The whole bridge is one closure (`api/wayfinder/execute.py`):

```python
def make_privy_sign_callback(wallet_id, wallet_address, caip2):
    async def sign_callback(transaction: dict) -> bytes:
        transaction = {**transaction, "from": wallet_address}
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"https://api.privy.io/v1/wallets/{wallet_id}/rpc",
                auth=(PRIVY_APP_ID, PRIVY_APP_SECRET),
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

Wayfinder's `StrategyClass.__init__` already accepts `main_wallet_signing_callback` and `strategy_wallet_signing_callback` parameters with shape `Callable[[dict], Awaitable[bytes]]`. The adapter slots in cleanly — no monkey-patching, no fork.

## What's live today

| Profile | Status |
| --- | --- |
| Stable Lender | **LIVE** — Wayfinder `stablecoin_yield_strategy` on Base, full deposit() runs |
| Conservative Yield | STUB — needs Base → HyperEVM bridge + composition runner |
| Balanced DeFi | STUB — same |
| Aggressive Growth | STUB — needs Hyperliquid + HyperEVM bridges |
| Max Speculation | STUB — multi-chain composition |

The 4 stub profiles render their planned strategy steps in the modal with explicit `STUB` badges and `pendingNote` text. The sidecar returns `source: "stub"` (not an error) so the plan walks end-to-end without throwing.

## What's needed next

1. **Wayfinder install on Vercel Python** — `api/wayfinder/requirements.txt` pins `wayfinder-paths`. Vercel's Python builder needs to resolve this from PyPI on deploy. If the package fails to install in the lambda, `GET /api/wayfinder/execute` reports `wayfinderInstalled: false`.
2. **Cross-chain bridging** — pick one (CCTP recommended for native USDC). Add a "bridge" step kind to `lib/strategy-plan.ts` that runs before the destination-chain strategy.
3. **Composition runner** — when a profile invokes >1 strategy, split the amount, run each, reconcile. Lives in the Python sidecar so the TS doesn't need to know.
4. **Receipt confirmation** — `strategy.deposit()` returns once tx is broadcast, not confirmed. For accurate `DONE` status, poll receipts after.
5. **Privy server-wallet persistence** — `lib/wallet-registry.ts` uses an in-process Map. Replace with KV / Postgres before any real users (otherwise duplicate wallets per region).

## What this repo no longer does

We **don't** build calldata for individual venues here. Files like `lib/tx-builders.ts` (the previous version had Aave Pool + Uniswap V3 routers + a slippage helper) are stripped — Wayfinder is the source of truth for protocol-specific logic. `tx-builders.ts` retains only the ERC-20 `transfer` helper for the funding step (which the user signs from their embedded wallet, not the server).

## Test locally

```bash
pnpm dev
curl http://localhost:3000/api/wayfinder/execute        # GET → service status
```

`GET /api/wayfinder/execute` reports `wayfinderInstalled: true` once the Python package resolves. In local dev without the package installed, it returns `false` and `POST` returns `503 missing-dep`. That's the expected state until Vercel builds the Python lambda with `wayfinder-paths` from PyPI.
