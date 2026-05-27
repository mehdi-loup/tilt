# Transaction Plan Execution

How EXECUTE_PLAN actually deploys the user's strategy on-chain.

## Architecture

```
┌──────────────┐    ┌─────────────────────┐    ┌────────────────────┐
│   Browser    │    │  Next.js (Vercel)   │    │  Wayfinder sidecar │
│              │    │                     │    │   (Python, Vercel) │
│  Privy       │    │  - /api/wallet/...  │    │                    │
│  embedded    │    │  - /api/plan/...    │    │  /api/wayfinder/   │
│  wallet      │◄──►│  - Privy server     │◄──►│      execute       │
│              │    │    SDK              │    │                    │
└──────────────┘    └──────────┬──────────┘    └────────────────────┘
                               │
                               ▼
                       ┌───────────────┐
                       │  Privy        │
                       │  walletApi    │
                       │  ─ Base chain │
                       └───────────────┘
```

Two wallets per user:
1. **Embedded wallet** — user owns it (Privy holds the key in TEE, user is the only signer). Holds the user's funds.
2. **Server wallet** — provisioned on first execute. App-owned via Privy's `walletApi.createWallet`. Drives the strategy without per-tx popups.

## The flow

1. **Connect** — user clicks CONNECT in the nav, Privy modal opens, user authenticates. Embedded wallet is auto-created if they don't have one (`createOnLogin: 'users-without-wallets'`).
2. **Dial** — user picks risk score; the strategy panel shows the profile, allocation, and live APYs.
3. **EXECUTE_PLAN** → modal opens.
4. **Build plan** — POST `/api/plan/build` with risk + amount. Server provisions a Privy server wallet for this user (or reuses the existing one), generates the ordered `Plan` (lib/strategy-plan.ts), and pre-encodes the funding tx so the client never imports viem.
5. **Sign & execute** — modal walks the steps:
   - **Step 0 (fund)** — `useSendTransaction()` (Privy embedded wallet) signs the USDC.transfer from user → server wallet. **The only step with a wallet popup.**
   - **Steps 1..N (strategy)** — POST `/api/plan/execute-step` for each. Server picks the calldata builder for that step, calls `privy.walletApi.ethereum.sendTransaction({ walletId, transaction, caip2: 'eip155:8453' })`, returns the tx hash. **No popups.**
6. **Status** — each step row shows READY → PENDING → DONE | STUB | FAIL, with a Basescan link on success.

## What's live vs. stubbed today

| Profile | Asset class | Status | Reason |
| --- | --- | --- | --- |
| Stable Lender | LEND (Aave V3 USDC supply, Base) | **LIVE** | Calldata builder in `lib/tx-builders.ts`. |
| Conservative Yield | SPOT (BTC/ETH/SOL) | STUB | Needs Uniswap V3 SwapRouter02 calldata. |
| Conservative Yield | LST (Lido stETH) | STUB | Needs Lido `submit()` calldata + Ethereum bridge. |
| Balanced DeFi | DEFI (LPs) | STUB | Multi-token LP composition (Uniswap/Curve/Balancer). |
| Balanced DeFi | YIELD (Pendle) | STUB | Pendle SDK / Router calldata. |
| Balanced DeFi | RESTAKE (ether.fi) | STUB | Restaking deposit calldata + bridge. |
| Aggressive Growth | MEME | STUB | DEX-specific routing per venue. |
| Max Speculation | PERP | STUB | Hyperliquid is its own L1; needs different rail. |

Every stub step is rendered in the modal with a clear `STUB` badge. Execution returns `{ source: "stub", note: "…" }` instead of throwing — the plan completes end-to-end so users see the full intended deployment.

## Adding a new live step

For an EVM-DEX-style step (Uniswap, Curve, Aerodrome):

1. Add the venue's pool/router address and ABI to `lib/chains.ts` and `lib/tx-builders.ts`.
2. Write a builder like `buildAaveSupplyUsdc` that returns `{ to, data, value }`.
3. Add the asset to `LIVE_ASSETS` in `lib/strategy-plan.ts` and the per-leg branching that emits the right step ids.
4. Add the corresponding `if (step.id === "...")` branch in `/api/plan/execute-step`.
5. Manually test against Base mainnet with a small amount before merging.

For a multi-chain step (Solana, Hyperliquid L1, Ethereum mainnet from Base):

1. The funding lives on Base. Any other chain requires a bridge step first (LayerZero / Across / native CCTP for USDC).
2. Add the bridge step before the venue deposit step.
3. Server-side execution can drive multi-chain since the server wallet works across EVM chains via different `caip2` values. Non-EVM (Solana) needs a separate Privy Solana server wallet — see `walletApi.solana`.

## Wayfinder integration

The Python sidecar at `api/wayfinder/execute.py` is the longer-term home for strategy execution. It would replace the per-step branches in `/api/plan/execute-step` with a single dispatch to `wayfinder_paths.strategies.<name>.deposit(...)`.

What's blocking:

1. **Wayfinder's wallet adapter** doesn't natively understand Privy app-owned wallets. Wayfinder's `WalletClient.list_wallets` pattern expects an OpenCode instance id, not a Privy walletId. Either patch the adapter or write a thin wrapper that translates `{walletId, caip2, transaction}` from the Next.js side into Wayfinder's transaction format and signs via `privy.walletApi.ethereum.sendTransaction` directly.
2. **Strategy-to-profile mapping** — Wayfinder ships 7 strategies; our 5 profiles need ~12 composed strategy invocations. Decide one-strategy-per-profile vs. multi-strategy composition before wiring.
3. **Chain coverage** — Wayfinder strategies are pinned to specific chains (mostly Base, HyperEVM, Hyperliquid L1). Profile splits like "USDC on Base + stETH on Ethereum" require either bridging or per-leg routing.

## Open issues / TODOs

- **Persistence**: `lib/wallet-registry.ts` uses an in-process Map for the userId → walletId mapping. Cold starts in different Vercel regions will mis-provision a second wallet. Replace with Vercel KV / Upstash Redis / Neon Postgres (Vercel Marketplace integration). See `vercel:vercel-storage` skill for options.
- **Approval reuse**: every plan currently emits a fresh `approve` for each Aave step. We should check existing allowance via `IERC20.allowance` and skip the approve when it's already infinite.
- **Slippage**: any swap step needs an oracle-anchored `minAmountOut` for safety. Hardcode a 1% bound for the first cut; expose as a setting later.
- **Receipt confirmation**: `walletApi.ethereum.sendTransaction` returns once Privy broadcasts. We don't wait for confirmation. For accurate "DONE" status, poll `eth_getTransactionReceipt` on the chain RPC after.
- **Per-user policies**: Privy supports wallet policies (`createPolicy`) that constrain which contracts the server can call. For production, the server wallet should be policy-bound to only the venues in the user's profile — see Privy `/controls/policies/*` docs.

## Test it locally

```bash
pnpm dev
```

Then in the app:
1. CONNECT (Privy login)
2. Pick risk 10 (Stable Lender) so 100% goes to Aave
3. EXECUTE_PLAN → enter `1` USDC → BUILD PLAN
4. SIGN & EXECUTE
5. Embedded-wallet popup for the funding USDC transfer
6. Server signs approve + supply automatically
7. Three Basescan links appear

You'll need Base USDC + a tiny bit of ETH in your embedded wallet for the first signed step.
