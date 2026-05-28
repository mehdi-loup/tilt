"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import type { Plan, PlanStep } from "@/lib/strategy-plan";

const C = {
  bg: "#0b0d10",
  bg2: "#16191e",
  ink: "#f0efe9",
  sub: "rgba(240,239,233,0.55)",
  dim: "rgba(240,239,233,0.12)",
  dim2: "rgba(240,239,233,0.22)",
  accent: "#c8f56b",
  warn: "#ffd166",
  danger: "#ff7a6b",
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

const MIN_EXECUTE_USD = 2;

type StepRuntimeStatus = "idle" | "running" | "success" | "stub" | "error";

interface StepState {
  status: StepRuntimeStatus;
  /** One hash for fund step (embedded signer). Multiple for strategy steps. */
  txHashes?: string[];
  error?: string;
  note?: string;
}

interface Props {
  risk: number;
  onClose: () => void;
}

export function TransactionPlanModal({ risk, onClose }: Props) {
  const { authenticated, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();

  const embedded = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  const [amount, setAmount] = useState(250);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const buildPlan = useCallback(async () => {
    if (!embedded || !authenticated) return;
    setBuilding(true);
    setPlanErr(null);
    setSteps({});
    try {
      const jwt = await getAccessToken();
      const res = await fetch("/api/plan/build", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ risk, amountUsd: amount, embeddedWalletAddress: embedded.address }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { plan: Plan };
      setPlan(body.plan);
      const init: Record<string, StepState> = {};
      for (const s of body.plan.steps) init[s.id] = { status: "idle" };
      setSteps(init);
    } catch (err) {
      setPlanErr(err instanceof Error ? err.message : "build failed");
    } finally {
      setBuilding(false);
    }
  }, [amount, authenticated, embedded, getAccessToken, risk]);

  const runFundStep = useCallback(
    async (step: PlanStep): Promise<StepState> => {
      if (!step.tx) throw new Error("fund step missing pre-built tx");
      const { hash } = await sendTransaction({
        to: step.tx.to,
        data: step.tx.data,
        value: step.tx.value,
        chainId: step.tx.chainId,
      });
      await waitForBaseReceipt(hash);
      return { status: "success", txHashes: [hash] };
    },
    [sendTransaction],
  );

  const runServerStep = useCallback(
    async (step: PlanStep): Promise<StepState> => {
      if (!embedded) throw new Error("no embedded wallet");
      const jwt = await getAccessToken();
      const res = await fetch("/api/plan/execute-step", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          stepId: step.id,
          risk,
          amountUsd: amount,
          embeddedWalletAddress: embedded.address,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        source?: "live" | "stub" | "missing-dep" | "wayfinder-error";
        txHashes?: string[];
        note?: string;
        error?: string;
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.source !== "live") return { status: "stub", note: body.note };
      return { status: "success", txHashes: body.txHashes ?? [] };
    },
    [amount, embedded, getAccessToken, risk],
  );

  const runPlan = useCallback(async () => {
    if (!plan) return;
    setRunning(true);
    for (const step of plan.steps) {
      setSteps((s) => ({ ...s, [step.id]: { status: "running" } }));
      try {
        const next: StepState =
          step.signer === "embedded"
            ? await runFundStep(step)
            : await runServerStep(step);
        setSteps((s) => ({ ...s, [step.id]: next }));
        if (next.status === "error") break;
      } catch (err) {
        const message = err instanceof Error ? err.message : "step failed";
        setSteps((s) => ({ ...s, [step.id]: { status: "error", error: message } }));
        break;
      }
    }
    setRunning(false);
  }, [plan, runFundStep, runServerStep]);

  const allDone = useMemo(() => {
    if (!plan) return false;
    return plan.steps.every((s) => {
      const st = steps[s.id]?.status;
      return st === "success" || st === "stub";
    });
  }, [plan, steps]);
  const canExecute = !!plan && plan.executable && amount >= plan.minimumAmountUsd;

  if (!authenticated || !embedded) {
    return (
      <Backdrop onClose={onClose}>
        <Panel>
          <Header onClose={onClose} title="CONFIRM_FUNDING" />
          <p style={{ color: C.sub, fontSize: 13, marginTop: 20 }}>
            Connect your wallet first — the funding step needs your embedded wallet to sign.
          </p>
        </Panel>
      </Backdrop>
    );
  }

  return (
    <Backdrop onClose={running ? undefined : onClose}>
      <Panel wide>
        <Header onClose={running ? undefined : onClose} title="EXECUTE_PLAN" />

        {!plan && (
          <PlanIntake
            amount={amount}
            onAmount={setAmount}
            onBuild={buildPlan}
            building={building}
            err={planErr}
            minAmount={MIN_EXECUTE_USD}
          />
        )}

        {plan && (
          <>
            <PlanSummary plan={plan} />
            <ol
              style={{
                listStyle: "none",
                padding: 0,
                margin: "20px 0 0",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {plan.steps.map((step, idx) => (
                <StepRow
                  key={step.id}
                  index={idx + 1}
                  step={step}
                  state={steps[step.id] ?? { status: "idle" }}
                />
              ))}
            </ol>

            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 12 }}>
              {!allDone && (
                canExecute ? (
                  <button
                    onClick={runPlan}
                    disabled={running}
                    style={{
                      width: "100%",
                      background: running ? "transparent" : C.accent,
                      color: running ? C.sub : C.bg,
                      border: running ? `1px solid ${C.dim2}` : "none",
                      padding: "16px",
                      fontSize: 14,
                      fontWeight: 700,
                      fontFamily: C.mono,
                      letterSpacing: 1,
                      cursor: running ? "not-allowed" : "pointer",
                    }}
                  >
                    {running ? "EXECUTING…" : "SIGN & EXECUTE →"}
                  </button>
                ) : (
                  <div
                    style={{
                      padding: 16,
                      border: `1px solid ${C.warn}`,
                      color: C.warn,
                      fontFamily: C.mono,
                      fontSize: 11,
                      letterSpacing: 0.7,
                      lineHeight: 1.5,
                      textAlign: "center",
                    }}
                  >
                    PLAN PREVIEW ONLY · STRATEGY COMPOSITION NOT YET EXECUTABLE
                  </div>
                )
              )}
              {allDone && (
                <div
                  style={{
                    padding: 16,
                    border: `1px solid ${C.accent}`,
                    color: C.accent,
                    fontFamily: C.mono,
                    fontSize: 12,
                    letterSpacing: 1,
                    textAlign: "center",
                  }}
                >
                  PLAN COMPLETE · {Math.round(plan.liveFraction * 100)}% LIVE · {Math.round((1 - plan.liveFraction) * 100)}% STUBBED
                </div>
              )}
              <div
                style={{
                  fontFamily: C.mono,
                  fontSize: 10,
                  color: C.sub,
                  letterSpacing: 0.6,
                  textAlign: "center",
                }}
              >
                {plan.executable ? "MAINNET BASE · USDC + ETH GAS · LIVE TRANSACTIONS" : "PREVIEW · NO FUNDS MOVE"}
              </div>
            </div>
          </>
        )}
      </Panel>
    </Backdrop>
  );
}

// ─── small subcomponents ───────────────────────────────────────────────

function Backdrop({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        overflow: "auto",
      }}
    >
      {children}
    </div>
  );
}

