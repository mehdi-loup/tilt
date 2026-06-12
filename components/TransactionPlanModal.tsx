"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useCreateWallet, usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import type { Plan, PlanStep } from "@/lib/strategy-plan";
import { RPC_URLS, TOKENS, FUNDING_CHAIN_ID, explorerTxUrl } from "@/lib/chains";

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
  /** One hash for a funding step. Multiple hashes for strategy steps. */
  txHashes?: string[];
  error?: string;
  note?: string;
}

interface Props {
  risk: number;
  onClose: () => void;
}

export function TransactionPlanModal({ risk, onClose }: Props) {
  const { authenticated, getAccessToken, login } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { sendTransaction } = useSendTransaction();

  // Funding source = the wallet the user connected. Prefer an external wallet
  // (where they actually hold funds); fall back to the Privy embedded wallet.
  const fundingWallet =
    wallets.find((w) => w.walletClientType !== "privy") ??
    wallets.find((w) => w.walletClientType === "privy");
  const [amount, setAmount] = useState(0);
  const [investableUsd, setInvestableUsd] = useState<number | null>(null);
  const [balanceErr, setBalanceErr] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [quoteWarning, setQuoteWarning] = useState<string | null>(null);
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [creatingWallet, setCreatingWallet] = useState(false);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  // Ask Wayfinder how much the wallet can invest, for the amount presets.
  useEffect(() => {
    if (!fundingWallet || !authenticated) {
      setInvestableUsd(null);
      setBalanceErr(null);
      setBalanceLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setBalanceLoading(true);
      setBalanceErr(null);
      try {
        const jwt = await getAccessToken();
        const res = await fetch("/api/plan/balance", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ embeddedWalletAddress: fundingWallet.address }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          investableUsd?: number | null;
          error?: string;
        };
        if (!res.ok) throw new Error(body.error ?? `balance HTTP ${res.status}`);
        if (typeof body.investableUsd !== "number") {
          throw new Error("Wayfinder balance unavailable");
        }
        if (!cancelled) setInvestableUsd(body.investableUsd);
      } catch (err) {
        if (!cancelled) {
          setInvestableUsd(null);
          setBalanceErr(err instanceof Error ? err.message : "balance unavailable");
        }
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fundingWallet, authenticated, getAccessToken]);

  const buildPlan = useCallback(async () => {
    if (!fundingWallet || !authenticated) return;
    setBuilding(true);
    setPlanErr(null);
    setQuoteWarning(null);
    setSteps({});
    try {
      const jwt = await getAccessToken();
      const res = await fetch("/api/plan/build", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          risk,
          amountUsd: amount,
          embeddedWalletAddress: fundingWallet.address,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        plan: Plan;
        executionId?: string;
        quoteError?: string;
      };
      setPlan(body.plan);
      setExecutionId(body.executionId ?? null);
      setQuoteWarning(body.quoteError ?? null);
      const init: Record<string, StepState> = {};
      for (const s of body.plan.steps) init[s.id] = { status: "idle" };
      setSteps(init);
    } catch (err) {
      setPlanErr(err instanceof Error ? err.message : "build failed");
    } finally {
      setBuilding(false);
    }
  }, [amount, authenticated, fundingWallet, getAccessToken, risk]);

  const createEmbeddedWallet = useCallback(async () => {
    if (!authenticated) {
      login();
      return;
    }
    setCreatingWallet(true);
    setWalletErr(null);
    try {
      await createWallet();
    } catch (err) {
      setWalletErr(err instanceof Error ? err.message : "wallet creation failed");
    } finally {
      setCreatingWallet(false);
    }
  }, [authenticated, createWallet, login]);

  // Report client-signed (funding) step progress to the execution ledger so
  // the server record — not this tab — is the source of truth.
  const reportFundStep = useCallback(
    async (
      stepId: string,
      status: "running" | "succeeded" | "failed",
      txHash?: string,
      error?: string,
    ) => {
      if (!executionId) return;
      try {
        const jwt = await getAccessToken();
        await fetch(`/api/plan/execution/${executionId}/step`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ stepId, status, txHash, error }),
        });
      } catch {
        // Ledger reporting is best-effort from the client; the funding tx
        // itself is already on-chain.
      }
    },
    [executionId, getAccessToken],
  );

  const runFundStep = useCallback(
    async (step: PlanStep): Promise<StepState> => {
      if (!fundingWallet) throw new Error("no funding wallet");
      if (!step.tx) throw new Error("fund step missing pre-built tx");
      // Cross-chain bridge legs settle on Base asynchronously; gate the final
      // transfer on the bridged USDC actually arriving before we sign it.
      if (step.tx.waitForUsdc) {
        await waitForBaseUsdc(fundingWallet.address, BigInt(step.tx.waitForUsdc));
      }
      const txReq = {
        from: fundingWallet.address,
        to: step.tx.to,
        data: step.tx.data,
        value: step.tx.value,
      };
      let hash: string;
      if (fundingWallet.walletClientType === "privy") {
        ({ hash } = await sendTransaction(
          { ...txReq, chainId: step.tx.chainId },
          { address: fundingWallet.address },
        ));
      } else {
        // External wallet signs via its own provider.
        await fundingWallet.switchChain(step.tx.chainId);
        const provider = await fundingWallet.getEthereumProvider();
        hash = (await provider.request({
          method: "eth_sendTransaction",
          params: [txReq],
        })) as string;
      }
      await reportFundStep(step.id, "running", hash);
      try {
        await waitForReceipt(hash, step.tx.chainId);
      } catch (err) {
        await reportFundStep(
          step.id,
          "failed",
          hash,
          err instanceof Error ? err.message : "receipt failed",
        );
        throw err;
      }
      await reportFundStep(step.id, "succeeded", hash);
      return { status: "success", txHashes: [hash] };
    },
    [fundingWallet, reportFundStep, sendTransaction],
  );

  const pollStrategyStep = useCallback(
    async (stepId: string): Promise<StepState> => {
      // Strategy jobs run server-side and can take many minutes (bridging +
      // multi-tx deposits); poll the ledger, not the job connection.
      const jwt = await getAccessToken();
      for (let attempt = 0; attempt < 900; attempt++) {
        await sleep(3000);
        const res = await fetch(`/api/plan/execution/${executionId}`, {
          headers: { authorization: `Bearer ${jwt}` },
        });
        const body = (await res.json().catch(() => ({}))) as {
          steps?: { stepId: string; status: string; txHashes?: string[]; note?: string; error?: string }[];
        };
        const step = body.steps?.find((s) => s.stepId === stepId);
        if (!step) continue;
        if (step.status === "succeeded") {
          return { status: "success", txHashes: step.txHashes ?? [] };
        }
        if (step.status === "stub") return { status: "stub", note: step.note };
        if (step.status === "failed") {
          return { status: "error", error: step.error ?? "strategy step failed" };
        }
      }
      return { status: "error", error: "timed out waiting for the strategy job" };
    },
    [executionId, getAccessToken],
  );

  const runServerStep = useCallback(
    async (step: PlanStep): Promise<StepState> => {
      if (!executionId) throw new Error("execution was not persisted; rebuild the plan");
      const jwt = await getAccessToken();
      const res = await fetch("/api/plan/execute-step", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ executionId, stepId: step.id }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        source?: "live" | "stub" | "job" | "ledger" | "missing-dep" | "wayfinder-error";
        done?: boolean;
        jobId?: string;
        txHashes?: string[];
        note?: string;
        error?: string;
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      // Async job: the sidecar writes progress to the ledger; poll it.
      if (!body.done && body.jobId) return pollStrategyStep(step.id);
      if (body.source === "stub") return { status: "stub", note: body.note };
      return { status: "success", txHashes: body.txHashes ?? [] };
    },
    [executionId, getAccessToken, pollStrategyStep],
  );

  const runPlan = useCallback(async () => {
    if (!plan) return;
    setRunning(true);
    for (const step of plan.steps) {
      // Don't re-run steps that already succeeded (e.g. retrying after a later
      // step failed) — the funding txs have already moved funds on-chain.
      if (steps[step.id]?.status === "success") continue;
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
  }, [plan, steps, runFundStep, runServerStep]);

  const allDone = useMemo(() => {
    if (!plan) return false;
    return plan.steps.every((s) => {
      const st = steps[s.id]?.status;
      return st === "success" || st === "stub";
    });
  }, [plan, steps]);

  // The funding plan is ready when the build returned an executable plan with
  // no funding error. Funding steps may legitimately be absent — the server
  // wallet can already hold the amount + gas (the build funds only the
  // shortfall). Only a quoteWarning means Wayfinder couldn't build the route.
  const fundReady = !!plan?.executable && !quoteWarning;
  // overBalance only applies when the connected wallet actually sources USDC
  // (fund-N legs). If the server wallet already covers the amount, there's
  // nothing to draw from the connected wallet, so its balance is irrelevant.
  const needsConnectedFunding = !!plan?.steps.some((s) => /^fund-\d+$/.test(s.id));
  const overBalance =
    needsConnectedFunding && investableUsd !== null && amount > investableUsd;
  const canExecute =
    !!plan &&
    plan.executable &&
    amount >= plan.minimumAmountUsd &&
    fundReady &&
    !overBalance;

  const blockMessage = !plan
    ? ""
    : !plan.executable
      ? "PLAN PREVIEW ONLY · STRATEGY COMPOSITION NOT YET EXECUTABLE"
      : !fundReady
        ? `WAYFINDER FUNDING PLAN UNAVAILABLE${quoteWarning ? ` · ${quoteWarning.toUpperCase()}` : ""}`
        : overBalance
          ? `AMOUNT EXCEEDS INVESTABLE BALANCE ($${investableUsd?.toFixed(2)})`
          : "PLAN PREVIEW ONLY · STRATEGY COMPOSITION NOT YET EXECUTABLE";

  if (!authenticated || !fundingWallet) {
    const title = authenticated ? "CREATE WALLET" : "CONNECT WALLET";
    const copy = authenticated
      ? "No wallet found. Create a Privy embedded wallet to fund from, or reconnect an external wallet."
      : "Connect your wallet first. Funding is sourced from and signed by the wallet you connect.";
    return (
      <Backdrop onClose={onClose}>
        <Panel>
          <Header onClose={onClose} title="CONFIRM_FUNDING" />
          <p style={{ color: C.sub, fontSize: 13, marginTop: 20 }}>
            {copy}
          </p>
          {walletErr && (
            <div
              style={{
                color: C.danger,
                fontFamily: C.mono,
                fontSize: 11,
                marginTop: 16,
              }}
            >
              {walletErr}
            </div>
          )}
          <button
            onClick={authenticated ? createEmbeddedWallet : login}
            disabled={creatingWallet}
            style={{
              width: "100%",
              background: creatingWallet ? "transparent" : C.accent,
              color: creatingWallet ? C.sub : C.bg,
              border: creatingWallet ? `1px solid ${C.dim2}` : "none",
              padding: "14px",
              marginTop: 20,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: C.mono,
              letterSpacing: 1,
              cursor: creatingWallet ? "not-allowed" : "pointer",
            }}
          >
            {creatingWallet ? "CREATING…" : title}
          </button>
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
            investableUsd={investableUsd}
            balanceErr={balanceErr}
            balanceLoading={balanceLoading}
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
                    {blockMessage}
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
                {plan.executable ? "MAINNET BASE · ANY TOKEN → USDC VIA WAYFINDER · LIVE TRANSACTIONS" : "PREVIEW · NO FUNDS MOVE"}
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
  investableUsd,
  balanceErr,
  balanceLoading,
}: {
  amount: number;
  onAmount: (v: number) => void;
  onBuild: () => void;
  building: boolean;
  err: string | null;
  minAmount: number;
  investableUsd: number | null;
  balanceErr: string | null;
  balanceLoading: boolean;
}) {
  const overBalance = investableUsd !== null && amount > investableUsd;
  const disabled = building || amount < minAmount || overBalance;
  const balanceLabel = balanceLoading
    ? "BALANCE …"
    : balanceErr
      ? "BALANCE UNAVAILABLE"
      : investableUsd === null
        ? "BALANCE --"
        : `BALANCE $${investableUsd.toFixed(2)}`;
  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <div style={{ fontFamily: C.mono, fontSize: 11, color: C.sub, letterSpacing: 1 }}>
          AMOUNT TO INVEST
        </div>
        <div
          style={{
            fontFamily: C.mono,
            fontSize: 11,
            color: balanceErr ? C.warn : C.sub,
            letterSpacing: 0.6,
          }}
        >
          {balanceLabel}
        </div>
      </div>
      <input
        type="number"
        value={amount}
        min={minAmount}
        max={investableUsd ?? undefined}
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
      <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 16 }}>
        {[
          { label: "25%", frac: 0.25 },
          { label: "50%", frac: 0.5 },
          { label: "75%", frac: 0.75 },
          { label: "100%", frac: 1 },
        ].map((p) => (
          <button
            key={p.label}
            disabled={investableUsd === null || investableUsd <= 0}
            onClick={() => {
              if (investableUsd === null) return;
              onAmount(Math.floor(investableUsd * p.frac * 100) / 100);
            }}
            style={{
              flex: 1,
              background: "transparent",
              border: `1px solid ${C.dim}`,
              color: C.sub,
              padding: "8px 10px",
              fontFamily: C.mono,
              fontSize: 11,
              letterSpacing: 0.6,
              cursor: investableUsd === null || investableUsd <= 0 ? "not-allowed" : "pointer",
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div
        style={{
          fontFamily: C.mono,
          fontSize: 11,
          color: C.sub,
          letterSpacing: 0.4,
          lineHeight: 1.5,
          marginBottom: 24,
        }}
      >
        Wayfinder plans and builds the transactions to move your funds into the
        execution wallet as USDC on Base — whatever you hold, however it routes.
      </div>
      {overBalance && (
        <div style={{ color: C.warn, fontFamily: C.mono, fontSize: 11, marginBottom: 12 }}>
          Amount exceeds your investable balance.
        </div>
      )}
      {balanceErr && (
        <div style={{ color: C.warn, fontFamily: C.mono, fontSize: 11, marginBottom: 12 }}>
          Balance unavailable: {balanceErr}
        </div>
      )}
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
        disabled={disabled}
        style={{
          width: "100%",
          background: disabled ? "transparent" : C.accent,
          color: disabled ? C.sub : C.bg,
          border: disabled ? `1px solid ${C.dim2}` : "none",
          padding: "14px",
          fontSize: 13,
          fontWeight: 700,
          fontFamily: C.mono,
          letterSpacing: 1,
          cursor: disabled ? "not-allowed" : "pointer",
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
              href={explorerTxUrl(step.chainId, h)}
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

async function rpcCall(
  chainId: number,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const url = RPC_URLS[chainId];
  if (!url) return undefined; // unknown chain — caller decides the fallback
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
  return body?.result;
}

async function waitForReceipt(hash: string, chainId: number): Promise<void> {
  if (!RPC_URLS[chainId]) {
    // Can't confirm a tx we can't read — fail loudly rather than mark an
    // unmined (or reverted) tx successful. The sidecar only routes funding
    // through SUPPORTED_CHAINS, so this is a defensive guard.
    throw new Error(`no receipt RPC configured for chain ${chainId}`);
  }
  for (let attempt = 0; attempt < 90; attempt++) {
    const receipt = (await rpcCall(chainId, "eth_getTransactionReceipt", [hash])) as
      | { status?: string }
      | null
      | undefined;
    if (receipt) {
      if (receipt.status === "0x0") throw new Error("funding transaction reverted");
      return;
    }
    await sleep(2000);
  }
  throw new Error("funding transaction was not confirmed in time");
}

/** Poll the funding wallet's Base USDC balance until it covers `units`, so a
 * bridge-fed transfer isn't signed before the USDC has landed. Bridges can take
 * minutes, hence the long ceiling. */
async function waitForBaseUsdc(address: string, units: bigint): Promise<void> {
  const data = `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = (await rpcCall(FUNDING_CHAIN_ID, "eth_call", [
      { to: TOKENS.USDC, data },
      "latest",
    ])) as string | undefined;
    if (result && result !== "0x" && BigInt(result) >= units) return;
    await sleep(4000);
  }
  throw new Error("bridged USDC did not arrive on Base in time");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
