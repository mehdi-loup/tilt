// Execution ledger — durable record of planned executions and their steps.
//
// plan/build creates an execution (with the Wayfinder-built funding txs and
// quoted amounts) and returns its id; every subsequent call is
// executionId + stepId, validated against the stored record instead of
// re-sent client inputs. The client reports funding tx hashes here; the
// Python sidecar updates strategy-step status directly in Postgres as async
// jobs progress. "Resume" = read the rows.
//
// DATABASE_URL unset → in-process fallback for local dev (single process);
// production fails closed via requireDbInProduction.

import "server-only";

import { randomUUID } from "crypto";
import { dbConfigured, requireDbInProduction, sql } from "./db";
import type { Plan, PlanStep } from "./strategy-plan";

export type ExecutionStatus = "planned" | "running" | "succeeded" | "failed";
export type StepLedgerStatus = ExecutionStatus | "stub";

export interface ExecutionRecord {
  id: string;
  userId: string;
  profileId: string;
  risk: number;
  amountUsd: number;
  embeddedWalletAddress: string;
  serverWalletId: string;
  serverWalletAddress: string;
  status: ExecutionStatus;
}

export interface StepRecord {
  stepId: string;
  seq: number;
  kind: PlanStep["kind"];
  signer: PlanStep["signer"];
  label: string;
  chainId: number;
  amountUsd?: number;
  amountUnits?: string;
  strategyName?: string;
  tx?: PlanStep["tx"];
  status: StepLedgerStatus;
  txHashes: string[];
  jobId?: string;
  note?: string;
  error?: string;
}

// ─── dev fallback store ────────────────────────────────────────────────

const memory = new Map<string, { execution: ExecutionRecord; steps: StepRecord[] }>();

// ─── writes ────────────────────────────────────────────────────────────

export async function createExecution(args: {
  userId: string;
  risk: number;
  plan: Plan;
  serverWalletId: string;
}): Promise<string> {
  requireDbInProduction("The execution ledger");
  const { plan } = args;
  const execution: ExecutionRecord = {
    id: randomUUID(),
    userId: args.userId,
    profileId: plan.profileId,
    risk: args.risk,
    amountUsd: plan.amountUsd,
    embeddedWalletAddress: plan.embeddedWalletAddress,
    serverWalletId: args.serverWalletId,
    serverWalletAddress: plan.serverWalletAddress,
    status: "planned",
  };
  const steps: StepRecord[] = plan.steps.map((s, seq) => ({
    stepId: s.id,
    seq,
    kind: s.kind,
    signer: s.signer,
    label: s.label,
    chainId: s.chainId,
    amountUsd: s.amountUsd,
    amountUnits: s.amountUnits,
    strategyName: s.strategyName,
    tx: s.tx,
    status: s.status === "stub" ? "stub" : "planned",
    txHashes: [],
  }));

  if (!dbConfigured) {
    memory.set(execution.id, { execution, steps });
    return execution.id;
  }

  const q = sql();
  await q`
    insert into executions (id, user_id, profile_id, risk, amount_usd,
      embedded_wallet_address, server_wallet_id, server_wallet_address, status)
    values (${execution.id}, ${execution.userId}, ${execution.profileId},
      ${execution.risk}, ${execution.amountUsd}, ${execution.embeddedWalletAddress},
      ${execution.serverWalletId}, ${execution.serverWalletAddress}, 'planned')
  `;
  for (const s of steps) {
    await q`
      insert into steps (execution_id, step_id, seq, kind, signer, label,
        chain_id, amount_usd, amount_units, strategy_name, tx, status)
      values (${execution.id}, ${s.stepId}, ${s.seq}, ${s.kind}, ${s.signer},
        ${s.label}, ${s.chainId}, ${s.amountUsd ?? null}, ${s.amountUnits ?? null},
        ${s.strategyName ?? null}, ${s.tx ? JSON.stringify(s.tx) : null}, ${s.status})
    `;
  }
  return execution.id;
}

