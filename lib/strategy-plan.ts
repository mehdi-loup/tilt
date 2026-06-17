// Strategy → ordered execution plan.
//
// A Plan is a sequence of Steps that, when run in order, deploys the
// user's chosen risk profile by handing off to Wayfinder strategies.
//
//   - `fund`     — user signs from their connected funding wallet. The funding
//                  transactions are PLANNED AND BUILT BY WAYFINDER: it
//                  figures out how to move the user's holdings into the
//                  server wallet as USDC on Base (swaps/bridges as needed).
//                  We just relay the built calldata for the user to sign.
//   - `strategy` — server dispatches to api/wayfinder/execute, which
//                  drives a Wayfinder strategy against the user's Privy
//                  server wallet. Multi-tx internally; reported as one
//                  logical step.
//
// We intentionally do NOT generate per-asset routing or swap calldata here
// — that's Wayfinder's job. lib/profile-strategies.ts declares which
// Wayfinder strategy each profile invokes; this file just translates that
// into a step list with the Wayfinder-built funding legs prepended.

import { profileFor, type RiskProfileId } from "./tilt";
import { FUNDING_CHAIN_ID } from "./chains";
import {
  PROFILE_COMPOSITION,
  isProfileExecutable,
  type StrategyInvocation,
} from "./profile-strategies";

export type PlanStepKind = "fund" | "strategy";
export type Signer = "embedded" | "server";
export type StepStatus = "live" | "stub";

/** Pre-encoded tx for client-signed steps. For funding legs these come
 * straight from Wayfinder's route builder. */
export interface ClientTx {
  to: string;
  data: string;
  value: string; // hex
  chainId: number;
  /** Optional human label Wayfinder attaches to this leg. */
  label?: string;
  /** Present on the final transfer when a cross-chain bridge fed it: the
   * funding wallet's Base USDC balance (base units, string) must reach this
   * before the client signs the transfer, since bridged USDC lands on Base
   * asynchronously after the source-chain swap confirms. */
  waitForUsdc?: string;
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
  /** Pre-encoded tx for client-signed funding steps. Absent for server steps. */
  tx?: ClientTx;
}

export interface Plan {
  profileId: RiskProfileId;
  profileName: string;
  amountUsd: number;
  executable: boolean;
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
  /** Wayfinder-planned funding transactions (the connected funding wallet signs
   * these) that move the user's holdings into the server wallet as USDC on
   * Base. Absent during server-side re-derivation, where only strategy
   * steps matter — those legs are emitted without a signable tx. */
  fundingTxs?: ClientTx[];
  /** Include the ETH gas-float step. Omitted when the server wallet already
   * holds enough Base gas (e.g. on a retry). */
  includeGasFloat?: boolean;
}

export function buildPlan({
  risk,
  amountUsd,
  embeddedWalletAddress,
  serverWalletAddress,
  fundingTxs,
  includeGasFloat,
}: BuildArgs): Plan {
  const profile = profileFor(risk);
  const composition = PROFILE_COMPOSITION[profile.id];
  const totalUnits = BigInt(Math.round(amountUsd * 1_000_000)); // USDC base units
  const executable = isProfileExecutable(profile.id);

  const steps: PlanStep[] = [];

  if (executable) {
    // Gas float so the server wallet can pay for the strategy deposit on
    // Base after Wayfinder delivers USDC to it. Skipped when it already has gas.
    if (includeGasFloat) {
      steps.push({
        id: "fund-gas",
        kind: "fund",
        label: `Fund gas · ${formatEth(GAS_FUNDING_WEI)} ETH`,
        description: `Transfer ${formatEth(
          GAS_FUNDING_WEI,
        )} ETH on Base so the execution wallet can pay gas for Wayfinder transactions.`,
        signer: "embedded",
        status: "live",
        chainId: FUNDING_CHAIN_ID,
        tx: {
          to: serverWalletAddress,
          data: "0x",
          value: `0x${GAS_FUNDING_WEI.toString(16)}`,
          chainId: FUNDING_CHAIN_ID,
        },
      });
    }

    // Wayfinder-planned funding legs: one signable step per built tx. These
    // move whatever the user holds into the server wallet as USDC on Base.
    (fundingTxs ?? []).forEach((tx, idx) => {
      steps.push({
        id: `fund-${idx}`,
        kind: "fund",
        label: tx.label ?? `Fund execution wallet · ${amountUsd} USDC`,
        description: `Wayfinder-built transaction moving your funds into the execution wallet (${shortAddr(
          serverWalletAddress,
        )}) as USDC on Base. Wayfinder owns route selection, slippage, and any bridge hops.`,
        signer: "embedded",
        status: "live",
        chainId: tx.chainId,
        amountUsd,
        tx,
      });
    });
  }

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
    executable,
    serverWalletAddress,
    embeddedWalletAddress,
    steps,
    liveFraction: composition.steps.length === 0 ? 0 : liveCount / composition.steps.length,
  };
}

export const GAS_FUNDING_WEI = 1_000_000_000_000_000n; // 0.001 ETH — top-up target

// Below this, the execution wallet needs a gas top-up. It's the strategies'
// operational floor (the rotator rejects below ~0.0005 ETH), not the 0.001 ETH
// gas maximum — a wallet already above it pays its own Base gas and needs no
// float, so we don't move ETH it doesn't need.
export const GAS_FLOAT_TRIGGER_WEI = 500_000_000_000_000n; // 0.0005 ETH

function formatEth(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n;
  const frac = (wei % 1_000_000_000_000_000_000n).toString().padStart(18, "0");
  return `${whole}.${frac.slice(0, 4)}`;
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
