"""Vercel Python serverless function — Wayfinder strategy executor.

Drives a Wayfinder strategy against the user's Privy server-side wallet.
Wayfinder strategy classes accept a `*_signing_callback` parameter in
their constructor; we wrap Privy's signing API as that callback so the
strategy code can do its multi-step deposit() without ever holding a
private key.

Request body (POST /api/wayfinder/execute):
    {
      "profileId": "stable_lender",
      "strategyName": "stablecoin_yield_strategy",
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


# ─── Profile/step → Wayfinder strategy mapping ─────────────────────────────
#
# Wayfinder ships several strategies. The TypeScript planner sends the
# concrete `strategyName` for each executable step; `PROFILE_STRATEGIES` keeps
# backward compatibility for the single-step stable_lender profile and returns
# honest stub notes for profiles that still need target-chain funding.
STRATEGY_SPECS: dict[str, dict[str, Any]] = {
    "stablecoin_yield_strategy": {
        "module": "wayfinder_paths.strategies.stablecoin_yield_strategy.strategy",
        "class_name": "StablecoinYieldStrategy",
        "chain": "base",
        "caip2": "eip155:8453",
        "min_amount_usd": 2.0,
        # deposit() only stages funds into the strategy wallet; update()
        # actually rotates into the selected yield pool.
        "run_update_after_deposit": True,
    },
    "moonwell_wsteth_loop_strategy": {
        "module": "wayfinder_paths.strategies.moonwell_wsteth_loop_strategy.strategy",
        "class_name": "MoonwellWstethLoopStrategy",
        "chain": "base",
        "caip2": "eip155:8453",
        "min_amount_usd": 10.0,
        # deposit() stages Base USDC/ETH; update() deploys to Moonwell.
        "run_update_after_deposit": True,
    },
}

PROFILE_STRATEGIES: dict[str, dict[str, Any]] = {
    "stable_lender": {
        "strategy_name": "stablecoin_yield_strategy",
    },
    "conservative_yield": {
        "todo": "Needs Base + target-chain composition; multi_vault_split requires Arbitrum/HyperEVM funding.",
    },
    "balanced_defi": {
        "todo": "Base strategies are wired, but the full profile still needs target-chain funding for multi_vault_split.",
    },
    "aggressive_growth": {
        "todo": "Moonwell is wired; basis_trading/projectx need Arbitrum/HyperEVM/Hyperliquid prefunding.",
    },
    "max_speculation": {
        "todo": "Moonwell is wired; basis_trading/boros need multi-chain prefunding and orchestration.",
    },
}


# ─── Funding (wallet holdings → USDC on Base, delivered to server wallet) ─
#
# Wayfinder has no single "fund this wallet" strategy; funding is built from
# two SDK primitives:
#   • BalanceClient.get_enriched_wallet_balances → what the wallet holds,
#     priced in USD (drives both the balance preset and source selection).
#   • BRAPAdapter.best_quote → a swap route (token → USDC on Base) with the
#     unsigned calldata to execute it.
# A BRAP swap delivers its output to the *signing* wallet, so the route we
# return ends with a plain USDC transfer that moves the requested amount from
# the embedded wallet into the server wallet. Every leg is unsigned calldata
# for the embedded wallet to sign client-side.
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_DECIMALS = 6

# Native-token sentinels: BRAP handles native ETH input itself (no ERC-20
# approval, value carried in the swap calldata), so we never emit an approve
# leg for these. The enriched-balances API reports native ETH as "native".
NATIVE_SENTINELS = {
    "native",
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "0x0000000000000000000000000000000000000000",
}

# Skip dust holdings — not worth a swap leg / gas.
MIN_SOURCE_USD = 0.50
# Headroom over the USD we need from each swap, to absorb slippage so the
# final fixed-amount transfer to the server wallet still clears.
SWAP_BUFFER = 1.01

BASE_CHAIN_ID = 8453  # funding target (target_caip2 is always eip155:8453)

# Off-Base native value (USD) to keep for gas on a source chain, so we don't
# swap away the ETH/etc. the embedded wallet needs to pay for its approve/swap
# there. Ethereum L1 gas is dear, so it reserves more.
NATIVE_GAS_RESERVE_USD: dict[int, float] = {1: 20.0}
DEFAULT_NATIVE_RESERVE_USD = 1.50

# Base ETH the embedded wallet must keep — and never swap. This is a *raw* wei
# amount, not USD: the first plan step sends a fixed 0.001 ETH gas float to the
# server wallet (mirror GAS_FUNDING_WEI in lib/strategy-plan.ts), plus padding
# for the wallet's own Base funding-tx gas. StablecoinYieldStrategy requires
# at least 0.001 ETH available before deposit/update.
GAS_FLOAT_WEI = 1_000_000_000_000_000        # 0.001 ETH
BASE_GAS_PADDING_WEI = 300_000_000_000_000   # ~0.0003 ETH for the wallet's own txs
BASE_GAS_RESERVE_WEI = GAS_FLOAT_WEI + BASE_GAS_PADDING_WEI

# Chains we both route through and can confirm a receipt on. Must mirror
# RPC_URLS in lib/chains.ts — we only fund from these so every leg is
# verifiable client-side rather than optimistically assumed mined.
SUPPORTED_CHAINS = {1, 10, 56, 137, 5000, 8453, 42161, 43114}

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
        strategy_name = body.get("strategyName")
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

        profile_spec = PROFILE_STRATEGIES[profile_id]
        if strategy_name:
            spec = STRATEGY_SPECS.get(strategy_name)
            if spec is None:
                self._respond(400, {"error": f"unknown strategyName: {strategy_name}"})
                return
        elif "strategy_name" in profile_spec:
            strategy_name = profile_spec["strategy_name"]
            spec = STRATEGY_SPECS[strategy_name]
        elif "todo" in profile_spec:
            # Profile recognised but Wayfinder composition not yet wired.
            self._respond(200, {
                "ok": True,
                "source": "stub",
                "profileId": profile_id,
                "note": profile_spec["todo"],
                "txHashes": [],
            })
            return
        else:
            self._respond(400, {"error": f"profile {profile_id} has no strategy mapping"})
            return

        # ─── Drive Wayfinder ─────────────────────────────────────────
        try:
            result = asyncio.run(
                run_strategy(
                    strategy_name=strategy_name,
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

        if not result.get("success", False):
            self._respond(502, {"ok": False, "source": "wayfinder-error", **result})
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
    strategy_name: str,
    spec: dict[str, Any],
    amount_usd: float,
    wallet_id: str,
    wallet_address: str,
    caip2: str,
) -> dict[str, Any]:
    """Instantiate a Wayfinder strategy with our Privy-backed signer and run
    the full deposit lifecycle needed for deployed funds."""
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
    expected_caip2 = spec.get("caip2")
    if expected_caip2 and caip2 != expected_caip2:
        raise ValueError(f"{class_name} requires {expected_caip2}, got {caip2}")

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

    lifecycle: dict[str, Any] = {
        "deposit": _serialize_status(
            await strategy.deposit(main_token_amount=amount_usd)
        )
    }
    deposit_ok, deposit_message = _status_ok_message(lifecycle["deposit"])
    if not deposit_ok:
        return {
            "success": False,
            "strategyName": strategy_name,
            "error": f"deposit failed: {deposit_message}",
            "status": lifecycle,
            "txHashes": [],
        }

    if spec.get("run_update_after_deposit"):
        lifecycle["update"] = _serialize_status(await strategy.update())
        update_ok, update_message = _status_ok_message(lifecycle["update"])
        if not update_ok:
            return {
                "success": False,
                "strategyName": strategy_name,
                "error": f"update failed: {update_message}",
                "status": lifecycle,
                "txHashes": [],
            }

    return {
        "success": True,
        "strategyName": strategy_name,
        "status": lifecycle,
        "txHashes": [],
    }


# ─── Funding conversion ──────────────────────────────────────────────────


def _caip2_chain_id(caip2: str) -> int:
    """`eip155:8453` → 8453."""
    return int(caip2.rsplit(":", 1)[-1])


async def _enriched_balances(from_address: str) -> list[dict[str, Any]]:
    if not _wayfinder_installed():
        raise StrategyImportError(
            "wayfinder_paths is not installed in this Python runtime"
        )
    from wayfinder_paths.core.clients.BalanceClient import BALANCE_CLIENT

    data = await BALANCE_CLIENT.get_enriched_wallet_balances(
        wallet_address=from_address, exclude_spam_tokens=True
    )
    balances = data.get("balances") if isinstance(data, dict) else None
    return [b for b in (balances or []) if isinstance(b, dict)]


def _bridgeable(b: dict[str, Any]) -> bool:
    """A holding BRAP can route to USDC on Base. We invest across every EVM
    chain (BRAP bridges to Base as needed), excluding non-EVM (e.g. Solana)."""
    return (
        int(b.get("chain_id") or 0) > 0
        and str(b.get("chain") or "").lower() != "solana"
    )


def _is_native(b: dict[str, Any]) -> bool:
    return (b.get("address") or "").lower() in NATIVE_SENTINELS


def _gas_min_usd(chain_id: int) -> float:
    """USD of native gas the embedded wallet must hold on a non-Base source
    chain to pay for its approve/swap there."""
    return NATIVE_GAS_RESERVE_USD.get(chain_id, DEFAULT_NATIVE_RESERVE_USD)


def _gas_reserve_usd(b: dict[str, Any]) -> float:
    """USD of native value to keep for gas (0 for non-native tokens). On Base
    the reserve is the raw float+padding valued via this holding, so it tracks
    the fixed wei the float needs rather than a fixed dollar amount."""
    if not _is_native(b):
        return 0.0
    cid = int(b.get("chain_id") or 0)
    if cid == BASE_CHAIN_ID:
        amount_raw = int(b.get("amount") or 0)
        value_usd = float(b.get("value_usd") or 0)
        if amount_raw <= 0:
            return value_usd
        return min(value_usd, value_usd * BASE_GAS_RESERVE_WEI / amount_raw)
    return _gas_min_usd(cid)


def _spendable_usd(b: dict[str, Any]) -> float:
    """Holding's USD value minus any native gas reserve."""
    return max(0.0, float(b.get("value_usd") or 0) - _gas_reserve_usd(b))


