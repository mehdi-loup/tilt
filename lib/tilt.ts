// Tilt — shared strategy data + allocation math
// Risk r is 0..100 and maps to one of five discrete strategy profiles.

export type AssetKey =
  | "LEND"
  | "SPOT"
  | "LST"
  | "DEFI"
  | "YIELD"
  | "RESTAKE"
  | "MEME"
  | "PERP";

export interface AssetMeta {
  name: string;
  cat: string;
  color: string;
}

export const ASSETS: Record<AssetKey, AssetMeta> = {
  LEND: { name: "Stable Lending", cat: "Stablecoin yield", color: "#4FB286" },
  SPOT: { name: "BTC / ETH / SOL", cat: "Blue-chip spot", color: "#6B7DD8" },
  LST: { name: "Liquid Staking", cat: "Staked majors", color: "#3F6FB8" },
  DEFI: { name: "DeFi Tokens", cat: "Protocol exposure", color: "#E0A458" },
  YIELD: { name: "Yield Trading", cat: "Structured yield", color: "#C77B47" },
  RESTAKE: { name: "Restaking", cat: "Compounded yield", color: "#A0639A" },
  MEME: { name: "Memecoins", cat: "High beta", color: "#B5485B" },
  PERP: { name: "Perps", cat: "Leveraged", color: "#FF6B4A" },
};

export const ASSET_ORDER: AssetKey[] = [
  "LEND",
  "SPOT",
  "LST",
  "DEFI",
  "YIELD",
  "RESTAKE",
  "MEME",
  "PERP",
];

type Allocation = Record<AssetKey, number>;

const clampRisk = (risk: number) => Math.max(0, Math.min(100, risk));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export type PlatformCategory =
  | "Stablecoin lending"
  | "Blue-chip spot"
  | "Liquid staking"
  | "DeFi liquidity"
  | "Yield trading"
  | "Restaking"
  | "Solana DeFi"
  | "Memecoin execution"
  | "Perpetuals";

export interface PlatformTarget {
  name: string;
  category: PlatformCategory;
  networks: string[];
  instruments: string[];
  role: string;
}

type AllocationTargetMap = Partial<Record<AssetKey, PlatformTarget[]>>;

type PlatformKey =
  | "aaveV3"
  | "morphoBlue"
  | "sparkLend"
  | "compoundV3"
  | "lido"
  | "rocketPool"
  | "etherFi"
  | "uniswap"
  | "curve"
  | "balancer"
  | "pendle"
  | "jito"
  | "eigenLayer"
  | "renzo"
  | "kelp"
  | "kamino"
  | "jupiter"
  | "raydium"
  | "aerodrome"
  | "hyperliquid"
  | "jupiterPerps"
  | "gmx"
  | "dydx"
  | "lighter"
  | "pumpFun"
  | "meteora";

