import { NextResponse } from "next/server";
import { authenticate } from "@/lib/privy-server";
import { callWayfinder } from "@/lib/wayfinder-sidecar";
import {
  completeExecutionIfDone,
  getExecution,
  setExecutionStatus,
  updateStep,
} from "@/lib/execution-ledger";

export const dynamic = "force-dynamic";
// With the ledger, strategy steps run as async jobs on the sidecar and this
// route returns immediately; the budget only covers the dispatch round-trip
// (and the dev-mode synchronous fallback).
export const maxDuration = 300;

interface ExecuteStepRequest {
  executionId: string;
  stepId: string;
}

/**
 * POST /api/plan/execute-step
 *
 * Dispatches one server-signed strategy step of a persisted execution. The
 * step is validated against the ledger row written at plan time — the client
 * sends nothing but ids. The sidecar runs the strategy as a background job
 * and writes status to Postgres; the client polls
 * GET /api/plan/execution/:id. (Without a ledger DB — local dev — the
 * sidecar runs synchronously and the result is recorded here.)
 */
export async function POST(req: Request) {
  const user = await authenticate(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as ExecuteStepRequest | null;
  if (!body?.executionId || !body.stepId) {
    return NextResponse.json({ error: "executionId and stepId required" }, { status: 400 });
  }

  const record = await getExecution(body.executionId, user.userId);
  if (!record) {
    return NextResponse.json({ error: "unknown execution" }, { status: 404 });
  }
  const step = record.steps.find((s) => s.stepId === body.stepId);
  if (!step) {
    return NextResponse.json({ error: `unknown step: ${body.stepId}` }, { status: 404 });
  }
  if (step.signer !== "server") {
    return NextResponse.json(
      { error: `step '${step.stepId}' is signed by the funding wallet, not the server` },
      { status: 400 },
    );
  }
  if (step.status === "succeeded") {
    // Idempotent retry: the ledger says this already ran.
    return NextResponse.json({
      ok: true,
      source: "ledger",
      stepId: step.stepId,
      txHashes: step.txHashes,
      done: true,
    });
  }
  if (step.status === "stub") {
    await updateStep(body.executionId, step.stepId, { status: "stub", note: `${step.label} is not executable yet.` });
    return NextResponse.json({
      ok: true,
      source: "stub",
      stepId: step.stepId,
      note: `${step.label} is not executable yet.`,
      txHashes: [],
      done: true,
    });
  }

  const origin = new URL(req.url).origin;
  const { ok, status, payload } = await callWayfinder(origin, user.jwt, "/strategy/run", {
    executionId: record.execution.id,
    stepId: step.stepId,
    profileId: record.execution.profileId,
    strategyName: step.strategyName,
    amountUsd: step.amountUsd,
    walletId: record.execution.serverWalletId,
    walletAddress: record.execution.serverWalletAddress,
    caip2: "eip155:8453",
  });

  if (!ok || !payload.ok) {
    const error = payload.error ?? `sidecar HTTP ${status}`;
    await updateStep(body.executionId, step.stepId, { status: "failed", error });
    await setExecutionStatus(body.executionId, "failed");
    return NextResponse.json(
      { ok: false, source: payload.source ?? "error", error },
      { status: status >= 400 ? status : 502 },
    );
  }

  // Durable path: sidecar detached a job and writes status to the ledger.
  if (payload.source === "job" && payload.jobId) {
    return NextResponse.json({
      ok: true,
      source: "job",
      stepId: step.stepId,
      jobId: payload.jobId,
      done: false,
    });
  }

  // Synchronous fallback (no ledger DB on the sidecar): record the outcome.
  await updateStep(body.executionId, step.stepId, {
    status: "succeeded",
    txHashes: payload.txHashes ?? [],
    note: payload.note,
  });
  await completeExecutionIfDone(body.executionId);
  return NextResponse.json({
    ok: true,
    source: payload.source ?? "live",
    stepId: step.stepId,
    note: payload.note,
    txHashes: payload.txHashes ?? [],
    status: payload.status,
    done: true,
  });
}
