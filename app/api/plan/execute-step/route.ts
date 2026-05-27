import { NextResponse } from "next/server";
import { authenticate, privy } from "@/lib/privy-server";
import { getOrProvisionServerWallet, lookupServerWallet } from "@/lib/wallet-registry";
import { buildPlan } from "@/lib/strategy-plan";
import { buildErc20Approve, buildAaveSupplyUsdc, type TxRequest } from "@/lib/tx-builders";
import { AAVE_V3_BASE, FUNDING_CAIP2, TOKENS } from "@/lib/chains";
import type { Hex } from "viem";

export const dynamic = "force-dynamic";

interface ExecuteStepRequest {
  stepId: string;
  risk: number;
  amountUsd: number;
  embeddedWalletAddress: string;
}

/**
 * POST /api/plan/execute-step
 *
 * Server-side executor for a single plan step. The funding step is handled
 * by the client (the user signs from their embedded wallet); every other
 * step goes through the user's app-owned Privy server wallet via
 * walletApi.ethereum.sendTransaction.
 *
 * Body: ExecuteStepRequest
 * Auth: Authorization: Bearer <privy-access-token>
 *
 * Returns either:
 *   { ok: true, txHash, source: 'live' | 'stub' }
 *   { ok: false, error }
 */
export async function POST(req: Request) {
  const user = await authenticate(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as ExecuteStepRequest | null;
  if (!body?.stepId || typeof body.risk !== "number" || typeof body.amountUsd !== "number" || !body.embeddedWalletAddress) {
    return NextResponse.json({ error: "bad request body" }, { status: 400 });
  }

  // The fund step must be signed by the user's embedded wallet — server
  // refuses, the client handles it.
  if (body.stepId === "fund") {
    return NextResponse.json(
      { error: "the fund step is signed by the embedded wallet, not the server" },
      { status: 400 },
    );
  }

  const wallet =
    lookupServerWallet(user.userId) ?? (await getOrProvisionServerWallet(user.userId));

  // Re-derive the plan deterministically so we can find the step and pick
  // the right calldata builder. (Plans are pure functions of risk + amount
  // + addresses — no state to look up.)
  const plan = buildPlan({
    risk: body.risk,
    amountUsd: body.amountUsd,
    embeddedWalletAddress: body.embeddedWalletAddress,
    serverWalletAddress: wallet.address,
  });
  const step = plan.steps.find((s) => s.id === body.stepId);
  if (!step) {
    return NextResponse.json({ error: `unknown step: ${body.stepId}` }, { status: 404 });
  }

  if (step.status === "stub") {
    return NextResponse.json({
      ok: true,
      source: "stub",
      txHash: null,
      note: `${step.label} — venue-specific calldata builder not yet wired. See EXECUTION.md.`,
    });
  }

  // Pick the right builder.
  let tx: TxRequest;
  const amount = BigInt(step.amountUnits ?? "0");
  const serverAddress = wallet.address as Hex;

  if (step.id === "approve-aave-usdc") {
    tx = buildErc20Approve(TOKENS.USDC, AAVE_V3_BASE.pool, amount);
  } else if (step.id === "supply-aave-usdc") {
    tx = buildAaveSupplyUsdc(amount, serverAddress);
  } else {
    return NextResponse.json(
      { error: `step '${step.id}' is marked live but has no calldata builder` },
      { status: 500 },
    );
  }

  try {
    const { hash } = await privy.walletApi.ethereum.sendTransaction({
      walletId: wallet.walletId,
      caip2: FUNDING_CAIP2,
      transaction: {
        to: tx.to,
        data: tx.data,
        value: tx.value === 0n ? undefined : `0x${tx.value.toString(16)}`,
      },
    });
    return NextResponse.json({ ok: true, source: "live", txHash: hash, stepId: step.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "send failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