export async function updateStep(
  executionId: string,
  stepId: string,
  fields: Partial<Pick<StepRecord, "status" | "txHashes" | "jobId" | "note" | "error">>,
): Promise<void> {
  if (!dbConfigured) {
    const entry = memory.get(executionId);
    const step = entry?.steps.find((s) => s.stepId === stepId);
    if (step) Object.assign(step, fields);
    return;
  }
  const q = sql();
  await q`
    update steps set
      status     = coalesce(${fields.status ?? null}, status),
      tx_hashes  = coalesce(${fields.txHashes ? JSON.stringify(fields.txHashes) : null}::jsonb, tx_hashes),
      job_id     = coalesce(${fields.jobId ?? null}, job_id),
      note       = coalesce(${fields.note ?? null}, note),
      error      = ${fields.error ?? null},
      updated_at = now()
    where execution_id = ${executionId} and step_id = ${stepId}
  `;
}

export async function setExecutionStatus(
  executionId: string,
  status: ExecutionStatus,
): Promise<void> {
  if (!dbConfigured) {
    const entry = memory.get(executionId);
    if (entry) entry.execution.status = status;
    return;
  }
  await sql()`
    update executions set status = ${status}, updated_at = now()
    where id = ${executionId}
  `;
}

export async function completeExecutionIfDone(executionId: string): Promise<void> {
  if (!dbConfigured) {
    const entry = memory.get(executionId);
    if (entry && entry.steps.every((s) => s.status === "succeeded" || s.status === "stub")) {
      entry.execution.status = "succeeded";
    }
    return;
  }
  await sql()`
    update executions set status = 'succeeded', updated_at = now()
    where id = ${executionId} and not exists (
      select 1 from steps
      where execution_id = ${executionId} and status not in ('succeeded', 'stub')
    )
  `;
}

// ─── reads ─────────────────────────────────────────────────────────────

export async function getExecution(
  executionId: string,
  userId: string,
): Promise<{ execution: ExecutionRecord; steps: StepRecord[] } | undefined> {
  if (!dbConfigured) {
    const entry = memory.get(executionId);
    if (!entry || entry.execution.userId !== userId) return undefined;
    return { execution: entry.execution, steps: entry.steps };
  }
  const q = sql();
  const execRows = (await q`
    select id, user_id, profile_id, risk, amount_usd, embedded_wallet_address,
           server_wallet_id, server_wallet_address, status
    from executions where id = ${executionId} and user_id = ${userId}
  `) as Record<string, unknown>[];
  if (execRows.length === 0) return undefined;
  const e = execRows[0];
  const stepRows = (await q`
    select step_id, seq, kind, signer, label, chain_id, amount_usd, amount_units,
           strategy_name, tx, status, tx_hashes, job_id, note, error
    from steps where execution_id = ${executionId} order by seq
  `) as Record<string, unknown>[];
  return {
    execution: {
      id: String(e.id),
      userId: String(e.user_id),
      profileId: String(e.profile_id),
      risk: Number(e.risk),
      amountUsd: Number(e.amount_usd),
      embeddedWalletAddress: String(e.embedded_wallet_address),
      serverWalletId: String(e.server_wallet_id),
      serverWalletAddress: String(e.server_wallet_address),
      status: e.status as ExecutionStatus,
    },
    steps: stepRows.map((s) => ({
      stepId: String(s.step_id),
      seq: Number(s.seq),
      kind: s.kind as StepRecord["kind"],
      signer: s.signer as StepRecord["signer"],
      label: String(s.label),
      chainId: Number(s.chain_id),
      amountUsd: s.amount_usd === null ? undefined : Number(s.amount_usd),
      amountUnits: s.amount_units === null ? undefined : String(s.amount_units),
      strategyName: s.strategy_name === null ? undefined : String(s.strategy_name),
      tx: (s.tx ?? undefined) as StepRecord["tx"],
      status: s.status as StepLedgerStatus,
      txHashes: (s.tx_hashes ?? []) as string[],
      jobId: s.job_id === null ? undefined : String(s.job_id),
      note: s.note === null ? undefined : String(s.note),
      error: s.error === null ? undefined : String(s.error),
    })),
  };
}
