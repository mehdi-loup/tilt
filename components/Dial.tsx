"use client";

import React, { useRef, useState, type CSSProperties } from "react";
import type { Theme } from "@/lib/tilt";

const MONO = '"JetBrains Mono", ui-monospace, monospace';

interface DialProps {
  risk: number;
  setRisk: (v: number) => void;
  size?: number;
  theme: Theme;
}

export function Dial({ risk, setRisk, size = 460, theme }: DialProps) {
  const {
    accent,
    accentDim,
    accentGlow,
    arcDeep,
    innerBg,
    outerBg1,
    outerBg2,
    pulsePeriod,
    pulseLo,
    pulseHi,
    shimmerPeriod,
    haloBlur,
    haloOpacity,
    ink,
    sub,
    dim,
    dim2,
  } = theme;

  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const angle = -135 + (risk / 100) * 270;

  const angleFromEvent = (e: PointerEvent | React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const cxp = r.left + r.width / 2;
    const cyp = r.top + r.height / 2;
    const dx = e.clientX - cxp;
    const dy = e.clientY - cyp;
    let a = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (a > 135) a = 135;
    if (a < -135) a = -135;
    return a;
  };

  const onDown = (e: React.PointerEvent) => {
    const a = angleFromEvent(e);
    const next = Math.round(((a + 135) / 270) * 100);
    setRisk(Math.max(0, Math.min(100, next)));
    setDragging(true);
    const mv = (ev: PointerEvent) => {
      const a2 = angleFromEvent(ev);
      const v = Math.round(((a2 + 135) / 270) * 100);
      setRisk(Math.max(0, Math.min(100, v)));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const onKey = (e: React.KeyboardEvent) => {
    let d = 0;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") d = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") d = 1;
    if (!d) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    setRisk(Math.max(0, Math.min(100, risk + d * step)));
  };

  const ticks: { ta: number; major: boolean; on: boolean }[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const ta = -135 + t * 270;
    ticks.push({ ta, major: i % 5 === 0, on: t * 100 <= risk });
  }

  const R = size / 2;
  const trackR = R - 36;
  const ringR = R - 72;
  const innerR = ringR - 24;

  const sa = ((-135 - 90) * Math.PI) / 180;
  const ea = ((angle - 90) * Math.PI) / 180;
  const arcRad = trackR - 26;
  const x1 = R + Math.cos(sa) * arcRad;
  const y1 = R + Math.sin(sa) * arcRad;
  const x2 = R + Math.cos(ea) * arcRad;
  const y2 = R + Math.sin(ea) * arcRad;
  const large = angle - -135 > 180 ? 1 : 0;
  const arcD = `M ${x1} ${y1} A ${arcRad} ${arcRad} 0 ${large} 1 ${x2} ${y2}`;

  const pulseStyle = {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: innerR * 1.8,
    height: innerR * 1.8,
    borderRadius: "50%",
    background: `radial-gradient(circle, ${accentGlow} 0%, ${accentDim} 35%, transparent 70%)`,
    animation: `dial-pulse ${pulsePeriod}s ease-in-out infinite`,
    "--dial-pulse-lo": pulseLo,
    "--dial-pulse-hi": pulseHi,
    pointerEvents: "none",
    mixBlendMode: "screen",
  } as CSSProperties;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={risk}
      aria-label="Risk tolerance"
      onPointerDown={onDown}
      onKeyDown={onKey}
      style={{
        position: "relative",
        width: size,
        height: size,
        userSelect: "none",
        touchAction: "none",
        cursor: dragging ? "grabbing" : "grab",
        outline: "none",
        borderRadius: "50%",
        boxShadow: `0 0 ${haloBlur}px ${haloOpacity}px ${accentDim}`,
        transition: "box-shadow .4s ease",
      }}
    >
      <div style={pulseStyle} />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: innerR * 1.6,
          height: innerR * 1.6,
          borderRadius: "50%",
          background: `conic-gradient(from 0deg, transparent, ${accentDim}, transparent, ${accentDim}, transparent)`,
          animation: `dial-shimmer ${shimmerPeriod}s linear infinite`,
          pointerEvents: "none",
          opacity: 0.35,
          mixBlendMode: "screen",
        }}
      />

      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ position: "absolute", inset: 0, transition: "filter .3s ease" }}
      >
        <defs>
          <radialGradient id="dial-outer" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor={outerBg1} />
            <stop offset="80%" stopColor={outerBg2} />
          </radialGradient>
          <linearGradient id="dial-arc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={arcDeep} />
            <stop offset="100%" stopColor={accent} />
          </linearGradient>
          <filter id="dial-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" />
          </filter>
        </defs>

        <circle
          cx={R}
          cy={R}
          r={R - 4}
          fill="url(#dial-outer)"
          stroke={dim}
          strokeWidth="1"
          style={{ transition: "fill .3s ease" }}
        />
        <circle cx={R} cy={R} r={ringR} fill="none" stroke={dim} strokeWidth="1" />

        {ticks.map((t, i) => {
          const rad = ((t.ta - 90) * Math.PI) / 180;
          const r1 = trackR;
          const r2 = trackR + (t.major ? -14 : -8);
          return (
            <line
              key={i}
              x1={R + Math.cos(rad) * r1}
              y1={R + Math.sin(rad) * r1}
              x2={R + Math.cos(rad) * r2}
              y2={R + Math.sin(rad) * r2}
              stroke={t.on ? accent : dim2}
              strokeWidth={t.major ? 1.8 : 1}
              strokeLinecap="round"
              style={{ transition: "stroke .15s ease" }}
            />
          );
        })}

        <path
          d={arcD}
          stroke="url(#dial-arc)"
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
          filter="url(#dial-glow)"
          opacity="0.6"
        />
        <path
          d={arcD}
          stroke="url(#dial-arc)"
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
        />

        <circle
          cx={R}
          cy={R}
          r={innerR}
          fill={innerBg}
          stroke={dim}
          strokeWidth="1"
          style={{ transition: "fill .3s ease" }}
        />
      </svg>

      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `rotate(${angle}deg)`,
          transition: dragging ? "none" : "transform .1s ease",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 38,
            left: "50%",
            width: 2,
            height: 96,
            background: accent,
            transform: "translateX(-1px)",
            boxShadow: `0 0 14px ${accent}`,
            transition: "background .2s ease, box-shadow .2s ease",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 24,
            left: "50%",
            width: 16,
            height: 16,
            borderRadius: 8,
            background: accent,
            transform: "translateX(-8px)",
            boxShadow: `0 0 24px ${accent}`,
            transition: "background .2s ease, box-shadow .2s ease",
          }}
        />
      </div>

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div style={{ fontFamily: MONO, fontSize: 11, color: sub, letterSpacing: 2 }}>
          RISK SCORE
        </div>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 128,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: -5,
            color: ink,
            textShadow: `0 0 30px ${accentDim}`,
            transition: "text-shadow .3s ease",
          }}
        >
          {String(risk).padStart(2, "0")}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 12, color: sub, letterSpacing: 1 }}>
          OUT OF 100
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 28,
          left: 60,
          fontFamily: MONO,
          fontSize: 10,
          color: sub,
          letterSpacing: 1,
        }}
      >
        PRESERVE
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 28,
          right: 60,
          fontFamily: MONO,
          fontSize: 10,
          color: sub,
          letterSpacing: 1,
        }}
      >
        MAXIMIZE
      </div>
    </div>
  );
}
