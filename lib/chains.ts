// Chain config for the funding step.
//
// All venue-specific addresses (Aave, Uniswap, Pendle, etc.) live in
// Wayfinder. We only need the funding chain + USDC for the embedded
// wallet's transfer step.
//
// Hardcoded chain id literal — we deliberately don't import viem/chains
// so the client bundle stays thin.

import type { Hex } from "viem";

export const FUNDING_CHAIN_ID = 8453 as const;
export const FUNDING_CAIP2 = `eip155:8453` as const;

export const TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex,
} as const;

export const USDC_DECIMALS = 6;

/** Convert a USD-denominated decimal (e.g. 250) into USDC base units. */
export function usdcUnits(amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
}
