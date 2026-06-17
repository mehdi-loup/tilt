import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { FUNDING_CAIP2, TOKENS } from "@/lib/chains";
import { callWayfinder } from "@/lib/wayfinder-sidecar";
import { lookupServerWallet } from "@/lib/wallet-registry";

export const dynamic = "force-dynamic";

/** The server wallet's idle Base USDC, in USD. It's already at the funding
 * destination, so it's deployable with no funding tx and counts toward the
 * investable total. Non-fatal: a read failure just omits the bonus. */
async function serverWalletIdleUsd(userId: string): Promise<number> {
  const wallet = await lookupServerWallet(userId);
  if (!wallet) return 0;
  const rpc = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";
  try {
    const data = `0x70a08231${wallet.address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: TOKENS.USDC, data }, "latest"],
      }),
      cache: "no-store",
    });
    if (!res.ok) return 0;
    const body = (await res.json().catch(() => null)) as { result?: string } | null;
    if (typeof body?.result !== "string") return 0;
    return Number(BigInt(body.result)) / 1e6; // USDC has 6 decimals
  } catch {
    return 0;
  }
}

/**
 * POST /api/plan/balance
 *
 * Body: { embeddedWalletAddress }
 * Returns the total investable USD value Wayfinder sees in the wallet, used
 * for the modal's 25/50/75/100% amount presets. `investableUsd` is null
 * when Wayfinder can't report it (e.g. not installed locally).
 */
export async function POST(req: Request) {
  const user = await authenticate(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    embeddedWalletAddress?: string;
  } | null;
  if (!body?.embeddedWalletAddress) {
    return NextResponse.json({ error: "embeddedWalletAddress required" }, { status: 400 });
  }

  const origin = new URL(req.url).origin;
  const { ok, status, payload } = await callWayfinder(origin, user.jwt, "/fund/balance", {
    fromAddress: body.embeddedWalletAddress,
    caip2: FUNDING_CAIP2,
  });
  if (!ok || !payload.ok) {
    return NextResponse.json(
      {
        investableUsd: null,
        error: payload.error ?? `sidecar HTTP ${status}`,
        source: payload.source ?? "error",
      },
      { status: status >= 400 ? status : 502 },
    );
  }

  if (typeof payload.investableUsd !== "number") {
    return NextResponse.json(
      { investableUsd: null, error: "Wayfinder did not return an investable balance" },
      { status: 502 },
    );
  }

  const serverIdleUsd = await serverWalletIdleUsd(user.userId);
  const investableUsd = payload.investableUsd + serverIdleUsd;
  // The wallet holds funds but not the Base ETH gas float every plan needs to
  // begin, so nothing is investable. Surface that instead of a bare $0.
  const needsBaseGas =
    investableUsd === 0 && payload.baseGasOk === false && (payload.grossUsd ?? 0) > 0;
  return NextResponse.json({
    investableUsd,
    ...(needsBaseGas ? { needsBaseGas: true, grossUsd: payload.grossUsd } : {}),
  });
}