const TARGETS: Record<PlatformKey, PlatformTarget> = {
  aaveV3: {
    name: "Aave V3",
    category: "Stablecoin lending",
    networks: ["Ethereum", "Base", "Arbitrum"],
    instruments: ["USDC", "USDT", "DAI"],
    role: "Primary stablecoin lending market.",
  },
  morphoBlue: {
    name: "Morpho Blue",
    category: "Stablecoin lending",
    networks: ["Ethereum", "Base"],
    instruments: ["Curated USDC vaults", "Curated USDT vaults"],
    role: "Isolated stablecoin lending through curated vaults.",
  },
  sparkLend: {
    name: "SparkLend",
    category: "Stablecoin lending",
    networks: ["Ethereum"],
    instruments: ["USDC", "DAI", "USDS"],
    role: "Sky-aligned stablecoin lending and reserve yield.",
  },
  compoundV3: {
    name: "Compound V3",
    category: "Stablecoin lending",
    networks: ["Ethereum", "Base", "Arbitrum"],
    instruments: ["USDC", "USDT"],
    role: "Secondary stablecoin lending venue.",
  },
  lido: {
    name: "Lido",
    category: "Liquid staking",
    networks: ["Ethereum"],
    instruments: ["stETH", "wstETH"],
    role: "Core ETH liquid staking exposure.",
  },
  rocketPool: {
    name: "Rocket Pool",
    category: "Liquid staking",
    networks: ["Ethereum"],
    instruments: ["rETH"],
    role: "Decentralized ETH liquid staking exposure.",
  },
  etherFi: {
    name: "ether.fi",
    category: "Restaking",
    networks: ["Ethereum"],
    instruments: ["eETH", "weETH"],
    role: "Liquid restaking and higher-yield ETH exposure.",
  },
  uniswap: {
    name: "Uniswap",
    category: "DeFi liquidity",
    networks: ["Ethereum", "Base", "Arbitrum"],
    instruments: ["ETH", "WBTC", "DeFi majors", "Memecoins"],
    role: "Primary EVM spot and liquidity venue.",
  },
  curve: {
    name: "Curve",
    category: "DeFi liquidity",
    networks: ["Ethereum", "Arbitrum", "Base"],
    instruments: ["Stablecoins", "LST pairs"],
    role: "Stablecoin and LST liquidity routing.",
  },
  balancer: {
    name: "Balancer",
    category: "DeFi liquidity",
    networks: ["Ethereum", "Arbitrum", "Base"],
    instruments: ["Weighted DeFi pools", "LST pools"],
    role: "Diversified liquidity and index-style DeFi exposure.",
  },
  pendle: {
    name: "Pendle",
    category: "Yield trading",
    networks: ["Ethereum", "Arbitrum"],
    instruments: ["Fixed yield", "LST yield", "LRT yield"],
    role: "Structured yield and rate exposure.",
  },
  jito: {
    name: "Jito",
    category: "Solana DeFi",
    networks: ["Solana"],
    instruments: ["JitoSOL"],
    role: "Solana liquid staking exposure.",
  },
  eigenLayer: {
    name: "EigenLayer",
    category: "Restaking",
    networks: ["Ethereum"],
    instruments: ["Restaked ETH", "AVS exposure"],
    role: "Native restaking exposure.",
  },
  renzo: {
    name: "Renzo",
    category: "Restaking",
    networks: ["Ethereum", "Arbitrum"],
    instruments: ["ezETH"],
    role: "Liquid restaking diversification.",
  },
  kelp: {
    name: "Kelp DAO",
    category: "Restaking",
    networks: ["Ethereum"],
    instruments: ["rsETH"],
    role: "Liquid restaking diversification.",
  },
  kamino: {
    name: "Kamino",
    category: "Solana DeFi",
    networks: ["Solana"],
    instruments: ["SOL", "JitoSOL", "USDC"],
    role: "Solana lending and automated vault exposure.",
  },
  jupiter: {
    name: "Jupiter",
    category: "Solana DeFi",
    networks: ["Solana"],
    instruments: ["SOL", "JUP", "Solana majors", "Memecoins"],
    role: "Primary Solana spot routing and aggregation.",
  },
  raydium: {
    name: "Raydium",
    category: "Memecoin execution",
    networks: ["Solana"],
    instruments: ["BONK", "WIF", "Solana memecoins"],
    role: "Liquid Solana memecoin execution venue.",
  },
  aerodrome: {
    name: "Aerodrome",
    category: "Memecoin execution",
    networks: ["Base"],
    instruments: ["Base majors", "Base memecoins"],
    role: "Base ecosystem liquidity and memecoin execution.",
  },
  hyperliquid: {
    name: "Hyperliquid",
    category: "Perpetuals",
    networks: ["Hyperliquid L1"],
    instruments: ["BTC-PERP", "ETH-PERP", "SOL-PERP", "Majors"],
    role: "Primary on-chain perpetual futures venue.",
  },
  jupiterPerps: {
    name: "Jupiter Perps",
    category: "Perpetuals",
    networks: ["Solana"],
    instruments: ["SOL-PERP", "ETH-PERP", "BTC-PERP"],
    role: "Solana-native perpetual futures venue.",
  },
  gmx: {
    name: "GMX v2",
    category: "Perpetuals",
    networks: ["Arbitrum", "Avalanche"],
    instruments: ["BTC-PERP", "ETH-PERP", "SOL-PERP"],
    role: "Mature peer-to-pool perpetual futures venue.",
  },
  dydx: {
    name: "dYdX v4",
    category: "Perpetuals",
    networks: ["dYdX Chain"],
    instruments: ["BTC-PERP", "ETH-PERP", "SOL-PERP", "Majors"],
    role: "Orderbook perpetual futures diversification.",
  },
  lighter: {
    name: "Lighter",
    category: "Perpetuals",
    networks: ["Ethereum L2"],
    instruments: ["BTC-PERP", "ETH-PERP", "Majors"],
    role: "High-liquidity perp venue with zk-based execution.",
  },
  pumpFun: {
    name: "Pump.fun",
    category: "Memecoin execution",
    networks: ["Solana"],
    instruments: ["New Solana memecoins"],
    role: "Highest-risk launch venue; only for max speculation.",
  },
  meteora: {
    name: "Meteora",
    category: "Memecoin execution",
    networks: ["Solana"],
    instruments: ["Solana memecoin pools"],
    role: "Solana dynamic liquidity pools for high-beta tokens.",
  },
};

