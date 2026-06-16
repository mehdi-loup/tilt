// Profile → Wayfinder-strategy mapping (TS mirror of the Python side).
//
// Each profile invokes one or more Wayfinder strategies.
// Wayfinder is the source of truth for the actual deposit logic, slippage,
// pool selection, etc. — we just declare which strategy and how much.
//
// Strategies that need funds on another chain (Arbitrum, HyperEVM) are still
// funded on Base: the sidecar self-bridges the server wallet's Base USDC to
// the target chain (BRAP, Privy-signed) before the strategy runs.

import type { RiskProfileId } from "./tilt";

export interface StrategyInvocation {
  /** Wayfinder strategy class name (matches api/wayfinder/execute.py). */
  strategyName: string;
  /** Human-readable label for the UI row. */
  label: string;
  /** Where this strategy runs. */
  chain: "base" | "hyperEVM" | "hyperliquid" | "multi";
  /** Live = wired through Wayfinder; stub = todo. */
  status: "live" | "stub";
  /** Why a stub step isn't live yet. */
  pendingNote?: string;
}

export interface ProfileComposition {
  steps: StrategyInvocation[];
}

export const PROFILE_COMPOSITION: Record<RiskProfileId, ProfileComposition> = {
  stable_lender: {
    steps: [
      {
        strategyName: "stablecoin_yield_rotator",
        label: "Stablecoin Yield Rotator · Base USDC",
        chain: "base",
        status: "live",
      },
    ],
  },
  conservative_yield: {
    steps: [
      {
        strategyName: "stablecoin_yield_rotator",
        label: "Stablecoin Yield Rotator · Base USDC",
        chain: "base",
        status: "live",
      },
      {
        strategyName: "multi_vault_split_strategy",
        label: "Multi-Vault Split · HLP/Boros/Avantis",
        chain: "multi",
        status: "live",
      },
    ],
  },
  balanced_defi: {
    steps: [
      {
        strategyName: "stablecoin_yield_rotator",
        label: "Stablecoin Yield Rotator · Base USDC",
        chain: "base",
        status: "live",
      },
      {
        strategyName: "moonwell_wsteth_loop_strategy",
        label: "Moonwell wstETH Loop · Base",
        chain: "base",
        status: "live",
      },
      {
        strategyName: "multi_vault_split_strategy",
        label: "Multi-Vault Split · HLP/Boros/Avantis",
        chain: "multi",
        status: "live",
      },
    ],
  },
  aggressive_growth: {
    steps: [
      {
        strategyName: "moonwell_wsteth_loop_strategy",
        label: "Moonwell wstETH Loop · Base",
        chain: "base",
        status: "live",
      },
      {
        strategyName: "basis_trading_strategy",
        label: "Basis Trading · Hyperliquid",
        chain: "hyperliquid",
        status: "live",
      },
      {
        strategyName: "projectx_thbill_usdc_strategy",
        label: "ProjectX THBILL/USDC · HyperEVM",
        chain: "hyperEVM",
        status: "live",
      },
    ],
  },
  max_speculation: {
    steps: [
      {
        strategyName: "moonwell_wsteth_loop_strategy",
        label: "Moonwell wstETH Loop · Base",
        chain: "base",
        status: "live",
      },
      {
        strategyName: "basis_trading_strategy",
        label: "Basis Trading · Hyperliquid",
        chain: "hyperliquid",
        status: "live",
      },
      {
        strategyName: "boros_hype_strategy",
        label: "Boros HYPE · multi-chain",
        chain: "multi",
        status: "live",
      },
    ],
  },
};

export function isProfileExecutable(profileId: RiskProfileId): boolean {
  const steps = PROFILE_COMPOSITION[profileId].steps;
  return steps.length > 0 && steps.every((step) => step.status === "live");
}
