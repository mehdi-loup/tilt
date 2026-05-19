"use client";

import React, { useEffect, useState } from "react";
import { profileFor, projection } from "@/lib/tilt";

const C = {
  bg: "#0b0d10",
  bg2: "#16191e",
  ink: "#f0efe9",
  sub: "rgba(240,239,233,0.55)",
  dim: "rgba(240,239,233,0.12)",
  dim2: "rgba(240,239,233,0.22)",
  accent: "#c8f56b",
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

interface FundModalProps {
  risk: number;
  onClose: () => void;
}

export function FundModal({ risk, onClose }: FundModalProps) {
  const profile = profileFor(risk);
  const proj = projection(risk);
  const [amount, setAmount] = useState(1000);
  const expGain = Math.round((amount * proj.expected) / 100);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);

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
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.bg2,
          border: `1px solid ${C.dim2}`,
          padding: 36,
          width: 480,
          maxWidth: "100%",
          position: "relative",
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 16,
            right: 16,
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
        <div
          style={{
            fontFamily: C.mono,
            fontSize: 11,
            color: C.accent,
            letterSpacing: 1.5,
            marginBottom: 12,
          }}
        >
          CONFIRM_FUNDING
        </div>
        <h2 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: -0.8 }}>
          {profile.name}{" "}
          <span style={{ color: C.sub, fontWeight: 400 }}>· score {risk}</span>
        </h2>
        <div style={{ marginTop: 28 }}>
          <div
            style={{
              fontFamily: C.mono,
              fontSize: 11,
              color: C.sub,
              letterSpacing: 1,
              marginBottom: 8,
            }}
          >
            AMOUNT (USDX)
          </div>
          <input
            type="number"
            value={amount}
            min={0}
            onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
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
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {[500, 1000, 5000, 10000].map((v) => (
              <button
                key={v}
                onClick={() => setAmount(v)}
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
        </div>
        <div
          style={{
            marginTop: 24,
            padding: "16px 0",
            borderTop: `1px solid ${C.dim}`,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 13,
          }}
        >
          <span style={{ color: C.sub }}>Expected gain (12-mo)</span>
          <span style={{ fontFamily: C.mono, fontWeight: 600, color: C.accent }}>
            +${expGain.toLocaleString()}
          </span>
        </div>
        <button
          style={{
            marginTop: 16,
            width: "100%",
            background: C.accent,
            color: C.bg,
            border: "none",
            padding: "16px",
            fontSize: 14,
            fontWeight: 700,
            fontFamily: C.mono,
            letterSpacing: 1,
            cursor: "pointer",
            opacity: 1,
          }}
        >
          SIGN & SEND →
        </button>
        <div
          style={{
            marginTop: 12,
            fontFamily: C.mono,
            fontSize: 10,
            color: C.sub,
            letterSpacing: 0.6,
            textAlign: "center",
          }}
        >
          MOCK · NO REAL FUNDS WILL MOVE
        </div>
      </div>
    </div>
  );
}
