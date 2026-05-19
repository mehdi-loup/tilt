"use client";

import React from "react";
import {
  ASSETS,
  allocationPositionsFor,
  profileFor,
  projection,
  riskNotes,
} from "@/lib/tilt";
import { PLATFORM_NAME_TO_KEY } from "@/lib/rates-shared";
import { useRates } from "@/lib/useRates";

const C = {
  ink: "#f0efe9",
  sub: "rgba(240,239,233,0.55)",
  dim: "rgba(240,239,233,0.12)",
  card: "rgba(255,255,255,0.025)",
  danger: "#ff7a6b",
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

interface PlanProps {
  risk: number;
  open: boolean;
  onToggle: () => void;
}

export function Plan({ risk, open, onToggle }: PlanProps) {
  const profile = profileFor(risk);
  const proj = projection(risk);
  const accent = "#c8f56b";
  const accentDim = "rgba(200,245,107,0.22)";

  return (
    <section style={{ background: C.card, border: `1px solid ${C.dim}` }}>
      <button
        onClick={onToggle}
        style={{
          display: "grid",
          gridTemplateColumns: "1.3fr repeat(4, auto) auto",
          gap: 24,
          alignItems: "center",
          width: "100%",
          background: "transparent",
          border: "none",
          color: C.ink,
          cursor: "pointer",
          padding: "22px 28px",
          textAlign: "left",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: C.mono,
              fontSize: 11,
              color: C.sub,
              letterSpacing: 1.5,
              marginBottom: 6,
            }}
          >
            YOUR PROFILE
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.4 }}>
            {profile.name}
          </div>
        </div>
        <Stat label="EXPECTED" value={`+${proj.expected}%`} color={accent} accentDim={accentDim} glow />
        <Stat label="DOWNSIDE" value={`${proj.downside}%`} color={C.danger} />
        <Stat label="UPSIDE" value={`+${proj.upside}%`} color={C.ink} />
        <Stat label="VOLATILITY" value={`${proj.vol}%`} color={C.ink} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: C.mono,
            fontSize: 11,
            letterSpacing: 1.2,
            color: C.sub,
          }}
        >
          {open ? "HIDE" : "DETAILS"}
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{
              transition: "transform .25s ease",
              transform: open ? "rotate(180deg)" : "rotate(0)",
            }}
          >
            <path d="M2 4l4 4 4-4" />
          </svg>
        </div>
      </button>

      <div
        style={{
          maxHeight: open ? 3600 : 0,
          opacity: open ? 1 : 0,
          overflow: "hidden",
          transition: "max-height .45s ease, opacity .3s ease",
          borderTop: open ? `1px solid ${C.dim}` : "none",
        }}
      >
        <div
          style={{
            padding: "28px 28px 28px",
            display: "flex",
            flexDirection: "column",
            gap: 32,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 32,
              flexWrap: "wrap",
            }}
          >
            <p style={{ margin: 0, fontSize: 14, color: C.sub, lineHeight: 1.6, maxWidth: 640 }}>
              {profile.tone}
            </p>
            <div
              style={{
                fontFamily: C.mono,
                fontSize: 10,
                color: C.sub,
                letterSpacing: 1.4,
                whiteSpace: "nowrap",
              }}
            >
              DRAG THE DIAL · ←→ TO ADJUST · SHIFT FOR ±10
            </div>
          </div>
          <AllocationBlock risk={risk} />
          <ProjectionBlock risk={risk} accent={accent} accentDim={accentDim} />
          <RiskNotes risk={risk} />
        </div>
      </div>
    </section>
  );
}

interface StatProps {
  label: string;
  value: string;
  color: string;
  accentDim?: string;
  glow?: boolean;
}

