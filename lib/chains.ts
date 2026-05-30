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

/** Public read RPCs for the chains funding legs can execute on. Used only to
 * poll receipts / balances client-side — sending goes through Privy. Chains
 * not listed fall back to an optimistic wait; the Base USDC settlement gate
 * backstops cross-chain legs. */
export const RPC_URLS: Record<number, string> = {
  1: "https://eth.llamarpc.com",
  10: "https://mainnet.optimism.io",
  56: "https://bsc-dataseed.binance.org",
  137: "https://polygon-rpc.com",
  5000: "https://rpc.mantle.xyz",
  8453: "https://mainnet.base.org",
  42161: "https://arb1.arbitrum.io/rpc",
  43114: "https://api.avax.network/ext/bc/C/rpc",
};

/** Block explorers for the funding chains, for tx links. */
export const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  10: "https://optimistic.etherscan.io",
  56: "https://bscscan.com",
  137: "https://polygonscan.com",
  5000: "https://explorer.mantle.xyz",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  43114: "https://snowtrace.io",
};

export function explorerTxUrl(chainId: number, hash: string): string {
  return `${EXPLORERS[chainId] ?? EXPLORERS[FUNDING_CHAIN_ID]}/tx/${hash}`;
}

export const TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex,
} as const;

export const USDC_DECIMALS = 6;

/** Convert a USD-denominated decimal (e.g. 250) into USDC base units. */
export function usdcUnits(amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
}
