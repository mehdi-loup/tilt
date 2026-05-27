// Strategy → ordered execution plan.
//
// A Plan is a sequence of Steps that, when run in order, deploy the user's
// chosen risk profile onto their server wallet. Steps are typed by `kind`:
//
//   - `fund`          — user signs from their embedded wallet (the only
//                       step that requires a wallet popup). Sends USDC
//                       from embedded → server wallet.
//   - `approve` etc.  — server wallet signs via Privy walletApi. No popup.
//
// `status: "live"` steps have working calldata builders today; `status:
// "stub"` steps are mapped out so the UI can render the plan but the
// executor returns a placeholder until the venue-specific integration
// (DEX router, LST mint, restake deposit, etc.) is wired.

import { profileFor, type RiskProfileId } from "./tilt";
import { FUNDING_CHAIN_ID, TOKENS, AAVE_V3_BASE } from "./chains";
import { buildErc20Transfer } from "./tx-builders";
import type { Hex } from "viem";

export type PlanStepKind =
  | "fund"
  | "approve"
  | "supply"
  | "swap"
  | "stake"
  | "restake"
  | "lp"
  | "yield"
  | "meme"
  | "perp"
  | "bridge";

export type Signer = "embedded" | "server";
export type StepStatus = "live" | "stub";

/** Pre-encoded tx for client-signed steps. Bytes generated server-side so
 * the client doesn't have to import viem. */
export interface ClientTx {
  to: string;
  data: string;
  value: string; // hex
  chainId: number;
}

export interface PlanStep {
  /** Stable id within the plan, used for /api/plan/execute-step routing. */
  id: string;
  kind: PlanStepKind;
  /** Short label for the UI row. */
  label: string;
  /** Longer description for the expanded view / tooltip. */
  description: string;
  /** Who signs this step. */
  signer: Signer;
  /** Is the executor real or placeholder? */
  status: StepStatus;
  /** Target chain. Only one chain in the first ship (Base), but typed for the future. */
  chainId: number;
  /** Asset class this step contributes to (matches lib/tilt.ts ASSETS). */
  asset?: string;
  /** USDC amount, in base units (string for JSON safety with bigints). */
  amountUnits?: string;
  /** Platform name (matches lib/tilt.ts PlatformTarget.name). */
  platform?: string;
  /** Pre-encoded tx for embedded-signed steps. Absent for server-signed steps. */
  tx?: ClientTx;
}

export interface Plan {
  profileId: RiskProfileId;
  profileName: string;
  amountUsd: number;
  serverWalletAddress: string;
  embeddedWalletAddress: string;
  steps: PlanStep[];
  /** Sum of weights covered by live steps. 100 = fully wired profile. */
  livePctCovered: number;
}

interface BuildArgs {
  risk: number;
  amountUsd: number;
  embeddedWalletAddress: string;
  serverWalletAddress: string;
}

/** Allocation per profile (LEND/SPOT/LST/DEFI/YIELD/RESTAKE/MEME/PERP). */
const ALLOC: Record<RiskProfileId, Record<string, number>> = {
  stable_lender: { LEND: 100 },
  conservative_yield: { LEND: 65, SPOT: 25, LST: 10 },
  balanced_defi: { LEND: 35, SPOT: 25, LST: 15, DEFI: 10, YIELD: 10, RESTAKE: 5 },
  aggressive_growth: { LEND: 15, SPOT: 20, LST: 10, DEFI: 20, YIELD: 10, RESTAKE: 20, MEME: 5 },
  max_speculation: { LEND: 5, SPOT: 10, DEFI: 10, RESTAKE: 10, MEME: 35, PERP: 30 },
};

const LIVE_ASSETS = new Set(["LEND"]); // Aave V3 USDC supply on Base — fully wired.

