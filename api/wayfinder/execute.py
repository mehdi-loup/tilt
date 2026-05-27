"""Vercel Python serverless function — Wayfinder strategy executor.

Receives a strategy request, runs the appropriate Wayfinder strategy against
the user's Privy server-side wallet, returns the txhashes/results.

This colocates a Python function inside the Next.js project. Vercel detects
`api/*.py` and deploys each as its own Fluid-Compute Python lambda.

Authentication:
  - The Next.js app forwards the user's Privy JWT in `Authorization: Bearer …`.
  - We forward that JWT to Wayfinder/Privy via `system.api_key` config when
    running strategies, so signing stays bound to the user.

Status:
  Skeleton. The Wayfinder strategies (`hyperlend_stable_yield_strategy`,
  `multi_vault_split_strategy`, etc.) take Wayfinder-managed wallets, not
  arbitrary Privy wallet IDs. Wiring the Privy-server-wallet adapter into
  Wayfinder is left as the next implementation step — see EXECUTION.md.
"""

import json
import os
from http.server import BaseHTTPRequestHandler
from typing import Any

# Strategy name -> human-readable description. The actual implementation
# happens by importing wayfinder_paths.strategies.{name} at runtime once
# the Privy server-wallet adapter is in place.
SUPPORTED_STRATEGIES = {
    "stable_lender": "Aave V3 USDC supply on Base",
    "conservative_yield": "Aave + Lido stETH split",
    "balanced_defi": "Aave + LSTs + Curve + Pendle",
    "aggressive_growth": "+ restaking + Solana + memecoins",
    "max_speculation": "+ perps (Hyperliquid, GMX) + meme launches",
}


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._respond(400, {"error": "invalid JSON body"})
            return

        strategy = body.get("strategy")
        wallet_id = body.get("walletId")
        amount_usd = body.get("amountUsd")
        user_jwt = self._user_jwt()

        if strategy not in SUPPORTED_STRATEGIES:
            self._respond(400, {"error": f"unknown strategy: {strategy}"})
            return
        if not wallet_id:
            self._respond(400, {"error": "walletId required"})
            return
        if not user_jwt:
            self._respond(401, {"error": "missing user JWT"})
            return

        # TODO: wire wayfinder_paths.strategies.<strategy> with the Privy
        # server-wallet adapter and run deposit().
        # For now, return a deterministic shape so the Next.js side can
        # exercise the execution flow end-to-end.
        result = {
            "strategy": strategy,
            "description": SUPPORTED_STRATEGIES[strategy],
            "walletId": wallet_id,
            "amountUsd": amount_usd,
            "status": "scaffolded",
            "txHashes": [],
            "note": "Wayfinder→Privy adapter not yet wired. See EXECUTION.md.",
            "wayfinderApiKeyPresent": bool(os.environ.get("WAYFINDER_API_KEY")),
        }
        self._respond(200, result)

    def do_GET(self) -> None:  # noqa: N802 — required by BaseHTTPRequestHandler
        self._respond(200, {
            "ok": True,
            "service": "wayfinder-executor",
            "strategies": list(SUPPORTED_STRATEGIES.keys()),
        })

    def _user_jwt(self) -> str:
        auth = self.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return ""

    def _respond(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