export type RiskProfileId =
  | "stable_lender"
  | "conservative_yield"
  | "balanced_defi"
  | "aggressive_growth"
  | "max_speculation";

export interface Profile {
  id: RiskProfileId;
  name: string;
  tag: string;
  tone: string;
  minRisk: number;
  maxRisk: number;
  targetMap: AllocationTargetMap;
  blocked: string[];
}

export const STRATEGY_PROFILES: Profile[] = [
  {
    id: "stable_lender",
    name: "Stable Lender",
    tag: "Low",
    minRisk: 0,
    maxRisk: 20,
    tone: "Capital stays in stablecoin lending only, routed across the top lending venues for depth and resilience.",
    targetMap: {
      LEND: [TARGETS.aaveV3, TARGETS.morphoBlue, TARGETS.sparkLend],
    },
    blocked: ["Volatile spot", "LP positions", "Restaking", "Memecoins", "Perps"],
  },
  {
    id: "conservative_yield",
    name: "Conservative Yield",
    tag: "Cautious",
    minRisk: 21,
    maxRisk: 40,
    tone: "Stablecoin yield remains the anchor, with measured exposure to blue-chip spot and ETH liquid staking.",
    targetMap: {
      LEND: [TARGETS.aaveV3, TARGETS.morphoBlue, TARGETS.sparkLend, TARGETS.compoundV3],
      SPOT: [TARGETS.uniswap],
      LST: [TARGETS.lido, TARGETS.rocketPool],
    },
    blocked: ["Restaking", "Memecoins", "Perps"],
  },
  {
    id: "balanced_defi",
    name: "Balanced DeFi",
    tag: "Moderate",
    minRisk: 41,
    maxRisk: 60,
    tone: "A balanced DeFi mix across stable lending, blue-chip spot, liquid staking, and mature protocol exposure.",
    targetMap: {
      LEND: [TARGETS.aaveV3, TARGETS.morphoBlue, TARGETS.sparkLend, TARGETS.compoundV3],
      SPOT: [TARGETS.uniswap, TARGETS.jupiter],
      LST: [TARGETS.lido, TARGETS.rocketPool, TARGETS.jito],
      DEFI: [TARGETS.uniswap, TARGETS.curve, TARGETS.balancer],
      YIELD: [TARGETS.pendle],
      RESTAKE: [TARGETS.etherFi],
    },
    blocked: ["Memecoins", "Perps"],
  },
  {
    id: "aggressive_growth",
    name: "Aggressive Growth",
    tag: "High",
    minRisk: 61,
    maxRisk: 80,
    tone: "Higher-beta DeFi, Solana ecosystem exposure, and restaking enter the strategy while leverage remains out of scope.",
    targetMap: {
      LEND: [TARGETS.aaveV3, TARGETS.morphoBlue],
      SPOT: [TARGETS.uniswap, TARGETS.jupiter],
      LST: [TARGETS.lido, TARGETS.rocketPool, TARGETS.jito],
      DEFI: [TARGETS.uniswap, TARGETS.aerodrome, TARGETS.kamino, TARGETS.jupiter],
      YIELD: [TARGETS.pendle],
      RESTAKE: [TARGETS.etherFi, TARGETS.eigenLayer, TARGETS.renzo, TARGETS.kelp],
      MEME: [TARGETS.raydium, TARGETS.aerodrome],
    },
    blocked: ["Leveraged perps", "Pre-migration memecoin launches"],
  },
  {
    id: "max_speculation",
    name: "Max Speculation",
    tag: "Extreme",
    minRisk: 81,
    maxRisk: 100,
    tone: "Capital targets liquid memecoins, high-beta spot, and perpetual futures with a small cash buffer for execution.",
    targetMap: {
      LEND: [TARGETS.aaveV3],
      SPOT: [TARGETS.uniswap, TARGETS.jupiter],
      DEFI: [TARGETS.uniswap, TARGETS.jupiter, TARGETS.aerodrome],
      RESTAKE: [TARGETS.etherFi, TARGETS.eigenLayer],
      MEME: [
        TARGETS.uniswap,
        TARGETS.raydium,
        TARGETS.jupiter,
        TARGETS.aerodrome,
        TARGETS.pumpFun,
        TARGETS.meteora,
      ],
      PERP: [TARGETS.hyperliquid, TARGETS.jupiterPerps, TARGETS.gmx, TARGETS.dydx, TARGETS.lighter],
    },
    blocked: [],
  },
];

