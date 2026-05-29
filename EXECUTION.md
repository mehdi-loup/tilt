# Transaction Plan Execution

How `EXECUTE_PLAN` deploys a strategy on-chain.

## Current Status

Only **Stable Lender** is executable today. It dispatches the user's funded server wallet to Wayfinder's `stablecoin_yield_strategy` on Base.

The other four profiles are **preview-only**. They render planned Wayfinder strategy steps with `STUB` badges and `pendingNote` text, but the modal does not show `SIGN & EXECUTE` and does not create any funding transfer for those profiles.

## Architecture

```
Browser / Privy embedded wallet
  └─ signs the Wayfinder-built funding transactions (+ a Base ETH gas float)

Next.js API
  ├─ /api/plan/build          (asks Wayfinder to plan + build funding txs)
  ├─ /api/plan/balance        (asks Wayfinder for investable USD, for presets)
  ├─ /api/plan/execute-step
  └─ Privy server-wallet provisioning

Python sidecar
  └─ /api/wayfinder/execute
      ├─ protected by x-tilt-internal-secret
      ├─ wraps Privy wallet RPC as a Wayfinder signing callback
      ├─ operation=fund mode=plan    → Wayfinder builds unsigned funding txs
      ├─ operation=fund mode=balance → Wayfinder reports investable USD
      └─ runs Wayfinder strategy.deposit(...)
```

## Wallets

- **Embedded wallet**: user-controlled Privy wallet. It holds the user's funds and signs the Wayfinder-built funding transactions.
- **Server wallet**: app-owned Privy wallet provisioned per user. Wayfinder delivers USDC to it, then drives it for strategy deposits through the Privy signing adapter.

Known limitation: `lib/wallet-registry.ts` still stores `userId -> walletId` in-process. Replace it with KV/Postgres before real users.

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
   - `fund-gas`: embedded wallet sends a small Base ETH gas float to the server wallet.
   - `fund-N`: embedded wallet signs each Wayfinder-built funding tx (swaps/
     bridges that deliver USDC to the server wallet). Receipt-polled in turn.
   - `strategy-*`: Next.js calls the Python sidecar to run Wayfinder.
7. Sidecar runs Wayfinder and returns `{ source: "live", txHashes, status }`.

The funding route is wired but unverified: the Wayfinder swap/planner class
(`FUND_SPEC` in `api/wayfinder/execute.py`) and its `build_funding_route` /
`investable_value` methods are best-guesses pending the real SDK, same as the
strategy specs. Verify before a live run.

## Sidecar Auth

`POST /api/wayfinder/execute` is not public API. It requires:

- `x-tilt-internal-secret`: shared internal secret. Uses `WAYFINDER_INTERNAL_SECRET` if set; otherwise falls back to `PRIVY_APP_SECRET`.
- `Authorization: Bearer <privy-user-access-token>`: forwarded by the authenticated Next.js route.

Direct client calls without the internal secret return `403`.

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
| Conservative Yield | Preview-only: needs composition runner + Base -> HyperEVM bridge |
| Balanced DeFi | Preview-only: needs composition runner + bridges |
| Aggressive Growth | Preview-only: needs Hyperliquid/HyperEVM bridges |
| Max Speculation | Preview-only: needs multi-chain composition |

## Environment

| Key | Purpose |
| --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Client-side Privy app id |
| `PRIVY_APP_SECRET` | Server-side Privy auth and fallback sidecar secret |
| `WAYFINDER_INTERNAL_SECRET` | Optional explicit Next.js -> sidecar shared secret |

Privy dashboard requirement: server wallet creation must be enabled for the app before production calls to `walletApi.createWallet`.

## What Still Needs Work

1. **Deploy-test Stable Lender**
   - Confirm Vercel Python installs `wayfinder-paths`.
   - Confirm the real Wayfinder strategy constructor and callback contract match the adapter.
   - Test with risk `0-20`, amount `>= $2`, and embedded wallet holding Base USDC + Base ETH.

2. **Persist server wallets**
   - Replace the in-process registry with KV/Postgres.

3. **Strategy receipt polling**
   - Funding txs are receipt-polled.
   - Wayfinder strategy tx hashes are still trusted as returned; add receipt polling after Wayfinder returns.

4. **Withdrawal / recovery**
   - Add a way to withdraw idle USDC/ETH from the server wallet.

5. **Profiles 2-5**
   - Add bridge steps.
   - Add sidecar composition runner.
   - Split amounts per strategy and reconcile status/receipts.

## Local Checks

```bash
pnpm build
env PYTHONPYCACHEPREFIX=/private/tmp/tilt-pycache python3 -m py_compile api/wayfinder/execute.py
```

`pnpm lint` currently prompts for Next.js ESLint setup and is not non-interactive yet.

`GET /api/wayfinder/execute` reports sidecar health and whether `wayfinder_paths` is importable in that Python runtime.