function Panel({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: C.bg2,
        border: `1px solid ${C.dim2}`,
        padding: 32,
        width: wide ? 640 : 480,
        maxWidth: "100%",
        position: "relative",
        maxHeight: "90vh",
        overflowY: "auto",
      }}
    >
      {children}
    </div>
  );
}

function Header({ onClose, title }: { onClose?: () => void; title: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div
        style={{
          fontFamily: C.mono,
          fontSize: 11,
          color: C.accent,
          letterSpacing: 1.5,
        }}
      >
        {title}
      </div>
      {onClose && (
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: C.sub,
            cursor: "pointer",
            fontSize: 22,
            lineHeight: 1,
            padding: 4,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function PlanIntake({
  amount,
  onAmount,
  onBuild,
  building,
  err,
  minAmount,
}: {
  amount: number;
  onAmount: (v: number) => void;
  onBuild: () => void;
  building: boolean;
  err: string | null;
  minAmount: number;
}) {
  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          fontFamily: C.mono,
          fontSize: 11,
          color: C.sub,
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        AMOUNT (USDC, BASE)
      </div>
      <input
        type="number"
        value={amount}
        min={minAmount}
        onChange={(e) => onAmount(Math.max(0, Number(e.target.value) || 0))}
        style={{
          width: "100%",
          background: C.bg,
          border: `1px solid ${C.dim2}`,
          color: C.ink,
          padding: "14px 16px",
          fontSize: 24,
          fontFamily: C.mono,
          fontWeight: 600,
          letterSpacing: -0.5,
          outline: "none",
        }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 24 }}>
        {[250, 500, 1000, 5000].map((v) => (
          <button
            key={v}
            onClick={() => onAmount(v)}
            style={{
              flex: 1,
              background: "transparent",
              border: `1px solid ${C.dim}`,
              color: C.sub,
              padding: "8px 10px",
              fontFamily: C.mono,
              fontSize: 11,
              letterSpacing: 0.6,
              cursor: "pointer",
            }}
          >
            ${v.toLocaleString()}
          </button>
        ))}
      </div>
      {err && (
        <div
          style={{
            color: C.danger,
            fontFamily: C.mono,
            fontSize: 11,
            marginBottom: 12,
          }}
        >
          {err}
        </div>
      )}
      <button
        onClick={onBuild}
        disabled={building || amount < minAmount}
        style={{
          width: "100%",
          background: building || amount < minAmount ? "transparent" : C.accent,
          color: building || amount < minAmount ? C.sub : C.bg,
          border: building || amount < minAmount ? `1px solid ${C.dim2}` : "none",
          padding: "14px",
          fontSize: 13,
          fontWeight: 700,
          fontFamily: C.mono,
          letterSpacing: 1,
          cursor: building || amount < minAmount ? "not-allowed" : "pointer",
        }}
      >
        {building ? "BUILDING PLAN…" : "BUILD PLAN →"}
      </button>
    </div>
  );
}

function PlanSummary({ plan }: { plan: Plan }) {
  return (
    <div style={{ marginTop: 20 }}>
      <h2
        style={{
          margin: 0,
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: -0.6,
        }}
      >
        {plan.profileName}{" "}
        <span style={{ color: C.sub, fontWeight: 400 }}>· ${plan.amountUsd} USDC</span>
      </h2>
      <div
        style={{
          marginTop: 8,
          fontFamily: C.mono,
          fontSize: 10,
          color: C.sub,
          letterSpacing: 1,
        }}
      >
        EXEC WALLET · {shortAddr(plan.serverWalletAddress)} ·{" "}
        <span style={{ color: plan.liveFraction === 1 ? C.accent : C.warn }}>
          {Math.round(plan.liveFraction * 100)}% LIVE
        </span>
      </div>
    </div>
  );
}

function StepRow({
  index,
  step,
  state,
}: {
  index: number;
  step: PlanStep;
  state: StepState;
}) {
  const accent = colorForState(state.status, step.status);
  return (
    <li
      style={{
        background: "rgba(255,255,255,0.025)",
        border: `1px solid ${C.dim}`,
        borderLeft: `2px solid ${accent}`,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <span
            style={{
              fontFamily: C.mono,
              fontSize: 11,
              color: C.sub,
              letterSpacing: 1,
              width: 24,
            }}
          >
            {String(index).padStart(2, "0")}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.2 }}>{step.label}</div>
            <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
              {step.signer === "embedded" ? "YOU SIGN" : "WAYFINDER"} ·{" "}
              {step.strategyName ?? step.kind.toUpperCase()}
            </div>
          </div>
        </div>
        <StatusBadge state={state} planStatus={step.status} />
      </div>
      {state.txHashes && state.txHashes.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {state.txHashes.map((h) => (
            <a
              key={h}
              href={`https://basescan.org/tx/${h}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: C.mono,
                fontSize: 10,
                color: C.accent,
                letterSpacing: 0.4,
                textDecoration: "none",
              }}
            >
              ↗ {shortAddr(h)}
            </a>
          ))}
        </div>
      )}
      {state.error && (
        <div style={{ color: C.danger, fontFamily: C.mono, fontSize: 10, marginTop: 6 }}>
          {state.error}
        </div>
      )}
      {state.note && (
        <div style={{ color: C.warn, fontFamily: C.mono, fontSize: 10, marginTop: 6 }}>
          {state.note}
        </div>
      )}
    </li>
  );
}

function StatusBadge({
  state,
  planStatus,
}: {
  state: StepState;
  planStatus: "live" | "stub";
}) {
  let text: string;
  let color: string;
  if (state.status === "running") {
    text = "PENDING";
    color = C.warn;
  } else if (state.status === "success") {
    text = "DONE";
    color = C.accent;
  } else if (state.status === "stub") {
    text = "STUB";
    color = C.warn;
  } else if (state.status === "error") {
    text = "FAIL";
    color = C.danger;
  } else {
    text = planStatus === "live" ? "READY" : "STUB";
    color = planStatus === "live" ? C.sub : C.warn;
  }
  return (
    <span
      style={{
        fontFamily: C.mono,
        fontSize: 10,
        color,
        border: `1px solid ${color}`,
        padding: "3px 8px",
        letterSpacing: 1,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function colorForState(s: StepRuntimeStatus, planStatus: "live" | "stub"): string {
  if (s === "success") return C.accent;
  if (s === "running") return C.warn;
  if (s === "error") return C.danger;
  if (s === "stub" || planStatus === "stub") return C.warn;
  return C.dim2;
}

async function waitForBaseReceipt(hash: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const res = await fetch("https://mainnet.base.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [hash],
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { result?: { status?: string } | null }
      | null;
    const receipt = body?.result;
    if (receipt) {
      if (receipt.status === "0x0") throw new Error("funding transaction reverted");
      return;
    }
    await sleep(2000);
  }
  throw new Error("funding transaction was not confirmed in time");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
