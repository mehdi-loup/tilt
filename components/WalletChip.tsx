"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useConnectWallet, usePrivy, useUser, useWallets, type User } from "@privy-io/react-auth";

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
function authLabel(user: User | null): string | null {
  if (user?.email?.address) return user.email.address;
  if (user?.google?.email) return user.google.email;
  if (user?.phone?.number) return user.phone.number;
  if (user?.twitter?.username) return `@${user.twitter.username}`;
  if (user?.discord?.username) return user.discord.username;
  if (user?.github?.username) return user.github.username;
  if (user?.apple?.email) return user.apple.email;
  if (user?.farcaster?.username) return user.farcaster.username;
  if (user?.telegram?.username) return user.telegram.username;
  return null;
}

export function WalletChip() {
  const { ready, authenticated, user, getAccessToken, login, logout } = usePrivy();
  const { refreshUser } = useUser();
  const { connectWallet } = useConnectWallet();
  const { wallets } = useWallets();
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawMsg, setWithdrawMsg] = useState<string | null>(null);
  const [withdrawTxs, setWithdrawTxs] = useState<string[]>([]);
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
    setWithdrawing(true);
    setWithdrawMsg(null);
    setWithdrawTxs([]);
    try {
      const jwt = await getAccessToken();
      const res = await fetch("/api/plan/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ recipient: address }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        txHashes?: string[];
        error?: string;
        status?: { nativeSweepError?: string };
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setWithdrawTxs(body.txHashes ?? []);
      // The native (ETH gas) sweep is best-effort and runs after the USDC has
      // already moved, so surface a partial failure rather than a flat "✓".
      if (body.status?.nativeSweepError) {
        setWithdrawMsg("Withdrew your USDC, but couldn't sweep the remaining ETH gas — run Withdraw again to retry it.");
      } else {
        setWithdrawMsg((body.txHashes?.length ?? 0) > 0 ? "Withdrawn ✓" : "Nothing to withdraw");
      }
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

  // No external wallet and no recognized auth identity → nothing to label.
  // If a session already exists (e.g. a previously linked wallet that isn't
  // connected this session), connect a wallet — calling login() while
  // authenticated throws "already logged in". Otherwise log in.
  if (!authenticated || !label) {
    return (
      <button
        onClick={() => (authenticated ? connectWallet() : login())}
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
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Refresh the session on open so a freshly provisioned execution
          // wallet (mirrored into Privy custom metadata server-side) surfaces
          // without a reload, even if the build that wrote it errored after.
          if (next) void refreshUser().catch(() => {});
        }}
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
              <WalletSection label="CONNECTED WALLET" address={address} close={() => setOpen(false)} />
              <div style={{ borderTop: `1px solid ${C.dim}` }} />
            </>
          )}
          {serverAddr && (
            <>
              <WalletSection label="EXECUTION WALLET" address={serverAddr} close={() => setOpen(false)}>
                {address && (
                  <MenuItem
                    onClick={() => {
                      setWithdrawMsg(null);
                      setWithdrawTxs([]);
                      setOpen(false);
                      setConfirmOpen(true);
                    }}
                  >
                    {`WITHDRAW → ${truncate(address)}`}
                  </MenuItem>
                )}
              </WalletSection>
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

      {/* Portal to body: the nav header has `backdrop-filter`, which makes it
          the containing block for `position: fixed` children — without the
          portal the overlay would fill the 64px header, not the viewport. */}
      {confirmOpen &&
        createPortal(
        <div
          onClick={() => !withdrawing && setConfirmOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 380,
              background: C.panel,
              border: `1px solid ${C.dim2}`,
              borderRadius: 6,
              padding: 24,
              fontFamily: C.mono,
              boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
            }}
          >
            <div style={{ fontSize: 12, letterSpacing: 2, color: C.accent, marginBottom: 14 }}>
              WITHDRAW
            </div>
            {withdrawMsg ? (
              <>
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: C.ink,
                    marginBottom: withdrawTxs.length > 0 ? 14 : 22,
                  }}
                >
                  {withdrawMsg}
                </div>
                {withdrawTxs.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 22 }}>
                    {withdrawTxs.map((h) => (
                      <a
                        key={h}
                        href={`https://basescan.org/tx/${h}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={resultLink}
                      >
                        {`TRANSACTION ${truncate(h)} ↗`}
                      </a>
                    ))}
                    {serverAddr && (
                      <a
                        href={`https://zapper.xyz/account/${serverAddr}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={resultLink}
                      >
                        EXECUTION WALLET IN ZAPPER ↗
                      </a>
                    )}
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    onClick={() => {
                      setConfirmOpen(false);
                      setWithdrawMsg(null);
                    }}
                    style={confirmBtn(false)}
                  >
                    CLOSE
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: C.sub, marginBottom: 22 }}>
                  This unwinds your rotator position and empties the execution
                  wallet — all idle USDC and remaining ETH gas — back to your
                  connected wallet{address ? ` (${truncate(address)})` : ""}.
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button
                    onClick={() => setConfirmOpen(false)}
                    disabled={withdrawing}
                    style={confirmBtn(false, withdrawing)}
                  >
                    CANCEL
                  </button>
                  <button onClick={withdraw} disabled={withdrawing} style={confirmBtn(true, withdrawing)}>
                    {withdrawing ? "WITHDRAWING…" : "WITHDRAW"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// Result-modal links (withdrawal tx + execution-wallet explorer).
const resultLink: React.CSSProperties = {
  fontFamily: C.mono,
  fontSize: 11,
  color: C.accent,
  letterSpacing: 1,
  textDecoration: "none",
};

// Confirm-dialog button styles: `primary` is the accent-filled action.
function confirmBtn(primary: boolean, busy = false): React.CSSProperties {
  return {
    fontFamily: C.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    padding: "9px 18px",
    borderRadius: 4,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.6 : 1,
    background: primary ? C.accent : "transparent",
    border: `1px solid ${primary ? C.accent : C.dim2}`,
    color: primary ? C.panel : C.sub,
    fontWeight: primary ? 600 : 400,
  };
}

// A labelled wallet block: address + copy + Zapper link, plus any extra
// actions (e.g. withdraw) passed as children.
function WalletSection({
  label,
  address,
  close,
  children,
}: {
  label: string;
  address: string;
  close: () => void;
  children?: React.ReactNode;
}) {
  return (
    <>
      <div style={{ padding: "10px 14px 4px" }}>
        <div
          style={{
            fontFamily: C.mono,
            fontSize: 9,
            letterSpacing: 1.5,
            color: C.sub,
            marginBottom: 5,
          }}
        >
          {label}
        </div>
        <span
          title={address}
          style={{ fontFamily: C.mono, fontSize: 11, color: C.ink, letterSpacing: 0.6 }}
        >
          {truncate(address)}
        </span>
      </div>
      <MenuItem
        onClick={() => {
          navigator.clipboard.writeText(address);
          close();
        }}
      >
        COPY ADDRESS
      </MenuItem>
      <a
        href={`https://zapper.xyz/account/${address}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={close}
        style={{
          display: "block",
          padding: "10px 14px",
          fontFamily: C.mono,
          fontSize: 11,
          color: C.sub,
          letterSpacing: 1.2,
          textDecoration: "none",
        }}
      >
        VIEW IN ZAPPER ↗
      </a>
      {children}
    </>
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