def _native_usd_by_chain(balances: list[dict[str, Any]]) -> dict[int, float]:
    out: dict[int, float] = {}
    for b in balances:
        if _is_native(b):
            cid = int(b.get("chain_id") or 0)
            out[cid] = out.get(cid, 0.0) + float(b.get("value_usd") or 0)
    return out


def _base_gas_ok(balances: list[dict[str, Any]]) -> bool:
    """Does the embedded wallet hold enough raw Base ETH for the gas float plus
    its own Base funding-tx gas? Gates the whole plan — without it the first
    step (and every Base leg) can't pay gas."""
    base_native_wei = sum(
        int(b.get("amount") or 0)
        for b in balances
        if int(b.get("chain_id") or 0) == BASE_CHAIN_ID and _is_native(b)
    )
    return base_native_wei >= BASE_GAS_RESERVE_WEI


def _usable_chain(
    b: dict[str, Any], native_usd_by_chain: dict[int, float], base_gas_ok: bool
) -> bool:
    """A holding we can actually fund from: bridgeable, on a monitorable chain,
    and on a chain where the wallet holds enough native gas to transact."""
    cid = int(b.get("chain_id") or 0)
    if not _bridgeable(b) or cid not in SUPPORTED_CHAINS:
        return False
    if cid == BASE_CHAIN_ID:
        return base_gas_ok
    return native_usd_by_chain.get(cid, 0.0) >= _gas_min_usd(cid)


