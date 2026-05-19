"use client";

import { useEffect, useState } from "react";
import type { PlatformRate } from "./rates-shared";

export interface RatesState {
  rates: Record<string, PlatformRate> | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  source: "memo" | "runtime-cache" | "live" | "snapshot" | null;
  stale: boolean;
}

interface ApiPayload {
  rates: Record<string, PlatformRate>;
  fetchedAt: number;
  source: RatesState["source"];
  stale: boolean;
}

let cache: RatesState | null = null;
let inflight: Promise<RatesState> | null = null;

async function load(): Promise<RatesState> {
  try {
    const res = await fetch("/api/rates", { cache: "no-store" });
    if (!res.ok) {
      return {
        rates: null,
        loading: false,
        error: `HTTP ${res.status}`,
        fetchedAt: null,
        source: null,
        stale: false,
      };
    }
    const body = (await res.json()) as ApiPayload;
    return {
      rates: body.rates,
      loading: false,
      error: null,
      fetchedAt: body.fetchedAt,
      source: body.source,
      stale: body.stale,
    };
  } catch (err) {
    return {
      rates: null,
      loading: false,
      error: err instanceof Error ? err.message : "fetch failed",
      fetchedAt: null,
      source: null,
      stale: false,
    };
  }
}

export function useRates(): RatesState {
  const [state, setState] = useState<RatesState>(
    cache ?? {
      rates: null,
      loading: true,
      error: null,
      fetchedAt: null,
      source: null,
      stale: false,
    },
  );

  useEffect(() => {
    if (cache) {
      setState(cache);
      return;
    }
    inflight ??= load();
    inflight.then((next) => {
      cache = next;
      setState(next);
    });
  }, []);

  return state;
}
