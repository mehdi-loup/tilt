import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { getExecution } from "@/lib/execution-ledger";

export const dynamic = "force-dynamic";

/**
 * GET /api/plan/execution/:id
 *
 * Cheap status read over the execution ledger. The client polls this while
 * strategy steps run as background jobs on the sidecar (which writes status
 * rows to the same ledger).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await authenticate(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  const record = await getExecution(id, user.userId);
  if (!record) {
    return NextResponse.json({ error: "unknown execution" }, { status: 404 });
  }
  return NextResponse.json({
    execution: record.execution,
    steps: record.steps.map((s) => ({
      stepId: s.stepId,
      status: s.status,
      txHashes: s.txHashes,
      note: s.note,
      error: s.error,
    })),
  });
}
