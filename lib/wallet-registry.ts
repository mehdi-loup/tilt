// Per-user server-wallet registry.
//
// For each authed Privy user, we provision one app-owned Privy server
// wallet and reuse it for all subsequent strategy execution. The user funds
// this wallet from their embedded wallet; Wayfinder / our server then
// drives the wallet to deploy the strategy.
//
// Persistence: in-process Map. This is fine for a single Lambda instance
// but will give an inconsistent view across regions and lose mappings on
// cold start. TODO: replace with a real DB (Neon / Upstash KV / Vercel
// Postgres marketplace integration) — see EXECUTION.md.

import "server-only";

import { privy } from "./privy-server";

export interface ServerWallet {
  walletId: string;
  address: string;
  chainType: "ethereum";
}

const userToWallet = new Map<string, ServerWallet>();

export async function getOrProvisionServerWallet(userId: string): Promise<ServerWallet> {
  const cached = userToWallet.get(userId);
  if (cached) return cached;

  const wallet = await privy.walletApi.createWallet({
    chainType: "ethereum",
  });

  const entry: ServerWallet = {
    walletId: wallet.id,
    address: wallet.address,
    chainType: "ethereum",
  };
  userToWallet.set(userId, entry);
  return entry;
}

export function lookupServerWallet(userId: string): ServerWallet | undefined {
  return userToWallet.get(userId);
}
