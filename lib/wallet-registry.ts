// Per-user server-wallet registry.
//
// For each authed Privy user, we provision one app-owned Privy server wallet
// and reuse it for all subsequent strategy execution. The user funds this
// wallet from their embedded wallet; Wayfinder / our server then drives the
// wallet to deploy the strategy.
//
// Production persistence is backed by Upstash/Vercel KV's Redis REST API.
// Local development falls back to an in-process Map only when KV env vars are
// not present; production fails closed instead of silently losing mappings.

import "server-only";

import { randomUUID } from "crypto";
import { privy } from "./privy-server";

export interface ServerWallet {
  walletId: string;
  address: string;
  chainType: "ethereum";
}

interface RedisResponse<T> {
  result?: T;
  error?: string;
}

const keyPrefix = process.env.SERVER_WALLET_REGISTRY_PREFIX ?? "tilt:server-wallet";
const lockTtlSeconds = 30;
const localCache = new Map<string, ServerWallet>();
const memoryFallback = new Map<string, ServerWallet>();

const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const registryConfigured = Boolean(redisUrl && redisToken);

export async function getOrProvisionServerWallet(userId: string): Promise<ServerWallet> {
  const existing = await lookupServerWallet(userId);
  if (existing) return existing;

  if (!registryConfigured && process.env.NODE_ENV === "production") {
    throw new Error(
      "Persistent server-wallet registry is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.",
    );
  }

  if (!registryConfigured) {
    return getOrProvisionMemoryWallet(userId);
  }

  const lockToken = randomUUID();
  const lockKey = serverWalletLockKey(userId);
  const acquired = await acquireLock(lockKey, lockToken);
  if (!acquired) {
    const wallet = await waitForPersistedWallet(userId);
    if (wallet) return wallet;
    throw new Error("Server wallet provisioning is already in progress; retry shortly.");
  }

  try {
    const afterLock = await lookupServerWallet(userId);
    if (afterLock) return afterLock;

    const wallet = await privy.walletApi.createWallet({ chainType: "ethereum" });
    const entry: ServerWallet = {
      walletId: wallet.id,
      address: wallet.address,
      chainType: "ethereum",
    };
    await writePersistedWallet(userId, entry);
    localCache.set(userId, entry);
    return entry;
  } finally {
    await releaseLock(lockKey, lockToken).catch(() => undefined);
  }
}

export async function lookupServerWallet(userId: string): Promise<ServerWallet | undefined> {
  const cached = localCache.get(userId);
  if (cached) return cached;

  if (!registryConfigured) {
    return memoryFallback.get(userId);
  }

  const raw = await redisCommand<unknown>(["GET", serverWalletKey(userId)]);
  const wallet = parseWallet(raw);
  if (wallet) localCache.set(userId, wallet);
  return wallet;
}

async function getOrProvisionMemoryWallet(userId: string): Promise<ServerWallet> {
  const cached = memoryFallback.get(userId);
  if (cached) return cached;

  const wallet = await privy.walletApi.createWallet({ chainType: "ethereum" });
  const entry: ServerWallet = {
    walletId: wallet.id,
    address: wallet.address,
    chainType: "ethereum",
  };
  memoryFallback.set(userId, entry);
  localCache.set(userId, entry);
  return entry;
}

async function writePersistedWallet(userId: string, wallet: ServerWallet): Promise<void> {
  const result = await redisCommand<string>([
    "SET",
    serverWalletKey(userId),
    JSON.stringify(wallet),
  ]);
  if (result !== "OK") {
    throw new Error("Failed to persist server wallet mapping");
  }
}

async function acquireLock(lockKey: string, token: string): Promise<boolean> {
  const result = await redisCommand<string | null>([
    "SET",
    lockKey,
    token,
    "NX",
    "EX",
    lockTtlSeconds,
  ]);
  return result === "OK";
}

async function releaseLock(lockKey: string, token: string): Promise<void> {
  await redisCommand<number>([
    "EVAL",
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    "1",
    lockKey,
    token,
  ]);
}

async function waitForPersistedWallet(userId: string): Promise<ServerWallet | undefined> {
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    const wallet = await lookupServerWallet(userId);
    if (wallet) return wallet;
  }
  return undefined;
}

async function redisCommand<T>(command: Array<string | number>): Promise<T | undefined> {
  if (!redisUrl || !redisToken) {
    throw new Error("Redis/KV registry requested without REST URL/token");
  }
  const res = await fetch(redisUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${redisToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as RedisResponse<T>;
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `Redis/KV command failed with HTTP ${res.status}`);
  }
  return body.result;
}

function parseWallet(raw: unknown): ServerWallet | undefined {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.walletId !== "string" ||
    typeof record.address !== "string" ||
    record.chainType !== "ethereum"
  ) {
    return undefined;
  }
  return {
    walletId: record.walletId,
    address: record.address,
    chainType: "ethereum",
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function serverWalletKey(userId: string): string {
  return `${keyPrefix}:${encodeURIComponent(userId)}`;
}

function serverWalletLockKey(userId: string): string {
  return `${serverWalletKey(userId)}:lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
