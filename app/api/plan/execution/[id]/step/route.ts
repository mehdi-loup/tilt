import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import {
  completeExecutionIfDone,
  getExecution,
  updateStep,
} from "@/lib/execution-ledger";

export const dynamic = "force-dynamic";

interface ReportBody {
  stepId: string;
  status: "running" | "succeeded" | "failed";
  txHash?: string;
  error?: string;
}

/**
 * POST /api/plan/execution/:id/step
 *
 * The client reports progress of the steps it signs itself (funding legs):
 * tx hash once broadcast, then succeeded/failed after the receipt. Strategy
 * (server-signed) steps are not reportable here — the sidecar owns those rows.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await authenticate(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as ReportBody | null;
  if (!body?.stepId || !["running", "succeeded", "failed"].includes(body.status ?? "")) {
    return NextResponse.json(
      { error: "stepId and status (running|succeeded|failed) required" },
      { status: 400 },
    );
  }

  const record = await getExecution(id, user.userId);
  if (!record) {
    return NextResponse.json({ error: "unknown execution" }, { status: 404 });
  }
  const step = record.steps.find((s) => s.stepId === body.stepId);
  if (!step) {
    return NextResponse.json({ error: `unknown step: ${body.stepId}` }, { status: 404 });
  }
  if (step.signer !== "embedded") {
    return NextResponse.json(
      { error: "only client-signed funding steps are reportable" },
      { status: 400 },
    );
  }

  const txHashes = body.txHash
    ? Array.from(new Set([...step.txHashes, body.txHash]))
    : undefined;
  await updateStep(id, body.stepId, {
    status: body.status,
    txHashes,
    error: body.status === "failed" ? (body.error ?? "funding step failed") : undefined,
  });
  if (body.status === "succeeded") {
    await completeExecutionIfDone(id);
  }
  return NextResponse.json({ ok: true });
}
