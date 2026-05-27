import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { getOrProvisionServerWallet } from "@/lib/wallet-registry";

export const dynamic = "force-dynamic";

/**
 * GET /api/wallet/server
 *
 * Requires `Authorization: Bearer <privy-access-token>`. Returns the
 * user's server wallet (provisioning one on first call). Used by the
 * TransactionPlanModal to know where the user should send funding.
 */
export async function GET(req: Request) {
  const user = await authenticate(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const wallet = await getOrProvisionServerWallet(user.userId);
    return NextResponse.json({ wallet });
  } catch (err) {
    const message = err instanceof Error ? err.message : "provision failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
