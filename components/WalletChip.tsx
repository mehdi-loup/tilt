"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePrivy, useWallets, type User } from "@privy-io/react-auth";

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

// When the user authenticated without an external wallet (email, social,
// phone), surface that identity rather than the managed Privy embedded wallet.
function authLabel(user: User | null): string {
  if (user?.email?.address) return user.email.address;
  if (user?.google?.email) return user.google.email;
  if (user?.phone?.number) return user.phone.number;
  if (user?.twitter?.username) return `@${user.twitter.username}`;
  if (user?.discord?.username) return user.discord.username;
  if (user?.github?.username) return user.github.username;
  if (user?.apple?.email) return user.apple.email;
  if (user?.farcaster?.username) return user.farcaster.username;
  if (user?.telegram?.username) return user.telegram.username;
  return "ACCOUNT";
}

export function WalletChip() {
  const { ready, authenticated, user, getAccessToken, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [open, setOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawMsg, setWithdrawMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Execution (server) wallet address — mirrored into the Privy user's custom
  // metadata at provision time, so we read it from the session, no fetch.
  const serverMeta = user?.customMetadata?.serverWalletAddress;
  const serverAddr = typeof serverMeta === "string" ? serverMeta : null;

  // Chip shows the user's connected (external) wallet — the one they fund from.
  // When they logged in via email/social (no external wallet, only the Privy
  // embedded one), show how they authenticated instead of the embedded address.
  const address = wallets.find((w) => w.walletClientType !== "privy")?.address;
  const label = address ? truncate(address) : authLabel(user);

  // Unwind the rotator position + sweep idle USDC from the execution wallet back
  // to the connected wallet. Server-driven; the user just authorizes via JWT.
  async function withdraw() {
    if (!address || withdrawing) return;
    if (!window.confirm(`Withdraw your position + idle USDC to ${truncate(address)}?`)) return;
    setWithdrawing(true);
    setWithdrawMsg(null);
    try {
      const jwt = await getAccessToken();
      const res = await fetch("/api/plan/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ recipient: address }),
      });
      const body = (await res.json().catch(() => ({}))) as { txHashes?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setWithdrawMsg((body.txHashes?.length ?? 0) > 0 ? "Withdrawn ✓" : "Nothing to withdraw");
    } catch (e) {
      setWithdrawMsg(e instanceof Error ? e.message : "withdraw failed");
    } finally {
      setWithdrawing(false);
    }
  }

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

  if (!authenticated) {
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
        <span>{label}</span>
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
          {address && (
            <>
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
            </>
          )}
          {serverAddr && (
            <>
              <div style={{ padding: "10px 14px" }}>
                <div
                  style={{
                    fontFamily: C.mono,
                    fontSize: 9,
                    letterSpacing: 1.5,
                    color: C.sub,
                    marginBottom: 5,
                  }}
                >
                  EXECUTION WALLET
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    title={serverAddr}
                    onClick={() => navigator.clipboard.writeText(serverAddr)}
                    style={{
                      fontFamily: C.mono,
                      fontSize: 11,
                      color: C.ink,
                      letterSpacing: 0.6,
                      cursor: "pointer",
                    }}
                  >
                    {truncate(serverAddr)}
                  </span>
                  <a
                    href={`https://zapper.xyz/account/${serverAddr}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setOpen(false)}
                    style={{
                      fontFamily: C.mono,
                      fontSize: 11,
                      color: C.sub,
                      textDecoration: "none",
                    }}
                  >
                    ↗
                  </a>
                </div>
              </div>
              {address && (
                <MenuItem onClick={withdraw}>
                  {withdrawing ? "WITHDRAWING…" : `WITHDRAW → ${truncate(address)}`}
                </MenuItem>
              )}
              {withdrawMsg && (
                <div
                  style={{
                    padding: "0 14px 10px",
                    fontFamily: C.mono,
                    fontSize: 10,
                    color: C.sub,
                    letterSpacing: 1,
                  }}
                >
                  {withdrawMsg}
                </div>
              )}
              <div style={{ borderTop: `1px solid ${C.dim}` }} />
            </>
          )}
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
