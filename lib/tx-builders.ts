// Calldata builders for the funding step.
//
// Only the embedded-wallet funding leg (USDC.transfer from user → server
// wallet) is composed here. Every other on-chain action is built by
// Wayfinder inside the Python sidecar — we don't reimplement strategy
// routing, swap calldata, or LP composition in TypeScript.

import { encodeFunctionData, type Hex } from "viem";

export interface TxRequest {
  to: Hex;
  data: Hex;
  value: bigint;
}

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
] as const;

export function buildErc20Transfer(token: Hex, to: Hex, amount: bigint): TxRequest {
  return {
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] }),
    value: 0n,
  };
}
