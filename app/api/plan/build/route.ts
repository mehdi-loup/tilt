import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { getOrProvisionServerWallet } from "@/lib/wallet-registry";
import { buildPlan } from "@/lib/strategy-plan";

export const dynamic = "force-dynamic";

/**
 * POST /api/plan/build
 *
 * Body: { risk: number, amountUsd: number, embeddedWalletAddress: string }
 * Auth: `Authorization: Bearer <privy-access-token>`
 *
 * Returns the structured Plan for the user's risk profile.
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
  const plan = buildPlan({
    risk: body.risk,
    amountUsd: body.amountUsd,
    embeddedWalletAddress: body.embeddedWalletAddress,
    serverWalletAddress: wallet.address,
  });
  return NextResponse.json({ plan, serverWallet: wallet });
}
