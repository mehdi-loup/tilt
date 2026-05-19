// Client-safe rates types & lookup tables. No server-only imports — safe to
// pull from React components. The actual fetch/cache logic lives in lib/rates.ts.

export interface PlatformRate {
  /** Spot APY today, TVL-weighted across matching pools. Percent (e.g. 4.32). */
  apy: number | null;
  /** 30-day mean APY, TVL-weighted. Percent. */
  apyMean30d: number | null;
  /** Number of pools that contributed to the blend. */
  sampleSize: number;
  /** Sum of TVL in matching pools. */
  totalTvlUsd: number;
}

// PlatformKey → DefiLlama `project` slug(s). Pools matching ANY slug are
// blended together for that platform.
export const PROJECT_SLUGS = {
  aaveV3: ["aave-v3"],
  morphoBlue: ["morpho-blue"],
  sparkLend: ["sparklend", "spark-savings"],
  compoundV3: ["compound-v3"],
  lido: ["lido"],
  rocketPool: ["rocket-pool"],
  etherFi: ["ether.fi-stake", "ether.fi-liquid"],
  uniswap: ["uniswap-v3", "uniswap-v4"],
  curve: ["curve-dex"],
  balancer: ["balancer-v2", "balancer-v3"],
  pendle: ["pendle"],
  jito: ["jito-liquid-staking"],
  eigenLayer: ["eigenlayer"],
  renzo: ["renzo"],
  kelp: ["kelp"],
  kamino: ["kamino-lend", "kamino-liquidity"],
  jupiter: ["jupiter-staked-sol", "jupiter-lend"],
  raydium: ["raydium-amm"],
  aerodrome: ["aerodrome-v1", "aerodrome-slipstream"],
  // Perps venues don't have lending APY; they typically aren't in /pools.
  // We list them anyway so the loop is total — they'll resolve to null.
  hyperliquid: ["hyperliquid"],
  jupiterPerps: ["jupiter-perpetual"],
  gmx: ["gmx-v2-perps"],
  dydx: ["dydx-v4"],
  lighter: ["lighter"],
  pumpFun: ["pump.fun"],
  meteora: ["meteora-dlmm"],
} as const;

export type PlatformRateKey = keyof typeof PROJECT_SLUGS;

// Lookup from PlatformTarget.name (defined in lib/tilt.ts) back to the
// PROJECT_SLUGS key. Lets the UI find a rate from the human display name.
export const PLATFORM_NAME_TO_KEY: Record<string, PlatformRateKey> = {
  "Aave V3": "aaveV3",
  "Morpho Blue": "morphoBlue",
  SparkLend: "sparkLend",
  "Compound V3": "compoundV3",
  Lido: "lido",
  "Rocket Pool": "rocketPool",
  "ether.fi": "etherFi",
  Uniswap: "uniswap",
  Curve: "curve",
  Balancer: "balancer",
  Pendle: "pendle",
  Jito: "jito",
  EigenLayer: "eigenLayer",
  Renzo: "renzo",
  "Kelp DAO": "kelp",
  Kamino: "kamino",
  Jupiter: "jupiter",
  Raydium: "raydium",
  Aerodrome: "aerodrome",
  Hyperliquid: "hyperliquid",
  "Jupiter Perps": "jupiterPerps",
  "GMX v2": "gmx",
  "dYdX v4": "dydx",
  Lighter: "lighter",
  "Pump.fun": "pumpFun",
  Meteora: "meteora",
};