const PROFILE_ALLOCATIONS: Record<RiskProfileId, Allocation> = {
  stable_lender: { LEND: 100, SPOT: 0, LST: 0, DEFI: 0, YIELD: 0, RESTAKE: 0, MEME: 0, PERP: 0 },
  conservative_yield: { LEND: 65, SPOT: 25, LST: 10, DEFI: 0, YIELD: 0, RESTAKE: 0, MEME: 0, PERP: 0 },
  balanced_defi: { LEND: 35, SPOT: 25, LST: 15, DEFI: 10, YIELD: 10, RESTAKE: 5, MEME: 0, PERP: 0 },
  aggressive_growth: { LEND: 15, SPOT: 20, LST: 10, DEFI: 20, YIELD: 10, RESTAKE: 20, MEME: 5, PERP: 0 },
  max_speculation: { LEND: 5, SPOT: 10, LST: 0, DEFI: 10, YIELD: 0, RESTAKE: 10, MEME: 35, PERP: 30 },
};

export function profileFor(risk: number): Profile {
  const r = clampRisk(risk);
  return STRATEGY_PROFILES.find((p) => r >= p.minRisk && r <= p.maxRisk) ?? STRATEGY_PROFILES[0];
}

export function allocationFor(risk: number): Allocation {
  const allocation = PROFILE_ALLOCATIONS[profileFor(risk).id];
  const result = {} as Allocation;
  for (const k of ASSET_ORDER) {
    result[k] = allocation[k];
  }
  return result;
}

export interface AllocationPosition {
  key: AssetKey;
  weight: number;
  targets: PlatformTarget[];
}

export function allocationPositionsFor(risk: number): AllocationPosition[] {
  const profile = profileFor(risk);
  const allocation = PROFILE_ALLOCATIONS[profile.id];
  return ASSET_ORDER.map((key) => ({
    key,
    weight: allocation[key],
    targets: profile.targetMap[key] ?? [],
  })).filter((position) => position.weight > 0);
}

export interface Projection {
  expected: number;
  upside: number;
  downside: number;
  vol: number;
}