export function buildPlan({
  risk,
  amountUsd,
  embeddedWalletAddress,
  serverWalletAddress,
}: BuildArgs): Plan {
  const profile = profileFor(risk);
  const allocation = ALLOC[profile.id];
  const totalUnits = BigInt(Math.round(amountUsd * 1_000_000)); // USDC units

  const steps: PlanStep[] = [];

  // Step 0: fund the server wallet from the user's embedded wallet.
  // Pre-encode the USDC.transfer calldata so the client doesn't have to
  // import viem (which would pull in every chain definition).
  const fundTx = buildErc20Transfer(
    TOKENS.USDC,
    serverWalletAddress as Hex,
    totalUnits,
  );
  steps.push({
    id: "fund",
    kind: "fund",
    label: `Fund execution wallet · ${amountUsd} USDC`,
    description: `Transfer ${amountUsd} USDC from your wallet to your execution wallet (${shortAddr(
      serverWalletAddress,
    )}). This is the only step you sign with your own wallet — every step after is signed server-side.`,
    signer: "embedded",
    status: "live",
    chainId: FUNDING_CHAIN_ID,
    asset: "USDC",
    amountUnits: totalUnits.toString(),
    platform: "USDC",
    tx: {
      to: fundTx.to,
      data: fundTx.data,
      value: "0x0",
      chainId: FUNDING_CHAIN_ID,
    },
  });

  // Per-asset legs in stable order.
  for (const asset of ["LEND", "SPOT", "LST", "DEFI", "YIELD", "RESTAKE", "MEME", "PERP"]) {
    const weight = allocation[asset] ?? 0;
    if (weight === 0) continue;

    const legUnits = (totalUnits * BigInt(weight)) / 100n;
    const legUsd = (amountUsd * weight) / 100;
    const isLive = LIVE_ASSETS.has(asset);

    if (asset === "LEND" && isLive) {
      // Two-step: approve Aave pool, then supply.
      steps.push({
        id: "approve-aave-usdc",
        kind: "approve",
        label: `Approve Aave V3 · ${legUsd.toFixed(2)} USDC`,
        description: `Authorize the Aave V3 pool (${shortAddr(
          AAVE_V3_BASE.pool,
        )}) to pull ${legUsd.toFixed(2)} USDC from your execution wallet.`,
        signer: "server",
        status: "live",
        chainId: FUNDING_CHAIN_ID,
        asset,
        amountUnits: legUnits.toString(),
        platform: "Aave V3",
      });
      steps.push({
        id: "supply-aave-usdc",
        kind: "supply",
        label: `Supply Aave V3 · ${legUsd.toFixed(2)} USDC`,
        description: `Deposit ${legUsd.toFixed(
          2,
        )} USDC into Aave V3 on Base. Earns aUSDC at the current pool supply rate.`,
        signer: "server",
        status: "live",
        chainId: FUNDING_CHAIN_ID,
        asset,
        amountUnits: legUnits.toString(),
        platform: "Aave V3",
      });
    } else {
      // Stub leg — venue-specific calldata builder still TODO.
      steps.push({
        id: `stub-${asset.toLowerCase()}`,
        kind: stubKindForAsset(asset),
        label: `${labelForAsset(asset)} · ${legUsd.toFixed(2)} USDC (stub)`,
        description: `${descForAsset(asset)} Not yet wired — venue-specific calldata builder TODO. Execution will return a placeholder until ${routerForAsset(
          asset,
        )} integration lands.`,
        signer: "server",
        status: "stub",
        chainId: FUNDING_CHAIN_ID,
        asset,
        amountUnits: legUnits.toString(),
        platform: routerForAsset(asset),
      });
    }
  }

  const liveWeight = Object.entries(allocation).reduce(
    (sum, [a, w]) => (LIVE_ASSETS.has(a) ? sum + w : sum),
    0,
  );

  return {
    profileId: profile.id,
    profileName: profile.name,
    amountUsd,
    serverWalletAddress,
    embeddedWalletAddress,
    steps,
    livePctCovered: liveWeight,
  };
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function labelForAsset(asset: string): string {
  return (
    {
      SPOT: "Spot BTC/ETH/SOL",
      LST: "Liquid stake ETH",
      DEFI: "DeFi LP",
      YIELD: "Pendle yield",
      RESTAKE: "Restaked ETH",
      MEME: "Memecoins",
      PERP: "Perps",
    }[asset] ?? asset
  );
}

function descForAsset(asset: string): string {
  return (
    {
      SPOT: "Swap USDC into blue-chip spot exposure (BTC/ETH/SOL).",
      LST: "Mint stETH (or wstETH) via Lido for staked ETH yield.",
      DEFI: "Provide liquidity in Uniswap V3, Curve, or Aerodrome pools.",
      YIELD: "Lock yield with Pendle PT/YT positions.",
      RESTAKE: "Deposit ETH into ether.fi / EigenLayer / Renzo for restaking yield.",
      MEME: "Execute memecoin positions on Raydium, Aerodrome, or Jupiter.",
      PERP: "Open perpetual positions on Hyperliquid, GMX, or Jupiter Perps.",
    }[asset] ?? `Allocate to ${asset}.`
  );
}

function routerForAsset(asset: string): string {
  return (
    {
      SPOT: "Uniswap V3",
      LST: "Lido",
      DEFI: "Uniswap V3 / Curve",
      YIELD: "Pendle",
      RESTAKE: "ether.fi",
      MEME: "Aerodrome / Raydium",
      PERP: "Hyperliquid",
    }[asset] ?? asset
  );
}

function stubKindForAsset(asset: string): PlanStepKind {
  return (
    {
      SPOT: "swap",
      LST: "stake",
      DEFI: "lp",
      YIELD: "yield",
      RESTAKE: "restake",
      MEME: "meme",
      PERP: "perp",
    }[asset] as PlanStepKind | undefined
  ) ?? "swap";
}
