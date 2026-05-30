// Profile → Wayfinder-strategy mapping (TS mirror of the Python side).
//
// Each profile invokes one or more Wayfinder strategies.
// Wayfinder is the source of truth for the actual deposit logic, slippage,
// pool selection, etc. — we just declare which strategy and how much.

import type { RiskProfileId } from "./tilt";

export interface StrategyInvocation {
  /** Wayfinder strategy class name (matches api/wayfinder/execute.py). */
  strategyName: string;
  /** Human-readable label for the UI row. */
  label: string;
  /** Where this strategy runs. */
  chain: "base" | "hyperEVM" | "hyperliquid" | "multi";
  /** Minimum USDC to invoke. */
  minAmountUsd: number;
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
        strategyName: "stablecoin_yield_strategy",
        label: "Stablecoin Yield · Base USDC",
        chain: "base",
        minAmountUsd: 2,
        status: "live",
      },
    ],
  },
  conservative_yield: {
    steps: [
      {
        strategyName: "stablecoin_yield_strategy",
        label: "Stablecoin Yield · Base USDC",
        chain: "base",
        minAmountUsd: 2,
        status: "live",
      },
      {
        strategyName: "multi_vault_split_strategy",
        label: "Multi-Vault Split · HyperEVM",
        chain: "hyperEVM",
        minAmountUsd: 10,
        status: "stub",
        pendingNote: "Needs target-chain USDC/gas funding before deposit.",
      },
    ],
  },
  balanced_defi: {
    steps: [
      {
        strategyName: "stablecoin_yield_strategy",
        label: "Stablecoin Yield · Base USDC",
        chain: "base",
        minAmountUsd: 2,
        status: "live",
      },
      {
        strategyName: "moonwell_wsteth_loop_strategy",
        label: "Moonwell wstETH Loop · Base",
        chain: "base",
        minAmountUsd: 10,
        status: "live",
      },
      {
        strategyName: "multi_vault_split_strategy",
        label: "Multi-Vault Split · HyperEVM",
        chain: "hyperEVM",
        minAmountUsd: 10,
        status: "stub",
        pendingNote: "Needs target-chain USDC/gas funding before deposit.",
      },
    ],
  },
  aggressive_growth: {
    steps: [
      {
        strategyName: "moonwell_wsteth_loop_strategy",
        label: "Moonwell wstETH Loop · Base",
        chain: "base",
        minAmountUsd: 10,
        status: "live",
      },
      {
        strategyName: "basis_trading_strategy",
        label: "Basis Trading · Hyperliquid",
        chain: "hyperliquid",
        minAmountUsd: 25,
        status: "stub",
        pendingNote: "Needs Arbitrum/Hyperliquid funding before deposit.",
      },
      {
        strategyName: "projectx_thbill_usdc_strategy",
        label: "ProjectX THBILL/USDC · HyperEVM",
        chain: "hyperEVM",
        minAmountUsd: 25,
        status: "stub",
        pendingNote: "Needs HyperEVM USDC/gas funding before deposit.",
      },
    ],
  },
  max_speculation: {
    steps: [
      {
        strategyName: "moonwell_wsteth_loop_strategy",
        label: "Moonwell wstETH Loop · Base",
        chain: "base",
        minAmountUsd: 10,
        status: "live",
      },
      {
        strategyName: "basis_trading_strategy",
        label: "Basis Trading · Hyperliquid",
        chain: "hyperliquid",
        minAmountUsd: 25,
        status: "stub",
        pendingNote: "Needs Arbitrum/Hyperliquid funding before deposit.",
      },
      {
        strategyName: "boros_hype_strategy",
        label: "Boros HYPE · multi-chain",
        chain: "multi",
        minAmountUsd: 50,
        status: "stub",
        pendingNote: "Needs multi-chain USDC/gas funding before deposit.",
      },
    ],
  },
};

export function isProfileExecutable(profileId: RiskProfileId): boolean {
  const steps = PROFILE_COMPOSITION[profileId].steps;
  return steps.length > 0 && steps.every((step) => step.status === "live");
}

export function minimumAmountUsd(profileId: RiskProfileId): number {
  const liveSteps = PROFILE_COMPOSITION[profileId].steps.filter((step) => step.status === "live");
  if (liveSteps.length === 0) return 1;
  return Math.max(...liveSteps.map((step) => step.minAmountUsd));
}
