// DefiLlama yield aggregator + Vercel Runtime Cache resilience layer.
// Server-only — pulls @vercel/functions and the bundled snapshot, neither
// of which belong in the client bundle. Client code should import from
// `./rates-shared` instead.

import "server-only";

import { PROJECT_SLUGS, type PlatformRate } from "./rates-shared";

export { PROJECT_SLUGS, PLATFORM_NAME_TO_KEY } from "./rates-shared";
export type { PlatformRate, PlatformRateKey } from "./rates-shared";

const LLAMA_POOLS_URL = "https://yields.llama.fi/pools";

interface LlamaPool {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number | null;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  apyPct7D: number | null;
  pool: string;
  outlier: boolean;
}

interface LlamaResponse {
  status: string;
  data: LlamaPool[];
}

function tvlWeighted(
  pools: LlamaPool[],
  pick: (p: LlamaPool) => number | null,
): number | null {
  const usable = pools
    .map((p) => {
      const a = pick(p);
      const tvl = p.tvlUsd ?? 0;
      return a != null && tvl > 0 ? { a, tvl } : null;
    })
    .filter((x): x is { a: number; tvl: number } => x != null);
  if (usable.length === 0) return null;
  const totalTvl = usable.reduce((s, x) => s + x.tvl, 0);
  if (totalTvl === 0) return null;
  return usable.reduce((s, x) => s + (x.a * x.tvl) / totalTvl, 0);
}

// ─── Three-layer cache ────────────────────────────────────────
// Plans MUST render even if DefiLlama is down on cold start, so we layer:
//   1. In-process memo      — sub-ms when warm, scoped to one Lambda instance
//   2. Vercel Runtime Cache — shared across instances in a region, survives deploys
//   3. Bundled snapshot     — last-known-good baked into the deploy bundle
//
// Freshness is read from the payload's `fetchedAt`, not the cache's TTL.
// We hold cache entries for 24h so a stale-but-existing read always wins
// over a cold fetch, then refresh in the background.

import { getCache } from "@vercel/functions";
import snapshot from "./rates-snapshot.json";

const FRESH_TTL_MS = 10 * 60 * 1000; // payload considered fresh for 10 min
const RUNTIME_TTL_S = 24 * 60 * 60; // Runtime Cache holds entries 24h
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_KEY = "rates:all:v1";
const CACHE_TAG = "rates";

export interface RatesPayload {
  rates: Record<string, PlatformRate>;
  fetchedAt: number;
  source: "memo" | "runtime-cache" | "live" | "snapshot";
  stale: boolean;
}

interface CacheEntry {
  rates: Record<string, PlatformRate>;
  fetchedAt: number;
}

const SNAPSHOT_ENTRY: CacheEntry = {
  rates: snapshot.rates as Record<string, PlatformRate>,
  fetchedAt: new Date(snapshot.capturedAt).getTime() || 0,
};

let memo: CacheEntry | null = null;
let inflight: Promise<CacheEntry | null> | null = null;

const isFresh = (entry: CacheEntry) => Date.now() - entry.fetchedAt < FRESH_TTL_MS;

/**
 * Resilient rates accessor. Never throws — always returns a payload, even if
 * every upstream is unavailable (falls back to bundled snapshot).
 */
export async function getRates(): Promise<RatesPayload> {
  // 1. In-process memo
  if (memo && isFresh(memo)) {
    return { ...memo, source: "memo", stale: false };
  }

  // 2. Vercel Runtime Cache
  const cached = await readRuntimeCache();
  if (cached) {
    memo = cached;
    if (isFresh(cached)) {
      return { ...cached, source: "runtime-cache", stale: false };
    }
    // Stale: serve it now, refresh in the background.
    void revalidate();
    return { ...cached, source: "runtime-cache", stale: true };
  }

  // 3. Try a live fetch (with timeout). On success → write all layers.
  const fresh = await tryFetch();
  if (fresh) {
    memo = fresh;
    void writeRuntimeCache(fresh);
    return { ...fresh, source: "live", stale: false };
  }

  // 4. Bundled snapshot — last-known-good. Always available.
  return { ...SNAPSHOT_ENTRY, source: "snapshot", stale: true };
}

/** Back-compat alias for code that just wants the rates map. */
export async function fetchAllRates(): Promise<Record<string, PlatformRate>> {
  return (await getRates()).rates;
}

async function readRuntimeCache(): Promise<CacheEntry | null> {
  try {
    const cache = getCache();
    const v = (await cache.get(CACHE_KEY)) as CacheEntry | undefined;
    return v && typeof v.fetchedAt === "number" && v.rates ? v : null;
  } catch {
    return null;
  }
}

async function writeRuntimeCache(entry: CacheEntry): Promise<void> {
  try {
    await getCache().set(CACHE_KEY, entry, {
      ttl: RUNTIME_TTL_S,
      tags: [CACHE_TAG],
      name: "tilt-rates",
    });
  } catch {
    // Cache write failures are non-fatal — we still have memo + snapshot.
  }
}

async function revalidate(): Promise<void> {
  if (inflight) return;
  inflight = tryFetch().finally(() => {
    inflight = null;
  });
  const next = await inflight;
  if (next) {
    memo = next;
    void writeRuntimeCache(next);
  }
}

async function tryFetch(): Promise<CacheEntry | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LLAMA_POOLS_URL, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as LlamaResponse;
    const rates = aggregate(body.data ?? []);
    return { rates, fetchedAt: Date.now() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function aggregate(pools: LlamaPool[]): Record<string, PlatformRate> {
  // Bucket pools by project slug for O(N + K) instead of O(N*K).
  const byProject = new Map<string, LlamaPool[]>();
  for (const p of pools) {
    if (p.outlier) continue;
    if ((p.tvlUsd ?? 0) < 100_000) continue;
    const bucket = byProject.get(p.project);
    if (bucket) bucket.push(p);
    else byProject.set(p.project, [p]);
  }

  const out: Record<string, PlatformRate> = {};
  for (const [key, slugs] of Object.entries(PROJECT_SLUGS)) {
    const matched = slugs.flatMap((s) => byProject.get(s) ?? []);
    out[key] = {
      apy: tvlWeighted(matched, (p) => p.apy),
      apyMean30d: tvlWeighted(matched, (p) => p.apyMean30d),
      sampleSize: matched.length,
      totalTvlUsd: matched.reduce((s, p) => s + (p.tvlUsd ?? 0), 0),
    };
  }
  return out;
}

/** Used by the refresh route to force a write-through revalidation. */
export async function forceRevalidate(): Promise<RatesPayload> {
  const fresh = await tryFetch();
  if (!fresh) {
    return { ...SNAPSHOT_ENTRY, source: "snapshot", stale: true };
  }
  memo = fresh;
  await writeRuntimeCache(fresh);
  return { ...fresh, source: "live", stale: false };
}
