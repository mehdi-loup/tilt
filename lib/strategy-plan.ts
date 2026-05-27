// Strategy → ordered execution plan.
//
// A Plan is a sequence of Steps that, when run in order, deploys the
// user's chosen risk profile by handing off to Wayfinder strategies.
//
//   - `fund`     — user signs from their embedded wallet (the only step
//                  that requires a wallet popup). Sends USDC from
//                  embedded → server wallet on Base.
//   - `strategy` — server dispatches to api/wayfinder/execute, which
//                  drives a Wayfinder strategy against the user's Privy
//                  server wallet. Multi-tx internally; reported as one
//                  logical step.
//
// We intentionally do NOT generate per-asset routing here — that's
// Wayfinder's job. lib/profile-strategies.ts declares which Wayfinder
// strategy each profile invokes; this file just translates that into a
// step list with the funding leg prepended.

import { profileFor, type RiskProfileId } from "./tilt";
import { FUNDING_CHAIN_ID, TOKENS } from "./chains";
import { buildErc20Transfer } from "./tx-builders";
import { PROFILE_COMPOSITION, type StrategyInvocation } from "./profile-strategies";
import type { Hex } from "viem";

export type PlanStepKind = "fund" | "strategy";
export type Signer = "embedded" | "server";
export type StepStatus = "live" | "stub";

/** Pre-encoded tx for client-signed steps. Bytes generated server-side
 * so the client doesn't have to import viem. */
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
  /** Target chain. */
  chainId: number;
  /** USDC amount, in base units (string for JSON safety with bigints). */
  amountUnits?: string;
  /** USD amount this step processes. */
  amountUsd?: number;
  /** Wayfinder strategy name (only for strategy steps). */
  strategyName?: string;
  /** Pre-encoded tx for embedded-signed steps. Absent for server steps. */
  tx?: ClientTx;
}

export interface Plan {
  profileId: RiskProfileId;
  profileName: string;
  amountUsd: number;
  serverWalletAddress: string;
  embeddedWalletAddress: string;
  steps: PlanStep[];
  /** 1.0 = every strategy in the composition is wired; 0 = none. */
  liveFraction: number;
}

interface BuildArgs {
  risk: number;
  amountUsd: number;
  embeddedWalletAddress: string;
  serverWalletAddress: string;
}

export function buildPlan({
  risk,
  amountUsd,
  embeddedWalletAddress,
  serverWalletAddress,
}: BuildArgs): Plan {
  const profile = profileFor(risk);
  const composition = PROFILE_COMPOSITION[profile.id];
  const totalUnits = BigInt(Math.round(amountUsd * 1_000_000)); // USDC base units

  const steps: PlanStep[] = [];

  // Step 0 — fund the server wallet from the user's embedded wallet.
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
    )}). The only step you sign with your own wallet — every step after is signed server-side from this wallet.`,
    signer: "embedded",
    status: "live",
    chainId: FUNDING_CHAIN_ID,
    amountUnits: totalUnits.toString(),
    amountUsd,
    tx: {
      to: fundTx.to,
      data: fundTx.data,
      value: "0x0",
      chainId: FUNDING_CHAIN_ID,
    },
  });

  // One step per Wayfinder strategy invocation declared by the profile.
  composition.steps.forEach((inv, idx) => {
    // For this turn we send the full balance to a single strategy. When
    // we add real composition, the per-step amount will be a fraction.
    const stepUsd = amountUsd / composition.steps.length;
    const stepUnits = totalUnits / BigInt(composition.steps.length);
    steps.push({
      id: `strategy-${idx}-${inv.strategyName}`,
      kind: "strategy",
      label: `${inv.label} · ${stepUsd.toFixed(2)} USDC`,
      description: describeInvocation(inv, stepUsd),
      signer: "server",
      status: inv.status,
      chainId: chainIdFor(inv.chain),
      amountUnits: stepUnits.toString(),
      amountUsd: stepUsd,
      strategyName: inv.strategyName,
    });
  });

  const liveCount = composition.steps.filter((s) => s.status === "live").length;
  return {
    profileId: profile.id,
    profileName: profile.name,
    amountUsd,
    serverWalletAddress,
    embeddedWalletAddress,
    steps,
    liveFraction: composition.steps.length === 0 ? 0 : liveCount / composition.steps.length,
  };
}

function describeInvocation(inv: StrategyInvocation, stepUsd: number): string {
  const base = `Dispatches ${stepUsd.toFixed(2)} USDC to Wayfinder's ${inv.strategyName} on ${inv.chain}. Wayfinder handles pool selection, slippage, and any multi-tx routing internally.`;
  return inv.pendingNote ? `${base}\n\nStub: ${inv.pendingNote}` : base;
}

function chainIdFor(chain: StrategyInvocation["chain"]): number {
  switch (chain) {
    case "base":
      return 8453;
    case "hyperEVM":
      return 999;
    case "hyperliquid":
      return 1337; // Hyperliquid L1 doesn't fit a standard chainId; placeholder
    case "multi":
      return 0;
  }
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
