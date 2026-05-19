import { NextResponse } from "next/server";
import { getRates, forceRevalidate } from "@/lib/rates";

// In-process memo + Vercel Runtime Cache + bundled snapshot all live in
// lib/rates.ts. Plans always get an answer, even on cold start with
// DefiLlama down.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const payload = refresh ? await forceRevalidate() : await getRates();

  // Tell the CDN how to treat the response based on freshness/source.
  const cacheControl = payload.stale
    ? "public, s-maxage=60, stale-while-revalidate=600"
    : "public, s-maxage=300, stale-while-revalidate=600";

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": cacheControl,
      "X-Rates-Source": payload.source,
      "X-Rates-Stale": String(payload.stale),
      "X-Rates-Fetched-At": String(payload.fetchedAt),
    },
  });
}