export function projection(risk: number): Projection {
  const r = clampRisk(risk) / 100;
  const expected = lerp(6, 32, r);
  const upside = expected + lerp(4, 28, r);
  const downside = lerp(-3, -48, r);
  const vol = lerp(8, 62, r);
  return {
    expected: Math.round(expected),
    upside: Math.round(upside),
    downside: Math.round(downside),
    vol: Math.round(vol),
  };
}

export interface RiskNote {
  label: string;
  value: string;
  sub: string;
}

export function riskNotes(risk: number): RiskNote[] {
  const proj = projection(risk);
  return [
    { label: "Expected drawdown", value: `${Math.abs(proj.downside)}%`, sub: "12-mo, p10 case" },
    { label: "Annualized vol", value: `${proj.vol}%`, sub: "historical, rolling" },
    { label: "Stable lending", value: `${allocationFor(risk).LEND}%`, sub: "target allocation" },
  ];
}

// ─── Theme math — sRGB interpolation, blue → red ──────────────
const COLOR_STOPS: [number, number, number][] = [
  [77, 142, 255],
  [77, 212, 255],
  [200, 245, 107],
  [255, 160, 64],
  [255, 77, 60],
];

type RGB = [number, number, number];

function lerpColor(risk: number): RGB {
  const t = clampRisk(risk) / 100;
  const f = t * (COLOR_STOPS.length - 1);
  const i = Math.min(COLOR_STOPS.length - 2, Math.floor(f));
  const k = f - i;
  const a = COLOR_STOPS[i];
  const b = COLOR_STOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

const rgb = ([r, g, b]: RGB, a?: number) =>
  a == null ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
const mul = ([r, g, b]: RGB, f: number): RGB => [
  Math.round(r * f),
  Math.round(g * f),
  Math.round(b * f),
];
// Blend toward bg (#0b0d10) — keeps very dark tints visible at all hues
// without collapsing reds to black.
const tint = ([r, g, b]: RGB, i: number): RGB => [
  Math.round(11 + (r - 11) * i),
  Math.round(13 + (g - 13) * i),
  Math.round(16 + (b - 16) * i),
];

export interface Theme {
  accent: string;
  accentDim: string;
  accentGlow: string;
  arcDeep: string;
  innerBg: string;
  outerBg1: string;
  outerBg2: string;
  bodyTint: string;
  pulsePeriod: string;
  pulseLo: string;
  pulseHi: string;
  shimmerPeriod: string;
  haloBlur: number;
  haloOpacity: number;
  ink: string;
  sub: string;
  dim: string;
  dim2: string;
}

const INK = "#f0efe9";
const SUB = "rgba(240,239,233,0.55)";
const DIM = "rgba(240,239,233,0.12)";
const DIM2 = "rgba(240,239,233,0.22)";

export function themeForRisk(risk: number): Theme {
  const t = clampRisk(risk) / 100;
  const c = lerpColor(risk);

  const pulsePeriod = (5 - t * 3.6).toFixed(2);
  const pulseLo = (0.2 + t * 0.2).toFixed(2);
  const pulseHi = (0.55 + t * 0.4).toFixed(2);
  const shimmerPeriod = (28 - t * 22).toFixed(1);
  const haloBlur = Math.round(60 + t * 80);
  const haloOpacity = 4 + t * 16;

  return {
    accent: rgb(c),
    accentDim: rgb(c, 0.22),
    accentGlow: rgb(c, 0.45),
    arcDeep: rgb(mul(c, 0.5)),
    innerBg: rgb(tint(c, 0.06)),
    outerBg1: rgb(tint(c, 0.14)),
    outerBg2: rgb(tint(c, 0.04)),
    bodyTint: rgb(tint(c, 0.08)),
    pulsePeriod,
    pulseLo,
    pulseHi,
    shimmerPeriod,
    haloBlur,
    haloOpacity,
    ink: INK,
    sub: SUB,
    dim: DIM,
    dim2: DIM2,
  };
}
