// Chain config for transaction plan execution.
//
// First-ship target: Base mainnet (chain id 8453). USDC is the base
// funding currency; Aave V3 is the live deposit venue. Other chains and
// tokens listed for type completeness as we expand.
//
// Note: we intentionally hardcode the chain id literal rather than
// importing `viem/chains.base` — the chains module pulls every chain
// definition (Tempo et al.) into whatever bundle imports it, which
// would balloon the client bundle.

import type { Hex } from "viem";

export const FUNDING_CHAIN_ID = 8453 as const;
export const FUNDING_CAIP2 = `eip155:8453` as const;

// Token addresses on Base mainnet.
export const TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex,
  WETH: "0x4200000000000000000000000000000000000006" as Hex,
} as const;

// Aave V3 on Base.
//   Pool:            https://aave.com/docs/resources/addresses
//   Reference impl:  https://github.com/aave/aave-v3-core
export const AAVE_V3_BASE = {
  pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Hex,
  poolDataProvider: "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad" as Hex,
} as const;

export const USDC_DECIMALS = 6;

/** Convert a USD-denominated decimal (e.g. 250) into USDC base units (e.g. 250_000_000n). */
export function usdcUnits(amountUsd: number): bigint {
  // Multiply by 10^USDC_DECIMALS = 1e6, rounding to integer cents-of-cents.
  return BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
}
