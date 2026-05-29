"""Vercel Python serverless function — Wayfinder strategy executor.

Drives a Wayfinder strategy against the user's Privy server-side wallet.
Wayfinder strategy classes accept a `*_signing_callback` parameter in
their constructor; we wrap Privy's signing API as that callback so the
strategy code can do its multi-step deposit() without ever holding a
private key.

Request body (POST /api/wayfinder/execute):
    {
      "profileId": "stable_lender",
      "amountUsd": 100,
      "walletId":  "<privy-wallet-id>",
      "walletAddress": "0x...",
      "caip2": "eip155:8453"   # optional, defaults to Base
    }

Auth:
  - x-tilt-internal-secret: shared Next.js → Python sidecar secret
  - Authorization: Bearer <privy-user-access-token>  (forwarded from the
    Next.js side after verifyAuthToken).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import traceback
from http.server import BaseHTTPRequestHandler
from typing import Any, Awaitable, Callable

# Privy HTTP basic auth
PRIVY_API_BASE = os.environ.get("PRIVY_API_URL", "https://api.privy.io")
PRIVY_APP_ID = os.environ.get("PRIVY_APP_ID") or os.environ.get(
    "NEXT_PUBLIC_PRIVY_APP_ID", ""
)
PRIVY_APP_SECRET = os.environ.get("PRIVY_APP_SECRET", "")
INTERNAL_SECRET = os.environ.get("WAYFINDER_INTERNAL_SECRET") or PRIVY_APP_SECRET

DEFAULT_CAIP2 = "eip155:8453"  # Base mainnet


# ─── Profile → Wayfinder strategy mapping ────────────────────────────────
#
# Wayfinder ships 7 strategies. We map our 5 risk profiles to one (or in
# the future, a composition of) them. For this turn only `stable_lender`
# is fully wired — see EXECUTION.md for the remaining work.
PROFILE_STRATEGIES: dict[str, dict[str, Any]] = {
    "stable_lender": {
        "module": "wayfinder_paths.strategies.stablecoin_yield_strategy.strategy",
        "class_name": "StablecoinYieldStrategy",
        "chain": "base",
        "caip2": "eip155:8453",
        "min_amount_usd": 2.0,
    },
    "conservative_yield": {
        "todo": "Compose stablecoin_yield + multi_vault_split (needs HyperEVM bridge)",
    },
    "balanced_defi": {
        "todo": "Compose stablecoin_yield + moonwell_wsteth_loop (Base) + multi_vault_split (bridge needed)",
    },
    "aggressive_growth": {
        "todo": "Compose moonwell_wsteth_loop + basis_trading + projectx_thbill_usdc (multi-chain)",
    },
    "max_speculation": {
        "todo": "Compose moonwell_wsteth_loop + basis_trading + boros_hype (multi-chain)",
    },
}


# ─── Funding (wallet holdings → USDC on Base, delivered to server wallet) ─
#
# Wayfinder plans + builds the route that turns whatever the wallet holds
# into the target USDC on Base and delivers it to the server wallet,
# bridging across chains as needed. Wayfinder owns route selection,
# slippage, and bridge hops — we only pass the target + recipient and relay
# the built transactions for the user's embedded wallet to sign.
#
# Class/module names are a best-guess pending the real wayfinder-paths swap
# API — same convention as PROFILE_STRATEGIES above. Verify against the SDK
# before trusting a live run.
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

FUND_SPEC: dict[str, Any] = {
    "module": "wayfinder_paths.strategies.swap_strategy.strategy",  # TODO verify
    "class_name": "SwapStrategy",  # TODO verify
    "target_token": USDC_BASE,
    "target_caip2": "eip155:8453",
}


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 — required by BaseHTTPRequestHandler
        if not INTERNAL_SECRET:
            self._respond(503, {"error": "internal sidecar secret is not configured"})
            return
        if self.headers.get("x-tilt-internal-secret") != INTERNAL_SECRET:
            self._respond(403, {"error": "forbidden"})
            return

        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._respond(400, {"error": "invalid JSON body"})
            return

        profile_id = body.get("profileId")
        amount_usd = body.get("amountUsd")
        wallet_id = body.get("walletId")
        wallet_address = body.get("walletAddress")
        caip2 = body.get("caip2", DEFAULT_CAIP2)
        user_jwt = self._user_jwt()

        if not user_jwt:
            self._respond(401, {"error": "missing user JWT"})
            return

        # Funding is its own operation: Wayfinder plans + builds the txs that
        # move whatever the wallet holds into the server wallet as USDC on Base.
        if body.get("operation") == "fund":
            self._handle_fund(body)
            return

        if profile_id not in PROFILE_STRATEGIES:
            self._respond(400, {"error": f"unknown profileId: {profile_id}"})
            return
        if not (wallet_id and wallet_address and isinstance(amount_usd, (int, float))):
            self._respond(400, {"error": "walletId, walletAddress, amountUsd required"})
            return

        spec = PROFILE_STRATEGIES[profile_id]
        if "todo" in spec:
            # Profile recognised but Wayfinder composition not yet wired.
            self._respond(200, {
                "ok": True,
                "source": "stub",
                "profileId": profile_id,
                "note": spec["todo"],
                "txHashes": [],
            })
            return

        # ─── Drive Wayfinder ─────────────────────────────────────────
        try:
            result = asyncio.run(
                run_strategy(
                    spec=spec,
                    amount_usd=float(amount_usd),
                    wallet_id=wallet_id,
                    wallet_address=wallet_address,
                    caip2=caip2,
                )
            )
        except StrategyImportError as exc:
            # Wayfinder not installed in the deployment yet.
            self._respond(503, {
                "ok": False,
                "source": "missing-dep",
                "error": str(exc),
                "hint": "Add wayfinder-paths to api/wayfinder/requirements.txt and redeploy.",
            })
            return
        except Exception as exc:
            self._respond(502, {
                "ok": False,
                "source": "wayfinder-error",
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(),
            })
            return

        self._respond(200, {"ok": True, "source": "live", **result})

    def do_GET(self) -> None:  # noqa: N802
        self._respond(200, {
            "ok": True,
            "service": "wayfinder-executor",
            "profiles": list(PROFILE_STRATEGIES.keys()),
            "wayfinderInstalled": _wayfinder_installed(),
        })

    def _handle_fund(self, body: dict) -> None:
        """Plan funding, or report the wallet's investable balance.

        mode="plan":    Wayfinder builds the tx(s) that move the wallet's
                        holdings into the recipient (server) wallet as USDC
                        on Base. Returns unsigned txs for the user to sign.
        mode="balance": report the total investable USD Wayfinder sees, so
                        the UI's 25/50/75/100% presets have a base.
        """
        mode = body.get("mode", "plan")
        from_address = body.get("fromAddress")
        recipient_address = body.get("recipientAddress")
        target_units = body.get("targetUsdcUnits")
        amount_usd = body.get("amountUsd")
        target_caip2 = body.get("caip2", DEFAULT_CAIP2)

        if not from_address:
            self._respond(400, {"error": "fromAddress required"})
            return
        if mode == "plan" and not (recipient_address and target_units):
            self._respond(400, {
                "error": "recipientAddress and targetUsdcUnits required for plan",
            })
            return

        runner = balance_fund if mode == "balance" else plan_fund
        try:
            result = asyncio.run(
                runner(
                    from_address=from_address,
                    recipient_address=recipient_address,
                    target_usdc_units=int(target_units) if target_units else 0,
                    amount_usd=float(amount_usd) if amount_usd is not None else None,
                    target_caip2=target_caip2,
                )
            )
        except StrategyImportError as exc:
            self._respond(503, {
                "ok": False,
                "source": "missing-dep",
                "error": str(exc),
                "hint": "Add wayfinder-paths to api/wayfinder/requirements.txt and redeploy.",
            })
            return
        except Exception as exc:  # noqa: BLE001 — surface any Wayfinder failure
            self._respond(502, {
                "ok": False,
                "source": "wayfinder-error",
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(),
            })
            return

        self._respond(200, {"ok": True, "source": "live", **result})

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


class StrategyImportError(RuntimeError):
    pass


def _wayfinder_installed() -> bool:
    try:
        __import__("wayfinder_paths.core.strategies.Strategy")
        return True
    except ImportError:
        return False


# ─── Privy-as-Wayfinder signing-callback adapter ─────────────────────────


def make_privy_sign_callback(
    wallet_id: str, wallet_address: str, caip2: str
) -> Callable[[dict], Awaitable[bytes]]:
    """Return an `async (transaction: dict) -> bytes` matching Wayfinder's
    sign_callback contract. Signs via Privy's wallet RPC and returns raw
    signed-transaction bytes."""

    import httpx

    auth = (PRIVY_APP_ID, PRIVY_APP_SECRET)

    async def sign_callback(transaction: dict) -> bytes:
        # Wayfinder may not set `from`; Privy doesn't need it but mirroring
        # get_remote_sign_callback in wayfinder_paths/core/utils/wallets.py.
        transaction = {**transaction, "from": wallet_address}

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{PRIVY_API_BASE}/v1/wallets/{wallet_id}/rpc",
                headers={"privy-app-id": PRIVY_APP_ID},
                auth=auth,
                json={
                    "method": "eth_signTransaction",
                    "caip2": caip2,
                    "params": {"transaction": _prepare_tx_for_privy(transaction)},
                },
            )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"privy sign failed: {resp.status_code} {resp.text}"
            )
        body = resp.json()
        signed = body.get("data", {}).get("signed_transaction") or body.get(
            "signedTransaction"
        )
        if not signed:
            raise RuntimeError(f"privy returned no signed_transaction: {body!r}")
        return bytes.fromhex(signed.removeprefix("0x"))

    return sign_callback


def _prepare_tx_for_privy(tx: dict) -> dict:
    """Coerce a Wayfinder transaction dict into Privy's wallet-RPC shape.

    Wayfinder hands us integer fields (chainId, value, gas, etc.). Privy's
    RPC accepts hex strings for numerics. We pass `to`, `data`, `from`,
    `value`, `gas`, `nonce`, `chainId`, and the 1559 fields if present.
    """

    def hex_or_none(v: Any) -> str | None:
        if v is None:
            return None
        if isinstance(v, str):
            return v if v.startswith("0x") else hex(int(v))
        if isinstance(v, (int, float)):
            return hex(int(v))
        return v

    out = {
        "from": tx.get("from"),
        "to": tx.get("to"),
        "data": tx.get("data"),
    }
    for k in ("value", "gas", "gasLimit", "nonce", "chainId", "gasPrice",
              "maxFeePerGas", "maxPriorityFeePerGas", "type"):
        v = hex_or_none(tx.get(k))
        if v is not None:
            out[k] = v
    if "gasLimit" in out and "gas" not in out:
        out["gas"] = out.pop("gasLimit")
    return {k: v for k, v in out.items() if v is not None}


# ─── Strategy invocation ─────────────────────────────────────────────────


async def run_strategy(
    *,
    spec: dict[str, Any],
    amount_usd: float,
    wallet_id: str,
    wallet_address: str,
    caip2: str,
) -> dict[str, Any]:
    """Instantiate a Wayfinder strategy with our Privy-backed signer and
    call deposit(amount)."""
    if not _wayfinder_installed():
        raise StrategyImportError(
            "wayfinder_paths is not installed in this Python runtime"
        )

    module_path: str = spec["module"]
    class_name: str = spec["class_name"]
    min_amount = float(spec.get("min_amount_usd", 0))
    if amount_usd < min_amount:
        raise ValueError(
            f"amount {amount_usd} below {class_name} minimum {min_amount}"
        )

    # Dynamic import keeps the function importable even when Wayfinder
    # isn't installed (the GET handler reports it).
    module = __import__(module_path, fromlist=[class_name])
    StrategyClass = getattr(module, class_name)

    sign_callback = make_privy_sign_callback(wallet_id, wallet_address, caip2)
    wallet_entry = {"address": wallet_address, "label": "tilt-server"}

    strategy = StrategyClass(
        config={},
        main_wallet=wallet_entry,
        strategy_wallet=wallet_entry,
        main_wallet_signing_callback=sign_callback,
        strategy_wallet_signing_callback=sign_callback,
    )

    status = await strategy.deposit(main_token_amount=amount_usd)
    # `status` is a StatusTuple — convert to JSON-safe dict.
    return _serialize_status(status)


# ─── Funding conversion ──────────────────────────────────────────────────


def _make_fund_strategy(from_address: str) -> Any:
    """Instantiate the Wayfinder swap/bridge planner for `from_address`.

    Route-building and balance reads are non-signing, so unlike run_strategy
    we don't attach a Privy callback here — the embedded wallet signs the
    built txs client-side. TODO: confirm the planner constructor against the
    SDK (strategy deposits take signing callbacks; route building shouldn't)."""
    if not _wayfinder_installed():
        raise StrategyImportError(
            "wayfinder_paths is not installed in this Python runtime"
        )
    module = __import__(FUND_SPEC["module"], fromlist=[FUND_SPEC["class_name"]])
    StrategyClass = getattr(module, FUND_SPEC["class_name"])
    wallet_entry = {"address": from_address, "label": "tilt-user"}
    return StrategyClass(
        config={},
        main_wallet=wallet_entry,
        strategy_wallet=wallet_entry,
    )


async def plan_fund(
    *,
    from_address: str,
    recipient_address: str,
    target_usdc_units: int,
    amount_usd: float | None,
    target_caip2: str,
) -> dict[str, Any]:
    """Ask Wayfinder to build the transaction(s) that move the wallet's
    holdings into `recipient_address` as USDC on Base. Returns unsigned txs
    for the embedded wallet to sign."""
    planner = _make_fund_strategy(from_address)
    # TODO: confirm Wayfinder's route-build method name + signature.
    route = await planner.build_funding_route(
        from_address=from_address,
        recipient=recipient_address,
        target_token=FUND_SPEC["target_token"],
        target_caip2=target_caip2,
        target_amount=target_usdc_units,
    )
    return {"mode": "plan", "txs": _normalize_txs(route)}


async def balance_fund(
    *,
    from_address: str,
    recipient_address: str | None,
    target_usdc_units: int,
    amount_usd: float | None,
    target_caip2: str,
) -> dict[str, Any]:
    """Report the total investable USD value Wayfinder sees in the wallet,
    so the UI's 25/50/75/100% presets have a base."""
    planner = _make_fund_strategy(from_address)
    # TODO: confirm Wayfinder's balance/portfolio method name + signature.
    value = await planner.investable_value(
        from_address=from_address,
        quote_token=FUND_SPEC["target_token"],
        quote_caip2=target_caip2,
    )
    return {"mode": "balance", "investableUsd": float(value)}


def _normalize_txs(route: Any) -> list[dict[str, Any]]:
    """Coerce Wayfinder's built route into [{to, data, value, chainId, label}]
    so the client can sign each leg with the embedded wallet."""
    raw = route.get("transactions") if isinstance(route, dict) else route
    out: list[dict[str, Any]] = []
    for t in raw or []:
        d = t if isinstance(t, dict) else getattr(t, "__dict__", {})
        value = d.get("value", "0x0")
        if isinstance(value, int):
            value = hex(value)
        out.append({
            "to": d.get("to"),
            "data": d.get("data", "0x"),
            "value": value or "0x0",
            "chainId": int(d.get("chainId") or d.get("chain_id") or 8453),
            "label": d.get("label"),
        })
    return out


def _serialize_status(status: Any) -> dict[str, Any]:
    """Best-effort JSON serialization of a Wayfinder StatusTuple."""
    if status is None:
        return {"status": None}
    if isinstance(status, dict):
        return {"status": _jsonable(status)}
    if hasattr(status, "_asdict"):
        return {"status": _jsonable(status._asdict())}
    return {"status": _jsonable(status)}


def _jsonable(v: Any) -> Any:
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, bytes):
        return base64.b64encode(v).decode()
    return str(v)
