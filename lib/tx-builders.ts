// Calldata builders for the on-chain actions in a transaction plan.
//
// Each builder returns `{ to, data, value }` ready to be passed to either:
//   - Privy embedded wallet (client-side, useSendTransaction)  → for the
//     initial "fund server wallet" step the user signs themselves
//   - Privy server wallet API (server-side, walletApi.ethereum.sendTransaction)
//     → for the strategy execution steps the server runs without prompts
//
// Pure functions over viem encoders — safe in both runtimes.

import { encodeFunctionData, type Hex } from "viem";
import { AAVE_V3_BASE, TOKENS } from "./chains";

export interface TxRequest {
  to: Hex;
  data: Hex;
  value: bigint;
}

// ─── ERC-20 ───────────────────────────────────────────────────────────────
const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export function buildErc20Transfer(token: Hex, to: Hex, amount: bigint): TxRequest {
  return {
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] }),
    value: 0n,
  };
}

export function buildErc20Approve(token: Hex, spender: Hex, amount: bigint): TxRequest {
  return {
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }),
    value: 0n,
  };
}

// ─── Aave V3 Pool ─────────────────────────────────────────────────────────
const AAVE_POOL_ABI = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export function buildAaveSupplyUsdc(amount: bigint, onBehalfOf: Hex): TxRequest {
  return {
    to: AAVE_V3_BASE.pool,
    data: encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: "supply",
      args: [TOKENS.USDC, amount, onBehalfOf, 0],
    }),
    value: 0n,
  };
}
