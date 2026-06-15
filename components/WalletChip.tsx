"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

const C = {
  ink: "#f0efe9",
  sub: "rgba(240,239,233,0.55)",
  dim: "rgba(240,239,233,0.12)",
  dim2: "rgba(240,239,233,0.22)",
  panel: "#16191e",
  accent: "#c8f56b",
  danger: "#ff7a6b",
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

function truncate(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletChip() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Show the user's connected (external) wallet — the one they fund from —
  // and only fall back to the Privy embedded wallet. Mirrors the funding-wallet
  // selection in TransactionPlanModal.
  const fundingWallet =
    wallets.find((w) => w.walletClientType !== "privy") ??
    wallets.find((w) => w.walletClientType === "privy");
  const address = fundingWallet?.address;

  if (!ready) {
    return (
      <span
        style={{
          fontFamily: C.mono,
          fontSize: 11,
          color: C.sub,
          letterSpacing: 1.2,
          padding: "6px 12px",
          border: `1px solid ${C.dim}`,
          borderRadius: 4,
        }}
      >
        LOADING…
      </span>
    );
  }

  if (!authenticated || !address) {
    return (
      <button
        onClick={login}
        style={{
          fontFamily: C.mono,
          fontSize: 11,
          color: C.accent,
          letterSpacing: 1.5,
          padding: "6px 14px",
          border: `1px solid ${C.accent}`,
          borderRadius: 4,
          background: "transparent",
          cursor: "pointer",
          transition: "background .15s ease",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(200,245,107,0.08)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        CONNECT
      </button>
    );
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: C.mono,
          fontSize: 11,
          color: C.sub,
          letterSpacing: 0.6,
          padding: "6px 12px",
          border: `1px solid ${C.dim}`,
          borderRadius: 4,
          background: "transparent",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: C.accent,
            boxShadow: `0 0 6px ${C.accent}`,
          }}
        />
        <span>{truncate(address)}</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 200,
            background: C.panel,
            border: `1px solid ${C.dim2}`,
            zIndex: 40,
            boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
          }}
        >
          <MenuItem
            onClick={() => {
              navigator.clipboard.writeText(address);
              setOpen(false);
            }}
          >
            COPY ADDRESS
          </MenuItem>
          <a
            href={`https://zapper.xyz/account/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            style={{
              display: "block",
              padding: "10px 14px",
              fontFamily: C.mono,
              fontSize: 11,
              color: C.sub,
              letterSpacing: 1.2,
              textDecoration: "none",
              borderTop: `1px solid ${C.dim}`,
            }}
          >
            VIEW IN ZAPPER ↗
          </a>
          <div style={{ borderTop: `1px solid ${C.dim}` }} />
          <MenuItem
            onClick={() => {
              logout();
              setOpen(false);
            }}
            color={C.danger}
          >
            DISCONNECT
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  color,
}: {
  children: React.ReactNode;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        padding: "10px 14px",
        fontFamily: C.mono,
        fontSize: 11,
        color: color ?? C.sub,
        letterSpacing: 1.2,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}
