// Per-user server-wallet registry.
//
// For each authed Privy user, we provision one app-owned Privy server wallet
// and reuse it for all subsequent strategy execution. The user funds this
// wallet from their connected funding wallet; Wayfinder / our server then drives the
// wallet to deploy the strategy.
//
// Persistence is the Neon Postgres ledger (server_wallets in db/schema.sql),
// replacing the old Upstash KV mapping. Local development falls back to an
// in-process Map only when DATABASE_URL is not present; production fails
// closed instead of silently losing mappings.

import "server-only";

import { privy } from "./privy-server";
import { dbConfigured, requireDbInProduction, sql } from "./db";

export interface ServerWallet {
  walletId: string;
  address: string;
  chainType: "ethereum";
}

// Per-instance cache in front of Postgres. When DATABASE_URL isn't configured
// (local dev) this map is the store of record instead of just a cache.
const localCache = new Map<string, ServerWallet>();

export async function getOrProvisionServerWallet(userId: string): Promise<ServerWallet> {
  const existing = await lookupServerWallet(userId);
  if (existing) return existing;

  requireDbInProduction("The server-wallet registry");

  const wallet = await privy.walletApi.createWallet({ chainType: "ethereum" });
  const entry: ServerWallet = {
    walletId: wallet.id,
    address: wallet.address,
    chainType: "ethereum",
  };

  if (!dbConfigured) {
    localCache.set(userId, entry);
    return entry;
  }

  // user_id is the primary key, so a concurrent provision races safely: the
  // first insert wins and everyone re-reads the winner. The loser's Privy
  // wallet is unused; log its id to keep it traceable.
  const inserted = (await sql()`
    insert into server_wallets (user_id, wallet_id, address)
    values (${userId}, ${entry.walletId}, ${entry.address})
    on conflict (user_id) do nothing
    returning wallet_id
  `) as Record<string, unknown>[];
  if (inserted.length === 0) {
    console.error(
      `Orphaned server wallet ${entry.walletId} (${entry.address}) for user ${userId}: lost provisioning race`,
    );
    const winner = await lookupServerWallet(userId);
    if (!winner) throw new Error("server-wallet registry write race resolution failed");
    return winner;
  }
  localCache.set(userId, entry);
  return entry;
}

export async function lookupServerWallet(userId: string): Promise<ServerWallet | undefined> {
  const cached = localCache.get(userId);
  if (cached) return cached;

  // Dev fallback: localCache is the store, so a miss means "not provisioned".
  if (!dbConfigured) return undefined;

  const rows = (await sql()`
    select wallet_id, address from server_wallets where user_id = ${userId}
  `) as Record<string, unknown>[];
  if (rows.length === 0) return undefined;
  const wallet: ServerWallet = {
    walletId: String(rows[0].wallet_id),
    address: String(rows[0].address),
    chainType: "ethereum",
  };
  localCache.set(userId, wallet);
  return wallet;
}
