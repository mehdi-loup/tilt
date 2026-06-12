import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { FUNDING_CAIP2 } from "@/lib/chains";
import { callWayfinder } from "@/lib/wayfinder-sidecar";

export const dynamic = "force-dynamic";

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

  return NextResponse.json({ investableUsd: payload.investableUsd });
}
