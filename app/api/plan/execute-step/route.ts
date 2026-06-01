import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { getOrProvisionServerWallet } from "@/lib/wallet-registry";
import { buildPlan } from "@/lib/strategy-plan";
import { callWayfinder } from "@/lib/wayfinder-sidecar";

export const dynamic = "force-dynamic";
// Strategy execution can take a long time (multi-tx Wayfinder deposit
// loops). Bump the lambda budget; 300s is Vercel's ceiling.
export const maxDuration = 300;

interface ExecuteStepRequest {
  stepId: string;
  risk: number;
  amountUsd: number;
  embeddedWalletAddress: string;
}

/**
 * POST /api/plan/execute-step
 *
 * Server-side executor for a single plan step. Funding steps are signed by
 * the client (connected funding wallet); `strategy` steps dispatch to the
 * Wayfinder Python sidecar.
 */
export async function POST(req: Request) {
  const user = await authenticate(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as ExecuteStepRequest | null;
  if (
    !body?.stepId ||
    typeof body.risk !== "number" ||
    typeof body.amountUsd !== "number" ||
    !body.embeddedWalletAddress
  ) {
    return NextResponse.json({ error: "bad request body" }, { status: 400 });
  }

  const wallet = await getOrProvisionServerWallet(user.userId);

  // Re-derive the plan deterministically and locate the step. Funding txs
  // aren't needed here — only client-signed steps carry a tx.
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
  if (step.signer !== "server") {
    return NextResponse.json(
      { error: `step '${step.id}' is signed by the funding wallet, not the server` },
      { status: 400 },
    );
  }
  if (step.status !== "live") {
    return NextResponse.json({
      ok: true,
      source: "stub",
      stepId: step.id,
      note: `${step.label} is not executable yet.`,
      txHashes: [],
    });
  }
  if (body.amountUsd < plan.minimumAmountUsd) {
    return NextResponse.json(
      { ok: false, error: `amountUsd must be >= ${plan.minimumAmountUsd}` },
      { status: 400 },
    );
  }

  const origin = new URL(req.url).origin;
  const { ok, status, payload } = await callWayfinder(origin, user.jwt, {
    profileId: plan.profileId,
    strategyName: step.strategyName,
    amountUsd: step.amountUsd,
    walletId: wallet.walletId,
    walletAddress: wallet.address,
    caip2: "eip155:8453",
  });

  if (!ok || !payload.ok) {
    return NextResponse.json(
      {
        ok: false,
        source: payload.source ?? "error",
        error: payload.error ?? `sidecar HTTP ${status}`,
      },
      { status: status >= 400 ? status : 502 },
    );
  }

  // Stubs return source:"stub" with a note. Live runs return source:"live".
  return NextResponse.json({
    ok: true,
    source: payload.source ?? "live",
    stepId: step.id,
    note: payload.note,
    txHashes: payload.txHashes ?? [],
    status: payload.status,
  });
}
