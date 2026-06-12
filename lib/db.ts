// Neon Postgres client (HTTP driver, works inside Vercel functions).
//
// THE ledger: executions, steps, tx hashes, and the server-wallet registry
// (db/schema.sql). When DATABASE_URL is unset, callers fall back to
// in-process storage in local dev and fail closed in production — the same
// posture the old KV registry had.

import "server-only";

import { neon } from "@neondatabase/serverless";

export const dbConfigured = Boolean(process.env.DATABASE_URL);

let client: ReturnType<typeof neon> | undefined;

/** Tagged-template SQL query against Neon. Throws if DATABASE_URL is unset. */
export function sql(): ReturnType<typeof neon> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }
  client ??= neon(process.env.DATABASE_URL);
  return client;
}

export function requireDbInProduction(what: string): void {
  if (!dbConfigured && process.env.NODE_ENV === "production") {
    throw new Error(`${what} requires DATABASE_URL in production.`);
  }
}
