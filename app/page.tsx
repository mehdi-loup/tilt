"use client";

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { themeForRisk, type Theme } from "@/lib/tilt";
import { Dial } from "@/components/Dial";
import { Plan } from "@/components/Plan";
import { WalletChip } from "@/components/WalletChip";

// Lazy-load the modal — its Privy embedded-wallet signing code is heavy
// and only needed when the user actually clicks EXECUTE_PLAN.
const TransactionPlanModal = dynamic(
  () =>
    import("@/components/TransactionPlanModal").then((m) => ({
      default: m.TransactionPlanModal,
    })),
  { ssr: false },
);

const C = {
  bg: "#0b0d10",
  ink: "#f0efe9",
  sub: "rgba(240,239,233,0.55)",
  dim: "rgba(240,239,233,0.12)",
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

export default function Page() {
  const [risk, setRisk] = useState(60);
  const [funding, setFunding] = useState(false);
  const [open, setOpen] = useState(false);
  const theme = themeForRisk(risk);

  useEffect(() => {
    document.body.style.background = `radial-gradient(ellipse at top, ${theme.bodyTint} 0%, #0b0d10 70%)`;
    document.body.style.transition = "background .5s ease";
  }, [theme.bodyTint]);

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 1120, margin: "0 auto", padding: "40px 32px 80px" }}>
        <Centerpiece risk={risk} setRisk={setRisk} theme={theme} />
        <div style={{ marginTop: 48 }}>
          <Plan risk={risk} open={open} onToggle={() => setOpen((o) => !o)} />
        </div>
        <CTA onFund={() => setFunding(true)} />
        <Footer />
      </main>
      {funding && <TransactionPlanModal risk={risk} onClose={() => setFunding(false)} />}
    </>
  );
}

function Nav() {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        backdropFilter: "blur(12px)",
        background: "rgba(11,13,16,0.7)",
        borderBottom: `1px solid ${C.dim}`,
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: "0 auto",
          padding: "0 32px",
          height: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <svg width="22" height="22" viewBox="0 0 22 22" style={{ color: "#c8f56b" }}>
            <circle cx="11" cy="11" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="11" cy="11" r="3" fill="currentColor" />
          </svg>
          <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.4 }}>tilt</span>
        </div>
        <WalletChip />
      </div>
    </header>
  );
}

function Centerpiece({
  risk,
  setRisk,
  theme,
}: {
  risk: number;
  setRisk: (v: number) => void;
  theme: Theme;
}) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 36,
        paddingTop: 16,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <h1
          style={{
            margin: 0,
            fontSize: 44,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: -1.4,
          }}
        >
          How much risk do you like?
        </h1>
      </div>
      <Dial risk={risk} setRisk={setRisk} size={460} theme={theme} />
    </section>
  );
}

function CTA({ onFund }: { onFund: () => void }) {
  const ctaAccent = "#c8f56b";
  const ctaDim = "rgba(200,245,107,0.18)";
  return (
    <section
      style={{
        marginTop: 32,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
      }}
    >
      <button
        onClick={onFund}
        style={{
          background: ctaAccent,
          color: C.bg,
          border: "none",
          padding: "22px 56px",
          fontSize: 16,
          fontWeight: 700,
          fontFamily: C.mono,
          letterSpacing: 1.5,
          cursor: "pointer",
          boxShadow: `0 0 80px ${ctaDim}`,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        EXECUTE_PLAN
        <svg
          width="18"
          height="18"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <path d="M2 7h10M8 3l4 4-4 4" />
        </svg>
      </button>
      <div
        style={{
          fontFamily: C.mono,
          fontSize: 11,
          color: C.sub,
          letterSpacing: 1.2,
        }}
      >
        No minimum · REBALANCED MONTHLY · NO LOCK-UP
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer
      style={{
        marginTop: 56,
        paddingTop: 24,
        borderTop: `1px solid ${C.dim}`,
        display: "flex",
        justifyContent: "space-between",
        fontFamily: C.mono,
        fontSize: 11,
        color: C.sub,
        letterSpacing: 0.6,
      }}
    >
      <span>TILT © 2026 · NOT FINANCIAL ADVICE</span>
      <span>DOCS · SECURITY · DISCLOSURES</span>
    </footer>
  );
}
