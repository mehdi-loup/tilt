import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { getOrProvisionServerWallet } from "@/lib/wallet-registry";
import { buildPlan, type ClientTx } from "@/lib/strategy-plan";
import { FUNDING_CAIP2, usdcUnits } from "@/lib/chains";
import { callWayfinder } from "@/lib/wayfinder-sidecar";

export const dynamic = "force-dynamic";

/**
 * POST /api/plan/build
 *
 * Body: { risk, amountUsd, embeddedWalletAddress }
 * Auth: `Authorization: Bearer <privy-access-token>`
 *
 * Returns the structured Plan for the user's risk profile. For executable
 * profiles it asks the Wayfinder sidecar to PLAN AND BUILD the funding
 * transaction(s) that move the user's holdings into the server wallet as
 * USDC on Base. The connected funding wallet signs those built txs.
 */
export async function POST(req: Request) {
  const user = await authenticate(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    risk?: number;
    amountUsd?: number;
    embeddedWalletAddress?: string;
  } | null;
  if (!body || typeof body.risk !== "number" || typeof body.amountUsd !== "number" || typeof body.embeddedWalletAddress !== "string") {
    return NextResponse.json(
      { error: "body requires risk:number, amountUsd:number, embeddedWalletAddress:string" },
      { status: 400 },
    );
  }
  if (body.amountUsd < 1) {
    return NextResponse.json({ error: "amountUsd must be ≥ 1" }, { status: 400 });
  }

  const wallet = await getOrProvisionServerWallet(user.userId);

  // Preliminary plan (no funding txs) gives us executability + minimum.
  const preview = buildPlan({
    risk: body.risk,
    amountUsd: body.amountUsd,
    embeddedWalletAddress: body.embeddedWalletAddress,
    serverWalletAddress: wallet.address,
  });
  if (preview.executable && body.amountUsd < preview.minimumAmountUsd) {
    return NextResponse.json(
      { error: `amountUsd must be >= ${preview.minimumAmountUsd}` },
      { status: 400 },
    );
  }

  // Preview-only profiles never fund — return as-is.
  if (!preview.executable) {
    return NextResponse.json({ plan: preview, serverWallet: wallet });
  }

  // Ask Wayfinder to plan + build the funding transactions: convert whatever
  // the connected funding wallet holds into the target USDC on Base and
  // deliver it to the server wallet.
  const origin = new URL(req.url).origin;
  const planned = await callWayfinder(origin, user.jwt, {
    operation: "fund",
    mode: "plan",
    amountUsd: body.amountUsd,
    targetUsdcUnits: usdcUnits(body.amountUsd).toString(),
    fromAddress: body.embeddedWalletAddress,
    recipientAddress: wallet.address,
    caip2: FUNDING_CAIP2,
  });

  if (!planned.ok || !planned.payload.ok || !planned.payload.txs?.length) {
    // Wayfinder unavailable (sidecar down, not installed, etc.). Return the
    // plan without funding txs so the UI blocks execution honestly instead
    // of inventing a route.
    return NextResponse.json({
      plan: preview,
      serverWallet: wallet,
      quoteError: planned.payload.error ?? "Wayfinder funding plan unavailable",
    });
  }

  const fundingTxs = planned.payload.txs as ClientTx[];
  const plan = buildPlan({
    risk: body.risk,
    amountUsd: body.amountUsd,
    embeddedWalletAddress: body.embeddedWalletAddress,
    serverWalletAddress: wallet.address,
    fundingTxs,
  });

  return NextResponse.json({ plan, serverWallet: wallet });
}
