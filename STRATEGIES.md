# Tilt — Risk Profiles & Wayfinder Strategy Compositions

Source of truth: [`lib/profile-strategies.ts`](./lib/profile-strategies.ts) (TS mirror) and [`api/wayfinder/execute.py`](./api/wayfinder/execute.py) (Python dispatch).

Strategies are **not implemented in this repo.** They live in [WayfinderFoundation/wayfinder-paths-sdk](https://github.com/WayfinderFoundation/wayfinder-paths-sdk). Each profile invokes one or more Wayfinder strategy classes. Wayfinder handles pool selection, slippage, rebalancing, and multi-tx routing internally — we pick which strategy and run the strategy lifecycle.

The dial maps a 0–100 risk score to one of five discrete profiles.

## Profiles

| Risk band | Profile | Wayfinder strategies | Chain(s) | Status |
| --- | --- | --- | --- | ---: |
| 0–20 | Stable Lender | `stablecoin_yield_rotator` | Base | **LIVE** |
| 21–40 | Conservative Yield | `stablecoin_yield_rotator` + `multi_vault_split_strategy` | Base + Arbitrum/HL | **LIVE** |
| 41–60 | Balanced DeFi | `stablecoin_yield_rotator` + `moonwell_wsteth_loop_strategy` + `multi_vault_split_strategy` | Base + Arbitrum/HL | **LIVE** |
| 61–80 | Aggressive Growth | `moonwell_wsteth_loop_strategy` + `basis_trading_strategy` + `projectx_thbill_usdc_strategy` | Base + Hyperliquid + HyperEVM | **LIVE** |
| 81–100 | Max Speculation | `moonwell_wsteth_loop_strategy` + `basis_trading_strategy` + `boros_hype_strategy` | Multi-chain | **LIVE** |

All profiles fund on Base only; for non-Base strategies the sidecar
self-bridges the server wallet's Base USDC to the target chain (Arbitrum or
HyperEVM, plus a native gas float) via BRAP before the strategy runs —
signed by the same Privy server wallet, no user prompts.

## What Wayfinder strategies do

| Strategy | Chain | What it actually does |
| --- | --- | --- |
| `stablecoin_yield_rotator` | Base | Wayfinder *path* (vendored in `api/wayfinder/rotator/`): scans Aave V3, Morpho, Euler V2, and Moonwell with TVL/utilization/cap-headroom guards, lends USDC to the top-ranked venue; supports quote-gated rotation, status, and withdraw actions (deposit wired today). |
| `multi_vault_split_strategy` | Multi-chain (HyperEVM core) | Diversifies USDC across HLP, Boros, and Avantis vaults. |
| `moonwell_wsteth_loop_strategy` | Base | Levered wstETH carry — supplies wstETH on Moonwell, borrows USDC, swaps to wstETH, repeats. ETH-correlated yield. |
| `basis_trading_strategy` | Hyperliquid | Delta-neutral funding-rate capture — long spot, short perp on Hyperliquid. |
| `projectx_thbill_usdc_strategy` | HyperEVM | THBILL/USDC concentrated LP with auto-compounding. |
| `boros_hype_strategy` | Multi-chain | HYPE yield via Boros with Hyperliquid hedging. |
| `hyperlend_stable_yield_strategy` | HyperEVM | Stablecoin lending allocator on HyperLend (currently unused — overlaps with `multi_vault_split`). |

## What "PREVIEW" means for the 4 non-Stable profiles

Wayfinder's strategies are **chain-pinned**. Stablecoin Yield and Moonwell wstETH Loop are wired on Base. Most of the remaining strategies expect USDC and native gas on Arbitrum, HyperEVM, or Hyperliquid, but our funding flow currently lands on Base. To activate Conservative Yield → Max Speculation as complete executable profiles we need target-chain funding **not yet built**:

1. **Target-chain funding** — USDC and native gas have to move from Base to the strategy's required chain before those strategies can deposit. Candidate routes: Circle's native CCTP, Across, deBridge, or Wayfinder BRAP routes where they support the exact target.
2. **Profile-level reconciliation** — When a profile invokes multiple strategies, the UI and sidecar need to reconcile partial failures, receipts, and recovery paths into one combined status.

`lib/profile-strategies.ts` marks Base-only steps as `live` and target-chain steps as `stub` with a per-entry `pendingNote` explaining what's missing. The Plan UI surfaces incomplete profiles as preview-only.

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
