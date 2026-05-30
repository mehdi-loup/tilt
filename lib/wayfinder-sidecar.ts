// Thin client for the Wayfinder Python sidecar at /api/wayfinder/execute.
//
// Both the plan-build route (convert quote) and the execute-step route
// (convert + strategy execution) call the sidecar, so the origin + auth +
// internal-secret plumbing lives here once.

import "server-only";

export interface WayfinderResult {
  ok?: boolean;
  source?: "live" | "stub" | "missing-dep" | "wayfinder-error" | "error";
  success?: boolean;
  strategyName?: string;
  txHashes?: string[];
  note?: string;
  error?: string;
  status?: unknown;
  // fund-plan: Wayfinder-built funding transactions for the embedded wallet
  txs?: { to: string; data: string; value: string; chainId: number; label?: string }[];
  // fund-balance: total investable USD value Wayfinder sees in the wallet
  investableUsd?: number;
}

/** Shared Next.js → sidecar secret. Falls back to PRIVY_APP_SECRET. */
export function wayfinderInternalSecret(): string | undefined {
  return process.env.WAYFINDER_INTERNAL_SECRET ?? process.env.PRIVY_APP_SECRET;
}

/**
 * POST to the colocated Python sidecar. `origin` comes from the inbound
 * request URL; `jwt` is the user's verified Privy access token, forwarded
 * so the sidecar can re-check auth.
 */
export async function callWayfinder(
  origin: string,
  jwt: string,
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
  try {
    res = await fetch(`${origin}/api/wayfinder/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tilt-internal-secret": secret,
        authorization: `Bearer ${jwt}`,
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
  return { ok: res.ok, status: res.status, payload };
}
