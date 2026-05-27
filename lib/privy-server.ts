// Server-only Privy client. Used to verify the user's auth, provision a
// Privy server-side wallet owned by that user, and drive the wallet via
// walletApi.rpc(...) to send EVM transactions.

import "server-only";

import { PrivyClient } from "@privy-io/server-auth";

const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;

if (!appId || !appSecret) {
  throw new Error(
    "Privy env vars missing — set NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET",
  );
}

export const privy = new PrivyClient(appId, appSecret);

export interface AuthedUser {
  userId: string;
  jwt: string;
}

/**
 * Verify the incoming request's Privy access token. Returns the user id +
 * the raw JWT (the raw JWT is what we forward to walletApi.rpc as auth
 * context for signing).
 */
export async function authenticate(req: Request): Promise<AuthedUser | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const jwt = m[1].trim();
  try {
    const claims = await privy.verifyAuthToken(jwt);
    return { userId: claims.userId, jwt };
  } catch {
    return null;
  }
}
