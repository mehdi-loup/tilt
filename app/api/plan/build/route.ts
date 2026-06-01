import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { getOrProvisionServerWallet } from "@/lib/wallet-registry";
import { buildPlan, GAS_FUNDING_WEI, type ClientTx } from "@/lib/strategy-plan";
import { FUNDING_CAIP2, FUNDING_CHAIN_ID, RPC_URLS, TOKENS, usdcUnits } from "@/lib/chains";
import { callWayfinder } from "@/lib/wayfinder-sidecar";

export const dynamic = "force-dynamic";

/** Is the server wallet already funded for this amount (USDC + gas float on
 * Base)? If so the build skips funding and the plan is just the strategy
 * step(s) — so a retry resumes from where it failed instead of re-moving funds. */
async function serverWalletFunded(address: string, targetUsdcUnits: bigint): Promise<boolean> {
  const rpc = RPC_URLS[FUNDING_CHAIN_ID];
  if (!rpc) return false;
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { result?: string } | null;
    return body?.result;
  };
  try {
    const balData = `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
    const [usdcHex, ethHex] = await Promise.all([
      call("eth_call", [{ to: TOKENS.USDC, data: balData }, "latest"]),
      call("eth_getBalance", [address, "latest"]),
    ]);
    if (!usdcHex || !ethHex) return false;
    return BigInt(usdcHex) >= targetUsdcUnits && BigInt(ethHex) >= GAS_FUNDING_WEI;
  } catch {
    return false;
  }
}

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

  // Already funded (e.g. retry after a prior run delivered USDC + gas to the
  // server wallet): skip funding, return a plan with only the strategy step(s).
  if (await serverWalletFunded(wallet.address, usdcUnits(body.amountUsd))) {
    const plan = buildPlan({
      risk: body.risk,
      amountUsd: body.amountUsd,
      embeddedWalletAddress: body.embeddedWalletAddress,
      serverWalletAddress: wallet.address,
      skipFunding: true,
    });
    return NextResponse.json({ plan, serverWallet: wallet });
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