async def balance_fund(
    *,
    from_address: str,
    recipient_address: str | None,
    target_usdc_units: int,
    amount_usd: float | None,
    target_caip2: str,
) -> dict[str, Any]:
    """Total investable USD across all funding-eligible chains — the base for
    the UI's 25/50/75/100% presets. Counts only holdings on monitorable chains
    where the wallet has native gas to transact, net of a per-chain gas
    reserve, so a 100% preset stays executable."""
    balances = await _enriched_balances(from_address)
    base_gas_ok = _base_gas_ok(balances)
    # No Base ETH for the gas float ⇒ nothing is deployable, so report nothing
    # investable rather than a number the user can't actually act on.
    if not base_gas_ok:
        return {"mode": "balance", "investableUsd": 0.0}
    native_by_chain = _native_usd_by_chain(balances)
    total = sum(
        _spendable_usd(b)
        for b in balances
        if _usable_chain(b, native_by_chain, base_gas_ok)
    )
    return {"mode": "balance", "investableUsd": total}


async def plan_fund(
    *,
    from_address: str,
    recipient_address: str,
    target_usdc_units: int,
    amount_usd: float | None,
    target_caip2: str,
) -> dict[str, Any]:
    """Build the unsigned txs that turn the embedded wallet's holdings into
    `target_usdc_units` of USDC on Base and deliver them to the server wallet.

    Sources span every bridgeable chain — BRAP quotes a same-chain swap or a
    cross-chain bridge+swap to USDC on Base as needed. Base holdings are spent
    first to avoid unnecessary bridge hops. Layout: [approve?, swap]* (each on
    its source chain), then one ERC-20 transfer of the requested USDC to the
    recipient on Base. USDC already on Base counts toward the target, no swap.
    """
    from wayfinder_paths.adapters.brap_adapter.adapter import BRAPAdapter

    target_chain = _caip2_chain_id(target_caip2)
    balances = await _enriched_balances(from_address)
    native_by_chain = _native_usd_by_chain(balances)
    base_gas_ok = _base_gas_ok(balances)

    # The first plan step sends a fixed-size ETH gas float on Base and every
    # funding leg costs Base gas, so without enough raw Base ETH nothing is
    # executable — even a wallet that already holds enough USDC.
    if not base_gas_ok:
        return {
            "mode": "plan",
            "txs": [],
            "error": "embedded wallet needs Base ETH to pay gas",
        }

    def is_base_usdc(b: dict[str, Any]) -> bool:
        return (
            int(b.get("chain_id") or 0) == target_chain
            and (b.get("address") or "").lower() == USDC_BASE.lower()
        )

    usdc = sum(int(b.get("amount") or 0) for b in balances if is_base_usdc(b))
    sources = sorted(
        (
            b
            for b in balances
            if _usable_chain(b, native_by_chain, base_gas_ok)
            and not is_base_usdc(b)
            and _spendable_usd(b) >= MIN_SOURCE_USD
        ),
        # Base sources first (no bridge), then by spendable USD value.
        key=lambda b: (
            int(b.get("chain_id") or 0) == target_chain,
            _spendable_usd(b),
        ),
        reverse=True,
    )

    txs: list[dict[str, Any]] = []
    brap = BRAPAdapter({}, sign_callback=None, wallet_address=from_address)
    bridged = False

    shortfall_units = max(0, target_usdc_units - usdc)
    for b in sources:
        if shortfall_units <= 0:
            break
        token = b.get("address")
        value_usd = float(b.get("value_usd") or 0)
        avail_usd = _spendable_usd(b)
        amount_raw = int(b.get("amount") or 0)
        src_chain = int(b.get("chain_id") or 0)
        if not token or amount_raw <= 0 or avail_usd <= 0:
            continue

        # Spendable raw units after holding back the native gas reserve.
        spendable_raw = (
            amount_raw
            if avail_usd >= value_usd
            else int(amount_raw * avail_usd / value_usd)
        )
        need_usd = (shortfall_units / 10**USDC_DECIMALS) * SWAP_BUFFER
        fraction = min(1.0, need_usd / avail_usd)
        from_amount = min(spendable_raw, max(1, _ceil(spendable_raw * fraction)))

        ok, quote = await brap.best_quote(
            from_token_address=token,
            to_token_address=USDC_BASE,
            from_chain_id=src_chain,
            to_chain_id=target_chain,
            from_address=from_address,
            amount=str(from_amount),
        )
        if not ok or not isinstance(quote, dict):
            continue
        calldata = quote.get("calldata") or {}
        if not calldata.get("data") or not calldata.get("to"):
            continue

        # approve + swap execute on the source chain.
        leg_chain = int(calldata.get("chainId") or src_chain)
        if leg_chain != target_chain:
            bridged = True
        router = calldata["to"]
        if not quote.get("native_input") and token.lower() not in NATIVE_SENTINELS:
            txs.append(_tx(
                to=token,
                data=_erc20_approve(router, from_amount),
                chain_id=src_chain,
                label=f"Approve {b.get('symbol') or 'token'} for swap",
            ))
        txs.append(_tx(
            to=router,
            data=calldata["data"],
            chain_id=leg_chain,
            value=calldata.get("value"),
            label=f"Swap {b.get('symbol') or 'token'} → USDC on Base",
        ))
        shortfall_units -= int(quote.get("output_amount") or 0)

    # If routing the holdings can't cover the requested amount (quotes failed
    # or balance fell short), return no txs + an error rather than a plan whose
    # final fixed-amount transfer would revert. The build route surfaces this
    # and blocks execution.
    if shortfall_units > 0:
        return {
            "mode": "plan",
            "txs": [],
            "error": "investable balance is insufficient to cover the requested amount",
        }

    # Final leg: hand the requested USDC to the server wallet (on Base). When a
    # cross-chain bridge fed this, the USDC arrives on Base asynchronously — the
    # source-chain swap receipt does not mean it has landed. `waitForUsdc` tells
    # the client to wait until the embedded wallet's Base USDC balance covers
    # the transfer before signing it, so the fixed-amount transfer can't revert.
    transfer = _tx(
        to=USDC_BASE,
        data=_erc20_transfer(recipient_address, target_usdc_units),
        chain_id=target_chain,
        label="Transfer USDC to execution wallet",
    )
    if bridged:
        transfer["waitForUsdc"] = str(target_usdc_units)
    txs.append(transfer)

    return {"mode": "plan", "txs": txs}


