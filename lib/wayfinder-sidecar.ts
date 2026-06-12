// Thin client for the Wayfinder Python sidecar.
//
// Both the plan-build route (convert quote) and the execute-step route
// (convert + strategy execution) call the sidecar, so the origin + auth +
// internal-secret plumbing lives here once.

import "server-only";

export interface WayfinderResult {
  ok?: boolean;
  source?: "live" | "stub" | "job" | "missing-dep" | "wayfinder-error" | "error";
  success?: boolean;
  strategyName?: string;
  txHashes?: string[];
  note?: string;
  error?: string;
  status?: unknown;
  // strategy/run (async): ledger-backed job id; the client polls the execution
  jobId?: string;
  // fund/plan: Wayfinder-built funding transactions for the connected wallet
  txs?: { to: string; data: string; value: string; chainId: number; label?: string }[];
  // fund/balance: total investable USD value Wayfinder sees in the wallet
  investableUsd?: number;
}

/** Shared Next.js → sidecar secret. One secret, one purpose — no fallback. */
export function wayfinderInternalSecret(): string | undefined {
  return process.env.WAYFINDER_INTERNAL_SECRET;
}

function wayfinderSidecarUrl(origin: string, path: string): string {
  const configured = process.env.WAYFINDER_SIDECAR_URL?.trim();
  if (configured) return `${configured.replace(/\/+$/, "")}${path}`;
  // Dev fallback only; 404s here surface a clear configuration error.
  return `${origin}/api/wayfinder/execute`;
}

/**
 * POST to the Python sidecar (FastAPI: /fund/plan, /fund/balance,
 * /strategy/run). Production deployments must provide WAYFINDER_SIDECAR_URL
 * for the Cloud Run service.
 */
export async function callWayfinder(
  origin: string,
  jwt: string,
  path: "/fund/plan" | "/fund/balance" | "/strategy/run",
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; payload: WayfinderResult }> {
  const secret = wayfinderInternalSecret();
  if (!secret) {
    return {
      ok: false,
      status: 500,
      payload: { ok: false, error: "Wayfinder internal secret is not configured" },
    };
  }
  let res: Response;
  const url = wayfinderSidecarUrl(origin, path);
  if (!process.env.WAYFINDER_SIDECAR_URL?.trim() && process.env.NODE_ENV === "production") {
    return {
      ok: false,
      status: 503,
      payload: {
        ok: false,
        source: "error",
        error:
          "WAYFINDER_SIDECAR_URL is required in production. Deploy the Cloud Run sidecar and set its URL in Vercel.",
      },
    };
  }
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tilt-internal-secret": secret,
        // Not `Authorization`: Cloud Run intercepts Bearer tokens as Google IAM
        // auth and 401s anything that isn't a Google token. The sidecar reads
        // the user JWT from this custom header instead.
        "x-tilt-user-jwt": jwt,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      payload: {
        ok: false,
        error: err instanceof Error ? err.message : "wayfinder sidecar unreachable",
      },
    };
  }
  const payload = (await res.json().catch(() => ({}))) as WayfinderResult;
  if (res.status === 404 && !payload.error) {
    return {
      ok: false,
      status: 404,
      payload: {
        ok: false,
        source: "error",
        error:
          "Wayfinder sidecar route not found. Set WAYFINDER_SIDECAR_URL to the Cloud Run service URL.",
      },
    };
  }
  return { ok: res.ok, status: res.status, payload };
}
