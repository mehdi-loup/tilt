import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { getOrProvisionServerWallet, lookupServerWallet } from "@/lib/wallet-registry";
import { buildPlan } from "@/lib/strategy-plan";

export const dynamic = "force-dynamic";
// Strategy execution can take a long time (multi-tx Wayfinder deposit
// loops). Bump the lambda budget; Vercel's default 300s is the ceiling.
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
 * Server-side executor for a single plan step. The funding step is signed
 * by the client (embedded wallet); strategy steps dispatch to the
 * Wayfinder Python sidecar at /api/wayfinder/execute.
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

  // The funding step is signed by the embedded wallet; the server doesn't
  // run it.
  if (body.stepId === "fund") {
    return NextResponse.json(
      { error: "the fund step is signed by the embedded wallet, not the server" },
      { status: 400 },
    );
  }

  const wallet =
    lookupServerWallet(user.userId) ?? (await getOrProvisionServerWallet(user.userId));

  // Re-derive the plan deterministically and locate the step.
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
  if (step.kind !== "strategy") {
    return NextResponse.json(
      { error: `step '${step.id}' has no server-side dispatcher` },
      { status: 400 },
    );
  }

  // Dispatch to the Wayfinder Python sidecar at /api/wayfinder/execute.
  // Same project, same domain — Vercel routes /api/*.py to the Python
  // function and /api/<everything-else>/route.ts to Next.js.
  const origin = new URL(req.url).origin;
  let res: Response;
  try {
    res = await fetch(`${origin}/api/wayfinder/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Forward the user's Privy JWT so the sidecar can also enforce auth.
        authorization: `Bearer ${user.jwt}`,
      },
      body: JSON.stringify({
        profileId: plan.profileId,
        amountUsd: step.amountUsd,
        walletId: wallet.walletId,
        walletAddress: wallet.address,
        caip2: "eip155:8453",
      }),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "wayfinder sidecar unreachable",
      },
      { status: 502 },
    );
  }

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    source?: "live" | "stub" | "missing-dep" | "wayfinder-error";
    note?: string;
    txHashes?: string[];
    error?: string;
    status?: unknown;
  };

  if (!res.ok || !payload.ok) {
    return NextResponse.json(
      {
        ok: false,
        source: payload.source ?? "error",
        error: payload.error ?? `sidecar HTTP ${res.status}`,
      },
      { status: 502 },
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
