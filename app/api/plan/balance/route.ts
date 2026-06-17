import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { FUNDING_CAIP2, TOKENS } from "@/lib/chains";
import { callWayfinder } from "@/lib/wayfinder-sidecar";
import { lookupServerWallet } from "@/lib/wallet-registry";

export const dynamic = "force-dynamic";

/** The execution wallet's idle Base USDC (in USD) and native ETH gas (wei).
 * The idle USDC is already at the funding destination, so it counts toward the
 * investable total; the gas balance tells the sidecar whether a gas float is
 * still owed. Non-fatal: a read failure returns zeros. */
async function serverWalletState(userId: string): Promise<{ idleUsd: number; gasWei: bigint }> {
  const wallet = await lookupServerWallet(userId);
  if (!wallet) return { idleUsd: 0, gasWei: 0n };
  const rpc = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";
  const call = async (method: string, params: unknown[]): Promise<string | null> => {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { result?: string } | null;
    return typeof body?.result === "string" ? body.result : null;
  };
  try {
    const data = `0x70a08231${wallet.address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
    const [usdcHex, ethHex] = await Promise.all([
      call("eth_call", [{ to: TOKENS.USDC, data }, "latest"]),
      call("eth_getBalance", [wallet.address, "latest"]),
    ]);
    return {
      idleUsd: usdcHex ? Number(BigInt(usdcHex)) / 1e6 : 0, // USDC has 6 decimals
      gasWei: ethHex ? BigInt(ethHex) : 0n,
    };
  } catch {
    return { idleUsd: 0, gasWei: 0n };
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
  const server = await serverWalletState(user.userId);
  const { ok, status, payload } = await callWayfinder(origin, user.jwt, "/fund/balance", {
    fromAddress: body.embeddedWalletAddress,
    caip2: FUNDING_CAIP2,
    serverGasWei: server.gasWei.toString(),
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

  const investableUsd = payload.investableUsd + server.idleUsd;
  // The wallet holds funds but not the Base ETH gas float every plan needs to
  // begin, so nothing is investable. Surface that instead of a bare $0.
  const needsBaseGas =
    investableUsd === 0 && payload.baseGasOk === false && (payload.grossUsd ?? 0) > 0;
  return NextResponse.json({
    investableUsd,
    ...(needsBaseGas ? { needsBaseGas: true, grossUsd: payload.grossUsd } : {}),
  });
}
