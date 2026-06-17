import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { lookupServerWallet } from "@/lib/wallet-registry";
import { FUNDING_CAIP2 } from "@/lib/chains";
import { callWayfinder } from "@/lib/wayfinder-sidecar";

export const dynamic = "force-dynamic";
// Unwind (unlend) + sweep are a few Base txs; runs synchronously within budget.
export const maxDuration = 300;

/**
 * POST /api/plan/withdraw
 *
 * Body: { recipient }  — the address to receive the funds (the user's
 * connected wallet). Auth: `Authorization: Bearer <privy-access-token>`.
 *
 * Liquidates the user's rotator positions back to USDC in their execution
 * wallet and sweeps all idle Base USDC to `recipient`.
 */
export async function POST(req: Request) {
  const user = await authenticate(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { recipient?: string } | null;
  const recipient = body?.recipient;
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return NextResponse.json({ error: "valid recipient address required" }, { status: 400 });
  }

  const wallet = await lookupServerWallet(user.userId);
  if (!wallet) {
    return NextResponse.json({ error: "no execution wallet to withdraw from" }, { status: 404 });
  }

  const origin = new URL(req.url).origin;
  const { ok, status, payload } = await callWayfinder(origin, user.jwt, "/wallet/withdraw", {
    walletId: wallet.walletId,
    walletAddress: wallet.address,
    recipient,
    caip2: FUNDING_CAIP2,
  });

  if (!ok || !payload.ok) {
    return NextResponse.json(
      { error: payload.error ?? `sidecar HTTP ${status}` },
      { status: status >= 400 ? status : 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    txHashes: payload.txHashes ?? [],
    status: payload.status,
  });
}