def _ceil(x: float) -> int:
    return -int(-x // 1)


def _tx(
    *,
    to: str,
    data: str,
    chain_id: int,
    value: Any = None,
    label: str | None = None,
) -> dict[str, Any]:
    if isinstance(value, str):
        value = value if value.startswith("0x") else hex(int(value))
    elif isinstance(value, (int, float)):
        value = hex(int(value))
    return {
        "to": to,
        "data": data,
        "value": value or "0x0",
        "chainId": chain_id,
        "label": label,
    }


def _erc20_approve(spender: str, amount: int) -> str:
    # approve(address,uint256)
    return "0x095ea7b3" + _addr_arg(spender) + _uint_arg(amount)


def _erc20_transfer(to: str, amount: int) -> str:
    # transfer(address,uint256)
    return "0xa9059cbb" + _addr_arg(to) + _uint_arg(amount)


def _addr_arg(addr: str) -> str:
    return addr.lower().removeprefix("0x").rjust(64, "0")


def _uint_arg(value: int) -> str:
    return format(int(value), "064x")


def _serialize_status(status: Any) -> dict[str, Any]:
    """Best-effort JSON serialization of a Wayfinder StatusTuple."""
    if status is None:
        return {"status": None}
    if isinstance(status, dict):
        return {"status": _jsonable(status)}
    if hasattr(status, "_asdict"):
        return {"status": _jsonable(status._asdict())}
    return {"status": _jsonable(status)}


def _status_ok_message(serialized: dict[str, Any]) -> tuple[bool, str]:
    """Extract the bool/message convention used by Wayfinder StatusTuple."""
    status = serialized.get("status")
    if isinstance(status, list) and status and isinstance(status[0], bool):
        message = str(status[1]) if len(status) > 1 else ""
        return status[0], message
    if isinstance(status, dict) and isinstance(status.get("success"), bool):
        return bool(status["success"]), str(status.get("message") or "")
    if isinstance(status, dict) and isinstance(status.get("ok"), bool):
        return bool(status["ok"]), str(status.get("message") or "")
    return True, str(status)


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