function Stat({ label, value, color, accentDim, glow }: StatProps) {
  return (
    <div style={{ minWidth: 92 }}>
      <div
        style={{
          fontFamily: C.mono,
          fontSize: 10,
          color: C.sub,
          letterSpacing: 1,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: C.mono,
          fontSize: 24,
          fontWeight: 700,
          color,
          letterSpacing: -0.8,
          textShadow: glow ? `0 0 20px ${accentDim}` : "none",
          transition: "color .3s ease, text-shadow .3s ease",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionHead({ label, count }: { label: string; count?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        paddingBottom: 10,
        borderBottom: `1px solid ${C.dim}`,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontFamily: C.mono,
          fontSize: 11,
          color: C.ink,
          letterSpacing: 1.5,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      {count && (
        <div style={{ fontFamily: C.mono, fontSize: 10, color: C.sub, letterSpacing: 1 }}>
          {count}
        </div>
      )}
    </div>
  );
}

function formatApy(apy: number | null): string {
  if (apy == null) return "—";
  if (apy >= 1000) return `${Math.round(apy)}%`;
  if (apy >= 100) return `${apy.toFixed(0)}%`;
  if (apy >= 10) return `${apy.toFixed(1)}%`;
  return `${apy.toFixed(2)}%`;
}

function AllocationBlock({ risk }: { risk: number }) {
  const items = allocationPositionsFor(risk);
  const platformCount = new Set(
    items.flatMap((position) => position.targets.map((target) => target.name)),
  ).size;
  const { rates, loading } = useRates();
  return (
    <div>
      <SectionHead
        label="ALLOCATION"
        count={`${items.length} POSITIONS · ${platformCount} PLATFORMS${loading ? " · LOADING RATES…" : rates ? " · LIVE APY" : ""}`}
      />
      <div
        style={{
          height: 12,
          display: "flex",
          marginBottom: 18,
          border: `1px solid ${C.dim}`,
        }}
      >
        {items.map((x) => (
          <div
            key={x.key}
            title={`${x.key} ${x.weight}%`}
            style={{
              width: `${x.weight}%`,
              background: ASSETS[x.key].color,
              transition: "width .2s ease",
            }}
          />
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
        {items.map((x) => (
          <div
            key={x.key}
            style={{
              background: "rgba(255,255,255,0.025)",
              border: `1px solid ${C.dim}`,
              padding: "14px 16px",
              borderLeft: `2px solid ${ASSETS[x.key].color}`,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 4,
              }}
            >
              <span
                style={{
                  fontFamily: C.mono,
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 1,
                }}
              >
                {x.key}
              </span>
              <span
                style={{
                  fontFamily: C.mono,
                  fontSize: 18,
                  fontWeight: 600,
                  letterSpacing: -0.5,
                }}
              >
                {x.weight}%
              </span>
            </div>
            <div style={{ fontSize: 11, color: C.sub }}>{ASSETS[x.key].name}</div>
            <div
              style={{
                marginTop: 8,
                height: 2,
                background: C.dim,
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${Math.min(100, x.weight * 3)}%`,
                  background: ASSETS[x.key].color,
                  transition: "width .2s ease",
                }}
              />
            </div>
            <div
              style={{
                marginTop: 12,
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
              }}
            >
              {x.targets.map((target) => {
                const rateKey = PLATFORM_NAME_TO_KEY[target.name];
                const rate = rateKey && rates ? rates[rateKey] : undefined;
                const apy = rate?.apy ?? null;
                return (
                  <span
                    key={`${x.key}-${target.name}`}
                    title={`${target.role}\n${target.instruments.join(" · ")}${
                      rate
                        ? `\nAPY: ${formatApy(apy)}${
                            rate.sampleSize > 0
                              ? ` (${rate.sampleSize} pools, $${Math.round(
                                  rate.totalTvlUsd / 1e6,
                                )}M TVL)`
                              : ""
                          }`
                        : ""
                    }`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      border: `1px solid ${C.dim}`,
                      color: C.sub,
                      padding: "4px 6px",
                      fontFamily: C.mono,
                      fontSize: 9,
                      letterSpacing: 0.4,
                      lineHeight: 1,
                    }}
                  >
                    {target.name}
                    {apy != null && (
                      <span style={{ color: "#c8f56b", fontWeight: 600 }}>
                        {formatApy(apy)}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectionBlock({
  risk,
  accent,
  accentDim,
}: {
  risk: number;
  accent: string;
  accentDim: string;
}) {
  const proj = projection(risk);
  return (
    <div>
      <SectionHead label="12-MONTH PROJECTION" />
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 18 }}>
        <span
          style={{
            fontFamily: C.mono,
            fontSize: 56,
            fontWeight: 700,
            color: accent,
            letterSpacing: -2,
            textShadow: `0 0 30px ${accentDim}`,
            transition: "color .3s ease, text-shadow .3s ease",
          }}
        >
          +{proj.expected}%
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 11, color: C.sub, letterSpacing: 1 }}>
          EXPECTED
        </span>
      </div>
      <RangeBar proj={proj} accent={accent} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 10,
          fontFamily: C.mono,
          fontSize: 11,
          color: C.sub,
        }}
      >
        <span>P10 {proj.downside}%</span>
        <span>BREAKEVEN</span>
        <span>P90 +{proj.upside}%</span>
      </div>
    </div>
  );
}

function RangeBar({
  proj,
  accent,
}: {
  proj: { expected: number; upside: number; downside: number };
  accent: string;
}) {
  const min = proj.downside;
  const max = proj.upside;
  const span = max - min;
  const exp = ((proj.expected - min) / span) * 100;
  const zero = ((0 - min) / span) * 100;
  return (
    <div style={{ position: "relative", height: 10, background: C.dim }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: `${zero}%`,
          background:
            "linear-gradient(to right, rgba(255,122,107,0.45), rgba(255,122,107,0.15))",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: `${zero}%`,
          top: 0,
          bottom: 0,
          width: `${100 - zero}%`,
          background: `linear-gradient(to right, ${accent}25, ${accent}66)`,
          transition: "background .3s ease",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: -5,
          height: 20,
          width: 2,
          left: `${exp}%`,
          background: accent,
          boxShadow: `0 0 8px ${accent}`,
          transition: "left .2s ease, background .3s ease, box-shadow .3s ease",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: -2,
          height: 14,
          width: 1,
          left: `${zero}%`,
          background: C.sub,
          transition: "left .2s ease",
        }}
      />
    </div>
  );
}

function RiskNotes({ risk }: { risk: number }) {
  const notes = riskNotes(risk);
  return (
    <div>
      <SectionHead label="RISK NOTES" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {notes.map((n) => (
          <div
            key={n.label}
            style={{
              background: "rgba(255,255,255,0.025)",
              border: `1px solid ${C.dim}`,
              padding: "16px 18px",
            }}
          >
            <div style={{ fontSize: 13, marginBottom: 8 }}>{n.label}</div>
            <div
              style={{
                fontFamily: C.mono,
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: -0.8,
                marginBottom: 4,
              }}
            >
              {n.value}
            </div>
            <div
              style={{
                fontFamily: C.mono,
                fontSize: 10,
                color: C.sub,
                letterSpacing: 0.8,
              }}
            >
              {n.sub}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
