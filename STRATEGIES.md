# Tilt — Risk Profiles & Wayfinder Strategy Compositions

Source of truth: [`lib/profile-strategies.ts`](./lib/profile-strategies.ts) (TS mirror) and [`api/wayfinder/execute.py`](./api/wayfinder/execute.py) (Python dispatch).

Strategies are **not implemented in this repo.** They live in [WayfinderFoundation/wayfinder-paths-sdk](https://github.com/WayfinderFoundation/wayfinder-paths-sdk). Each profile invokes one (eventually a composition of) Wayfinder strategy classes. Wayfinder handles pool selection, slippage, rebalancing, and multi-tx routing internally — we just pick which strategy.

The dial maps a 0–100 risk score to one of five discrete profiles.

## Profiles

| Risk band | Profile | Wayfinder strategies | Chain(s) | Status |
| --- | --- | --- | --- | ---: |
| 0–20 | Stable Lender | `stablecoin_yield_strategy` | Base | **LIVE** |
| 21–40 | Conservative Yield | `stablecoin_yield_strategy` + `multi_vault_split_strategy` | Base + HyperEVM | STUB |
| 41–60 | Balanced DeFi | `stablecoin_yield` + `moonwell_wsteth_loop` + `multi_vault_split` | Base + HyperEVM | STUB |
| 61–80 | Aggressive Growth | `moonwell_wsteth_loop` + `basis_trading` + `projectx_thbill_usdc` | Base + Hyperliquid + HyperEVM | STUB |
| 81–100 | Max Speculation | `moonwell_wsteth_loop` + `basis_trading` + `boros_hype` | Multi-chain | STUB |

## What Wayfinder strategies do

| Strategy | Chain | What it actually does |
| --- | --- | --- |
| `stablecoin_yield_strategy` | Base | Scans Base DeFi pools (Aave, Morpho, etc.), supplies USDC to the highest-APY low-risk venue, rebalances when better opportunities emerge. |
| `multi_vault_split_strategy` | Multi-chain (HyperEVM core) | Diversifies USDC across HLP, Boros, and Avantis vaults. |
| `moonwell_wsteth_loop_strategy` | Base | Levered wstETH carry — supplies wstETH on Moonwell, borrows USDC, swaps to wstETH, repeats. ETH-correlated yield. |
| `basis_trading_strategy` | Hyperliquid | Delta-neutral funding-rate capture — long spot, short perp on Hyperliquid. |
| `projectx_thbill_usdc_strategy` | HyperEVM | THBILL/USDC concentrated LP with auto-compounding. |
| `boros_hype_strategy` | Multi-chain | HYPE yield via Boros with Hyperliquid hedging. |
| `hyperlend_stable_yield_strategy` | HyperEVM | Stablecoin lending allocator on HyperLend (currently unused — overlaps with `multi_vault_split`). |

## What "STUB" means for the 4 non-Stable profiles

Wayfinder's strategies are **chain-pinned**. Most of them live on HyperEVM or Hyperliquid, but our funding currency lands on Base. To activate Conservative Yield → Max Speculation we need two pieces of plumbing **not yet built**:

1. **Cross-chain bridging** — USDC has to move from Base to HyperEVM/Hyperliquid before those strategies can deposit. Candidate routes: Circle's native CCTP, Across, deBridge. Each adds ~1–15 minutes of finality.
2. **Composition runner** — When a profile invokes multiple strategies (e.g., 70% `stablecoin_yield` + 30% `multi_vault_split`), the sidecar needs to split the amount, dispatch each strategy in parallel or sequence, and reconcile results into one combined status.

`lib/profile-strategies.ts` already declares the intended compositions with `status: "stub"` and a per-entry `pendingNote` explaining what's missing. The Plan UI surfaces these honestly with `STUB` badges.

## Verifying coverage

The Python sidecar exposes `GET /api/wayfinder/execute` which returns:

```json
{
  "ok": true,
  "service": "wayfinder-executor",
  "profiles": ["stable_lender", "conservative_yield", ...],
  "wayfinderInstalled": true
}
```

If `wayfinderInstalled` is false, the Wayfinder package isn't in the deployed Python lambda — check `api/wayfinder/requirements.txt` and Vercel's Python build logs.
