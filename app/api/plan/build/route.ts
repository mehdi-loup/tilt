import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { getOrProvisionServerWallet } from "@/lib/wallet-registry";
import { buildPlan, GAS_FLOAT_TRIGGER_WEI, type ClientTx } from "@/lib/strategy-plan";
import { FUNDING_CAIP2, TOKENS, usdcUnits } from "@/lib/chains";
import { callWayfinder } from "@/lib/wayfinder-sidecar";
import { createExecution } from "@/lib/execution-ledger";

export const dynamic = "force-dynamic";

/** The server (execution) wallet's current Base USDC + native ETH balances.
 * Used to fund only the shortfall and skip the gas float when already present,
 * so changing the amount or retrying doesn't re-move funds already delivered.
 *
 * Throws on RPC failure: silently reading 0 would over-fund a wallet that may
 * already hold the funds, so the caller refuses to plan from an unknown
 * balance. Reads go through BASE_RPC_URL (a keyed provider in production); the
 * public default works locally but rate-limits serverless IPs. */
async function serverWalletBalances(
  address: string,
): Promise<{ usdc: bigint; eth: bigint }> {
  const rpc = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";
  const call = async (method: string, params: unknown[]): Promise<string> => {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Base RPC ${method} HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { result?: string } | null;
    if (typeof body?.result !== "string") {
      throw new Error(`Base RPC ${method} returned no result`);
    }
    return body.result;
  };
  const balData = `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const [usdcHex, ethHex] = await Promise.all([
    call("eth_call", [{ to: TOKENS.USDC, data: balData }, "latest"]),
    call("eth_getBalance", [address, "latest"]),
  ]);
  return { usdc: BigInt(usdcHex), eth: BigInt(ethHex) };
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
  const wallet = await getOrProvisionServerWallet(user.userId);

  // Preliminary plan (no funding txs) gives us executability + minimum.
  const preview = buildPlan({
    risk: body.risk,
    amountUsd: body.amountUsd,
    embeddedWalletAddress: body.embeddedWalletAddress,
    serverWalletAddress: wallet.address,
  });
  // Preview-only profiles never fund — return as-is.
  if (!preview.executable) {
    return NextResponse.json({ plan: preview, serverWallet: wallet });
  }

  // Fund only the shortfall: account for USDC/gas the server wallet already
  // holds (from a prior run / a different amount), so we never re-move funds
  // that are already there.
  const target = usdcUnits(body.amountUsd);
  let serverUsdc: bigint;
  let serverEth: bigint;
  try {
    ({ usdc: serverUsdc, eth: serverEth } = await serverWalletBalances(wallet.address));
  } catch (err) {
    const message = err instanceof Error ? err.message : "balance read failed";
    return NextResponse.json(
      { error: `couldn't read execution wallet balance: ${message}` },
      { status: 502 },
    );
  }
  const shortfallUnits = target > serverUsdc ? target - serverUsdc : 0n;
  // Only top up gas when the execution wallet is below the strategies'
  // operational floor (~0.0005 ETH). Above it the wallet pays its own Base
  // deposit gas — the strategy invests USDC, ETH is only gas — so we never move
  // ETH it doesn't need.
  const includeGasFloat = serverEth < GAS_FLOAT_TRIGGER_WEI;

  // Nothing to move — server wallet already holds the amount + gas.
  if (shortfallUnits === 0n && !includeGasFloat) {
    const plan = buildPlan({
      risk: body.risk,
      amountUsd: body.amountUsd,
      embeddedWalletAddress: body.embeddedWalletAddress,
      serverWalletAddress: wallet.address,
    });
    const executionId = await createExecution({
      userId: user.userId,
      risk: body.risk,
      plan,
      serverWalletId: wallet.walletId,
    });
    return NextResponse.json({ plan, serverWallet: wallet, executionId });
  }

  // Ask Wayfinder to plan + build the funding transactions for the shortfall:
  // convert what the connected wallet holds into USDC on Base and deliver it to
  // the server wallet. Skipped when only the gas float is missing.
  const origin = new URL(req.url).origin;
  let fundingTxs: ClientTx[] | undefined;
  if (shortfallUnits > 0n) {
    const planned = await callWayfinder(origin, user.jwt, "/fund/plan", {
      amountUsd: body.amountUsd,
      targetUsdcUnits: shortfallUnits.toString(),
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
    fundingTxs = planned.payload.txs as ClientTx[];
  }

  const plan = buildPlan({
    risk: body.risk,
    amountUsd: body.amountUsd,
    embeddedWalletAddress: body.embeddedWalletAddress,
    serverWalletAddress: wallet.address,
    fundingTxs,
    includeGasFloat,
  });

  // Persist the execution — including the Wayfinder-built funding txs and
  // quoted amounts — so every subsequent call validates against this record
  // instead of trusting re-sent client inputs.
  const executionId = await createExecution({
    userId: user.userId,
    risk: body.risk,
    plan,
    serverWalletId: wallet.walletId,
  });

  return NextResponse.json({ plan, serverWallet: wallet, executionId });
}
