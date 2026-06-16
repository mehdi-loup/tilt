"""Wayfinder engine — strategy/funding logic for the Cloud Run sidecar.

This module is the stateless "Wayfinder engine": it drives Wayfinder
strategies and the rotator path against the user's Privy server-side wallet,
plans funding routes, and reports investable balances. HTTP serving lives in
`app.py` (FastAPI); this module deliberately has no HTTP or event-loop
plumbing — FastAPI/uvicorn provides the single long-lived loop the SDK's
module-level httpx clients need.

Strategy classes accept `*_signing_callback` constructor params; we wrap
Privy's wallet RPC as those callbacks so multi-step deposit()/update() runs
without ever holding a private key. Strategies that need funds on another
chain (Arbitrum, HyperEVM) declare a `prepare` spec: the engine self-bridges
the server wallet's Base USDC to the target chain via BRAP — signed by the
same Privy wallet — before invoking the strategy.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import os
import traceback
from typing import Any, Awaitable, Callable

# Privy HTTP basic auth
PRIVY_API_BASE = os.environ.get("PRIVY_API_URL", "https://api.privy.io")
PRIVY_APP_ID = os.environ.get("PRIVY_APP_ID") or os.environ.get(
    "NEXT_PUBLIC_PRIVY_APP_ID", ""
)
PRIVY_APP_SECRET = os.environ.get("PRIVY_APP_SECRET", "")
# One secret, one purpose — no PRIVY_APP_SECRET fallback.
INTERNAL_SECRET = os.environ.get("WAYFINDER_INTERNAL_SECRET", "")

DEFAULT_CAIP2 = "eip155:8453"  # Base mainnet
SDK_LEGACY_API_BASE_URL = "https://wayfinder.ai/api"
DEFAULT_WAYFINDER_API_BASE_URL = "https://strategies.wayfinder.ai/api/v1"


# ─── Profile/step → Wayfinder strategy mapping ─────────────────────────────
#
# The TypeScript planner sends the concrete `strategyName` for each step.
# `prepare` declares target-chain funding the engine must self-bridge from the
# server wallet's Base USDC before the strategy runs (signed by the same Privy
# wallet, no user prompts):
#   chain_id          — where the strategy expects main-wallet funds
#   usdc_token_id     — Wayfinder token id of the target-chain USDC
#   native_float_wei  — native gas the wallet must hold on the target chain
#   gas_swap_usd      — Base USDC to spend buying that native gas
ARBITRUM_CHAIN_ID = 42161
HYPEREVM_CHAIN_ID = 999

STRATEGY_SPECS: dict[str, dict[str, Any]] = {
    "stablecoin_yield_rotator": {
        # Wayfinder *path* (not a strategy class), vendored under rotator/.
        # Its deposit action scans Base lending venues, re-checks the target
        # market, gas-checks, and lends in one call — no separate update().
        "kind": "path",
        "chain": "base",
        "caip2": "eip155:8453",
    },
    "stablecoin_yield_strategy": {
        "module": "wayfinder_paths.strategies.stablecoin_yield_strategy.strategy",
        "class_name": "StablecoinYieldStrategy",
        "chain": "base",
        "caip2": "eip155:8453",
        # deposit() only stages funds into the strategy wallet; update()
        # actually rotates into the selected yield pool.
        "run_update_after_deposit": True,
    },
    "moonwell_wsteth_loop_strategy": {
        "module": "wayfinder_paths.strategies.moonwell_wsteth_loop_strategy.strategy",
        "class_name": "MoonwellWstethLoopStrategy",
        "chain": "base",
        "caip2": "eip155:8453",
        # deposit() stages Base USDC/ETH; update() deploys to Moonwell.
        "run_update_after_deposit": True,
    },
    "multi_vault_split_strategy": {
        "module": "wayfinder_paths.strategies.multi_vault_split_strategy.strategy",
        "class_name": "MultiVaultSplitStrategy",
        "chain": "multi",
        "caip2": "eip155:8453",
        # Strategy minimum is $40 (Arbitrum USDC).
        # deposit() ends with `return await self.update()` — no second pass.
        "run_update_after_deposit": False,
        "prepare": {
            "chain_id": ARBITRUM_CHAIN_ID,
            "usdc_token_id": "usd-coin-arbitrum",
            "native_float_wei": 300_000_000_000_000,  # 0.0003 ETH
            "gas_swap_usd": 2.5,
        },
    },
    "basis_trading_strategy": {
        "module": "wayfinder_paths.strategies.basis_trading_strategy.strategy",
        "class_name": "BasisTradingStrategy",
        "chain": "hyperliquid",
        "caip2": "eip155:8453",
        # Strategy minimum is $25 (Arbitrum USDC).
        # deposit() stages Arbitrum USDC; update() bridges to Hyperliquid
        # and opens the positions.
        "run_update_after_deposit": True,
        "prepare": {
            "chain_id": ARBITRUM_CHAIN_ID,
            "usdc_token_id": "usd-coin-arbitrum",
            "native_float_wei": 300_000_000_000_000,  # 0.0003 ETH
            "gas_swap_usd": 2.5,
        },
    },
    "projectx_thbill_usdc_strategy": {
        "module": "wayfinder_paths.strategies.projectx_thbill_usdc_strategy.strategy",
        "class_name": "ProjectXTHBILLUSDCStrategy",
        "chain": "hyperEVM",
        "caip2": "eip155:8453",
        # Strategy minimum is $5 (HyperEVM USDC).
        # deposit() opens/increases the LP position itself.
        "run_update_after_deposit": False,
        "prepare": {
            "chain_id": HYPEREVM_CHAIN_ID,
            "usdc_token_id": "usd-coin-hyperevm",
            # GAS_THRESHOLD is 0.05 HYPE; keep a little above it.
            "native_float_wei": 60_000_000_000_000_000,  # 0.06 HYPE
            "gas_swap_usd": 6.0,
        },
    },
    "boros_hype_strategy": {
        "module": "wayfinder_paths.strategies.boros_hype_strategy.strategy",
        "class_name": "BorosHypeStrategy",
        "chain": "multi",
        "caip2": "eip155:8453",
        # Strategy minimum is $150 (Arbitrum USDC).
        # deposit() stages funds; update() runs the OPA loop and deploys.
        "run_update_after_deposit": True,
        "prepare": {
            "chain_id": ARBITRUM_CHAIN_ID,
            "usdc_token_id": "usd-coin-arbitrum",
            "native_float_wei": 300_000_000_000_000,  # 0.0003 ETH
            "gas_swap_usd": 2.5,
        },
    },
}

# Legacy profile → default strategy mapping, used only by the migration-era
# POST / route when the request omits strategyName.
PROFILE_STRATEGIES: dict[str, dict[str, Any]] = {
    "stable_lender": {"strategy_name": "stablecoin_yield_rotator"},
    "conservative_yield": {},
    "balanced_defi": {},
    "aggressive_growth": {},
    "max_speculation": {},
}


class StrategyResolutionError(ValueError):
    pass


def resolve_strategy(
    profile_id: str | None, strategy_name: str | None
) -> tuple[str, dict[str, Any]]:
    """Resolve the (strategy_name, spec) a request addresses, or raise."""
    if strategy_name:
        spec = STRATEGY_SPECS.get(strategy_name)
        if spec is None:
            raise StrategyResolutionError(f"unknown strategyName: {strategy_name}")
        return strategy_name, spec
    profile_spec = PROFILE_STRATEGIES.get(profile_id or "")
    if profile_spec is None:
        raise StrategyResolutionError(f"unknown profileId: {profile_id}")
    name = profile_spec.get("strategy_name")
    if not name:
        raise StrategyResolutionError(
            f"profile {profile_id} requires an explicit strategyName"
        )
    return name, STRATEGY_SPECS[name]


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
# the funding wallet into the server wallet. Every leg is unsigned calldata
# for the funding wallet to sign client-side.
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
# swap away the ETH/etc. the funding wallet needs to pay for its approve/swap
# there. Ethereum L1 gas is dear, so it reserves more.
NATIVE_GAS_RESERVE_USD: dict[int, float] = {1: 20.0}
DEFAULT_NATIVE_RESERVE_USD = 1.50

# Base ETH the funding wallet must keep — and never swap. This is a *raw* wei
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

class StrategyImportError(RuntimeError):
    pass


def _wayfinder_installed() -> bool:
    try:
        __import__("wayfinder_paths.core.strategies.Strategy")
        return True
    except ImportError:
        return False


def _configure_wayfinder_sdk() -> None:
    """Set the SDK API host for serverless runs that do not ship config.json."""
    from wayfinder_paths.core import config as wf_config

    config = dict(wf_config.CONFIG or {})
    system = dict(config.get("system") or {})
    configured_url = str(system.get("api_base_url") or "").strip().rstrip("/")
    env_url = os.environ.get("WAYFINDER_API_BASE_URL")
    selected_url = (env_url.strip().rstrip("/") if env_url else configured_url)
    if not selected_url or selected_url == SDK_LEGACY_API_BASE_URL:
        selected_url = DEFAULT_WAYFINDER_API_BASE_URL

    system["api_base_url"] = selected_url
    config["system"] = system
    wf_config.set_config(config)


def _wayfinder_error_message(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    request = getattr(exc, "request", None) or getattr(response, "request", None)
    url = str(getattr(request, "url", ""))

    if status_code == 401:
        return (
            "Wayfinder API rejected the request (401). "
            "Set a valid WAYFINDER_API_KEY in the sidecar environment."
        )
    if status_code == 404 and SDK_LEGACY_API_BASE_URL in url:
        return (
            f"Wayfinder SDK API base {SDK_LEGACY_API_BASE_URL} returned 404. "
            f"Use {DEFAULT_WAYFINDER_API_BASE_URL} or set WAYFINDER_API_BASE_URL."
        )
    if status_code:
        return f"Wayfinder API request failed ({status_code})."
    return f"{type(exc).__name__}: {exc}"


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
                    # No `caip2` at the root for eth_signTransaction — Privy
                    # rejects it; the chain comes from transaction.chain_id.
                    "method": "eth_signTransaction",
                    "params": {
                        "transaction": _prepare_tx_for_privy(
                            transaction, _caip2_chain_id(caip2)
                        ),
                    },
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


def make_privy_sign_typed_data_callback(
    wallet_id: str,
) -> Callable[[str | dict], Awaitable[str]]:
    """Return an `async (payload) -> '0x…'` matching Wayfinder's
    sign_typed_data contract (EIP-712), via Privy's eth_signTypedData_v4.
    Hyperliquid exchange actions and HyperEVM permit flows sign this way."""

    import httpx

    auth = (PRIVY_APP_ID, PRIVY_APP_SECRET)

    def sanitize(obj: Any) -> Any:
        if isinstance(obj, bytes):
            return "0x" + obj.hex()
        if isinstance(obj, dict):
            return {k: sanitize(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [sanitize(v) for v in obj]
        return obj

    async def sign_typed_data(payload: str | dict) -> str:
        message = json.loads(payload) if isinstance(payload, str) else payload
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{PRIVY_API_BASE}/v1/wallets/{wallet_id}/rpc",
                headers={"privy-app-id": PRIVY_APP_ID},
                auth=auth,
                json={
                    "method": "eth_signTypedData_v4",
                    "params": {"typed_data": sanitize(message)},
                },
            )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"privy typed-data sign failed: {resp.status_code} {resp.text}"
            )
        body = resp.json()
        sig = body.get("data", {}).get("signature") or body.get("signature")
        if not sig:
            raise RuntimeError(f"privy returned no signature: {body!r}")
        return sig if sig.startswith("0x") else f"0x{sig}"

    return sign_typed_data


def _prepare_tx_for_privy(tx: dict, default_chain_id: int) -> dict:
    """Coerce a Wayfinder (web3, camelCase) tx into Privy's eth_signTransaction
    shape. Privy wants snake_case fields and a required integer `chain_id`; it
    rejects the camelCase keys (gas, chainId, maxFeePerGas, maxPriorityFeePerGas).
    `to`, `from`, `value`, `data`, `nonce`, `type` are accepted as-is.
    """

    def hexify(v: Any) -> str | None:
        if v is None:
            return None
        if isinstance(v, str):
            return v if v.startswith("0x") else hex(int(v))
        if isinstance(v, (int, float)):
            return hex(int(v))
        return v

    def as_int(v: Any) -> int:
        if isinstance(v, str):
            return int(v, 16) if v.startswith("0x") else int(v)
        return int(v)

    out: dict[str, Any] = {}
    for k in ("from", "to", "data"):
        if tx.get(k) is not None:
            out[k] = tx[k]
    # Numeric fields → hex, renamed to Privy's snake_case where it differs.
    rename = {
        "value": "value",
        "nonce": "nonce",
        "gas": "gas_limit",
        "gasLimit": "gas_limit",
        "gasPrice": "gas_price",
        "maxFeePerGas": "max_fee_per_gas",
        "maxPriorityFeePerGas": "max_priority_fee_per_gas",
    }
    for src, dst in rename.items():
        v = hexify(tx.get(src))
        if v is not None:
            out[dst] = v
    # chain_id is required and must be an integer.
    out["chain_id"] = as_int(tx.get("chainId") or tx.get("chain_id") or default_chain_id)
    # Transaction type (0 legacy, 2 EIP-1559) as an int when known.
    t = tx.get("type")
    if t is None and "maxFeePerGas" in tx:
        t = 2
    elif t is None and "gasPrice" in tx:
        t = 0
    if t is not None:
        out["type"] = as_int(t)
    return out


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
    _configure_wayfinder_sdk()

    module_path: str = spec["module"]
    class_name: str = spec["class_name"]
    expected_caip2 = spec.get("caip2")
    if expected_caip2 and caip2 != expected_caip2:
        raise ValueError(f"{class_name} requires {expected_caip2}, got {caip2}")

    # Dynamic import keeps the function importable even when Wayfinder
    # isn't installed (the health route reports it).
    module = __import__(module_path, fromlist=[class_name])
    StrategyClass = getattr(module, class_name)

    sign_callback = make_privy_sign_callback(wallet_id, wallet_address, caip2)
    wallet_entry = {"address": wallet_address, "label": "tilt-server"}

    lifecycle: dict[str, Any] = {}

    # Target-chain prep: self-bridge Base USDC → target-chain USDC + native
    # gas before the strategy runs. The strategy then deposits what actually
    # arrived (bridge output net of fees), not the nominal request.
    deposit_amount = amount_usd
    prep_spec = spec.get("prepare")
    if prep_spec:
        prep = await prepare_target_chain(
            wallet_id=wallet_id,
            wallet_address=wallet_address,
            amount_usd=amount_usd,
            **prep_spec,
        )
        lifecycle["prepare"] = {k: v for k, v in prep.items() if k != "success"}
        if not prep["success"]:
            return {
                "success": False,
                "strategyName": strategy_name,
                "error": f"target-chain prep failed: {prep.get('error')}",
                "status": lifecycle,
                "txHashes": [],
            }
        deposit_amount = prep["deposit_amount_usd"]

    kwargs: dict[str, Any] = {
        "config": {},
        "main_wallet": wallet_entry,
        "strategy_wallet": wallet_entry,
        "main_wallet_signing_callback": sign_callback,
        "strategy_wallet_signing_callback": sign_callback,
    }
    # Hyperliquid/HyperEVM strategies sign EIP-712 actions; wire Privy
    # typed-data signing when the constructor accepts it.
    params = set(inspect.signature(StrategyClass.__init__).parameters)
    if "strategy_sign_typed_data" in params or "kwargs" in params:
        kwargs["strategy_sign_typed_data"] = make_privy_sign_typed_data_callback(
            wallet_id
        )

    strategy = StrategyClass(**kwargs)

    # setup() loads token/pool info (e.g. usdc_token_info) and must run before
    # deposit() — otherwise deposit raises AttributeError on those fields.
    await strategy.setup()

    lifecycle["deposit"] = _serialize_status(
        await strategy.deposit(main_token_amount=deposit_amount)
    )
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


# ─── Target-chain preparation (server wallet self-bridging) ──────────────
#
# Strategies that expect main-wallet funds on Arbitrum/HyperEVM declare a
# `prepare` spec. The engine bridges the server wallet's Base USDC to the
# target chain via BRAP — two legs, both signed by the Privy server wallet:
#   1. Base USDC → target-chain native (gas float), skipped when the wallet
#      already holds `native_float_wei` there.
#   2. Base USDC → target-chain USDC for the rest of the step amount,
#      skipped when a previous (failed/retried) run already delivered it.
# Bridges land asynchronously, so each leg polls the destination balance.
# The strategy then deposits what actually arrived, not the nominal amount.

NATIVE_TOKEN_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
PREP_SLIPPAGE = 0.003
PREP_BRIDGE_TIMEOUT_SECONDS = 900
PREP_POLL_SECONDS = 10


async def _native_balance_wei(chain_id: int, address: str) -> int:
    from wayfinder_paths.core.utils.web3 import web3_from_chain_id

    async with web3_from_chain_id(chain_id) as w3:
        return int(await w3.eth.get_balance(w3.to_checksum_address(address)))


async def _wait_for_arrival(
    read_balance: Callable[[], Awaitable[int]], target: int, what: str
) -> int:
    """Poll until `read_balance()` ≥ target (bridges deliver asynchronously)."""
    deadline = asyncio.get_event_loop().time() + PREP_BRIDGE_TIMEOUT_SECONDS
    while True:
        have = int(await read_balance())
        if have >= target:
            return have
        if asyncio.get_event_loop().time() > deadline:
            raise RuntimeError(
                f"timed out waiting for {what} to arrive "
                f"(have {have}, want {target})"
            )
        await asyncio.sleep(PREP_POLL_SECONDS)


async def _brap_bridge_leg(
    *,
    adapter: Any,
    sender: str,
    to_token_address: str,
    to_chain_id: int,
    base_usdc_units: int,
    label: str,
) -> dict[str, Any]:
    """Quote + execute one Base-USDC→target swap; returns the executed quote."""
    ok, quote = await adapter.best_quote(
        from_token_address=USDC_BASE,
        to_token_address=to_token_address,
        from_chain_id=BASE_CHAIN_ID,
        to_chain_id=to_chain_id,
        from_address=sender,
        amount=str(base_usdc_units),
        slippage=PREP_SLIPPAGE,
    )
    if not ok or not isinstance(quote, dict):
        raise RuntimeError(f"{label}: BRAP quote failed: {quote}")
    # swap_from_quote only reads chain.id + address off the token dicts (the
    # rest feeds its best-effort ledger record).
    from_token = {
        "chain": {"id": BASE_CHAIN_ID},
        "address": USDC_BASE,
        "symbol": "USDC",
        "decimals": USDC_DECIMALS,
    }
    to_token = {"chain": {"id": to_chain_id}, "address": to_token_address}
    ok, result = await adapter.swap_from_quote(
        from_token=from_token,
        to_token=to_token,
        from_address=sender,
        quote=quote,
        strategy_name="tilt-target-chain-prep",
    )
    if not ok:
        raise RuntimeError(f"{label}: swap failed: {result}")
    return quote


async def prepare_target_chain(
    *,
    wallet_id: str,
    wallet_address: str,
    amount_usd: float,
    chain_id: int,
    usdc_token_id: str,
    native_float_wei: int,
    gas_swap_usd: float,
) -> dict[str, Any]:
    """Ensure the server wallet holds target-chain USDC + native gas for a
    strategy step, self-bridging from its Base USDC. Returns a report with
    `success` and the post-prep `deposit_amount_usd`."""
    from wayfinder_paths.adapters.brap_adapter.adapter import BRAPAdapter
    from wayfinder_paths.core.clients.TokenClient import TOKEN_CLIENT
    from wayfinder_paths.core.utils.tokens import get_token_balance
    from wayfinder_paths.mcp.scripting import get_adapter

    _apply_rotator_wallet_patches()
    label = _rotator_label(wallet_id, wallet_address)
    report: dict[str, Any] = {"chainId": chain_id, "legs": []}

    try:
        target_usdc = await TOKEN_CLIENT.get_token_details(usdc_token_id)
        if not target_usdc or not target_usdc.get("address"):
            raise RuntimeError(f"cannot resolve token {usdc_token_id}")
        usdc_address = str(target_usdc["address"])
        usdc_decimals = int(target_usdc.get("decimals") or 6)

        async def usdc_balance() -> int:
            return int(
                await get_token_balance(
                    token_address=usdc_address,
                    chain_id=chain_id,
                    wallet_address=wallet_address,
                )
            )

        have_usdc = await usdc_balance()
        have_native = await _native_balance_wei(chain_id, wallet_address)
        adapter = await get_adapter(BRAPAdapter, label)

        # Leg 1 — native gas float.
        gas_spent_usd = 0.0
        if have_native < native_float_wei:
            await _brap_bridge_leg(
                adapter=adapter,
                sender=wallet_address,
                to_token_address=NATIVE_TOKEN_SENTINEL,
                to_chain_id=chain_id,
                base_usdc_units=int(gas_swap_usd * 10**USDC_DECIMALS),
                label="gas leg",
            )
            await _wait_for_arrival(
                lambda: _native_balance_wei(chain_id, wallet_address),
                native_float_wei,
                f"native gas on chain {chain_id}",
            )
            gas_spent_usd = gas_swap_usd
            report["legs"].append({"leg": "gas", "spentUsd": gas_swap_usd})
        else:
            report["legs"].append({"leg": "gas", "skipped": "already funded"})

        # Leg 2 — the step's USDC. Skip when a prior (retried) run already
        # delivered roughly the expected amount to the target chain.
        bridge_usd = max(0.0, amount_usd - gas_spent_usd)
        bridge_units = int(bridge_usd * 10**USDC_DECIMALS)
        expected_units = int(bridge_usd * 0.97 * 10**usdc_decimals)
        if have_usdc >= expected_units:
            deposit_units = min(have_usdc, int(bridge_usd * 10**usdc_decimals))
            report["legs"].append({"leg": "usdc", "skipped": "already funded"})
        else:
            quote = await _brap_bridge_leg(
                adapter=adapter,
                sender=wallet_address,
                to_token_address=usdc_address,
                to_chain_id=chain_id,
                base_usdc_units=bridge_units,
                label="usdc leg",
            )
            quoted_out = int(
                quote.get("output_amount") or quote.get("outputAmount") or 0
            )
            floor = have_usdc + (
                int(quoted_out * 0.95) if quoted_out else expected_units
            )
            arrived = await _wait_for_arrival(
                usdc_balance, floor, f"USDC on chain {chain_id}"
            )
            deposit_units = arrived - have_usdc
            report["legs"].append({
                "leg": "usdc",
                "bridgedBaseUnits": bridge_units,
                "receivedUnits": deposit_units,
            })

        # Stablecoin ≈ $1; round down to the cent so the deposit never
        # exceeds what's actually there.
        deposit_amount_usd = int(deposit_units / 10**usdc_decimals * 100) / 100
        return {
            **report,
            "success": True,
            "deposit_amount_usd": deposit_amount_usd,
        }
    except Exception as exc:  # noqa: BLE001 — reported in the lifecycle
        return {**report, "success": False, "error": str(exc)}


# ─── Stablecoin Yield Rotator (vendored Wayfinder path) ──────────────────
#
# The rotator is a Wayfinder *path* (paths/stablecoin-yield-rotator in the SDK
# repo), not a strategy class: its action functions resolve their signer
# internally through wayfinder_paths wallet-label lookup instead of accepting
# signing-callback constructor args. We bridge Privy in at that seam — the
# wallet "label" in the per-request config encodes the Privy wallet id and
# address (`tilt:<wallet-id>:<address>`), and the SDK's label resolver is
# patched once, process-wide, to recognise that encoding and hand back our
# Privy-backed signer. The path itself runs unmodified from the vendored copy
# in rotator/scripts/.

ROTATOR_LABEL_PREFIX = "tilt:"
ROTATOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rotator")

# Base-only on purpose: tilt funds USDC + the gas float on Base only, so
# venues on other chains would fail the rotator's per-chain native-gas check
# (and cross-chain rotation legs would have no gas to execute).
ROTATOR_CONFIG_BASE: dict[str, Any] = {
    "chains": [BASE_CHAIN_ID],
    "assets": ["USDC"],
    "venues": ["aave_v3", "morpho_blue_market", "morpho_vault", "euler_v2", "moonwell"],
    # Mirrors the path's shipped inputs/config.yaml defaults.
    "constraints": {
        "min_apy_delta_bps": 50,
        "gas_amortization_days": 30,
        "max_gas_usd_per_rotation": 25,
        "max_position_pct_per_venue": 50,
        "min_scan_tvl_usd": 100_000,
        "max_scan_apy": 0.5,
        "blocklist_markets": [],
    },
    "slippage_bps": 30,
}


def _rotator_label(wallet_id: str, wallet_address: str) -> str:
    return f"{ROTATOR_LABEL_PREFIX}{wallet_id}:{wallet_address}"


def _parse_rotator_label(label: str) -> tuple[str, str] | None:
    """`tilt:<privy-wallet-id>:<address>` → (wallet_id, address), else None."""
    if not label.startswith(ROTATOR_LABEL_PREFIX):
        return None
    wallet_id, sep, address = label[len(ROTATOR_LABEL_PREFIX):].rpartition(":")
    if not sep or not wallet_id or not address:
        return None
    return wallet_id, address


_ROTATOR_PATCHED = False


def _apply_rotator_wallet_patches() -> None:
    """Teach the SDK's wallet-label resolution about tilt's encoded labels.

    All rotator signing funnels through wayfinder_paths.core.utils.wallets:
    the three get_wallet_*_callback functions call find_wallet_by_label and
    _build_*_callback as late-bound module globals, so patching those covers
    the from-imports in the path's venues.py and the SDK's mcp.scripting.
    """
    global _ROTATOR_PATCHED
    if _ROTATOR_PATCHED:
        return
    import wayfinder_paths.core.utils.wallets as wf_wallets

    orig_find = wf_wallets.find_wallet_by_label

    async def find_wallet_by_label(label: str) -> dict[str, Any] | None:
        parsed = _parse_rotator_label(str(label or ""))
        if parsed:
            wallet_id, address = parsed
            return {
                "address": address,
                "label": label,
                "type": "privy",
                "wallet_id": wallet_id,
            }
        return await orig_find(label)

    orig_build_sign = wf_wallets._build_signing_callback

    def _build_signing_callback(wallet: dict[str, Any], label: str):
        if wallet.get("type") == "privy":
            address = wallet["address"]
            return (
                make_privy_sign_callback(wallet["wallet_id"], address, DEFAULT_CAIP2),
                address,
            )
        return orig_build_sign(wallet, label)

    orig_build_typed = wf_wallets._build_typed_data_callback

    def _build_typed_data_callback(wallet: dict[str, Any], label: str):
        if wallet.get("type") == "privy":
            return (
                make_privy_sign_typed_data_callback(wallet["wallet_id"]),
                wallet["address"],
            )
        return orig_build_typed(wallet, label)

    # get_adapter eagerly wires a hash callback when an adapter's __init__
    # accepts one; return a stub that only fails if actually invoked, so
    # adapter construction succeeds for the flows we use.
    orig_build_hash = wf_wallets._build_sign_hash_callback

    def _build_sign_hash_callback(wallet: dict[str, Any], label: str):
        if wallet.get("type") != "privy":
            return orig_build_hash(wallet, label)

        async def unsupported(*_args: Any, **_kwargs: Any) -> str:
            raise NotImplementedError("Privy raw-hash signing is not wired")

        return unsupported, wallet["address"]

    wf_wallets.find_wallet_by_label = find_wallet_by_label
    wf_wallets._build_signing_callback = _build_signing_callback
    wf_wallets._build_typed_data_callback = _build_typed_data_callback
    wf_wallets._build_sign_hash_callback = _build_sign_hash_callback
    _ROTATOR_PATCHED = True


_ROTATOR_MAIN: Any = None


def _rotator_main() -> Any:
    """Load the vendored rotator entrypoint (wallet patches must come first)."""
    global _ROTATOR_MAIN
    if _ROTATOR_MAIN is not None:
        return _ROTATOR_MAIN
    if not _wayfinder_installed():
        raise StrategyImportError(
            "wayfinder_paths is not installed in this Python runtime"
        )
    _apply_rotator_wallet_patches()

    import importlib.util

    main_path = os.path.join(ROTATOR_DIR, "scripts", "main.py")
    spec = importlib.util.spec_from_file_location("tilt_rotator_main", main_path)
    if spec is None or spec.loader is None:
        raise StrategyImportError(f"cannot load rotator entrypoint at {main_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    # The stock resolver only accepts labels present in the SDK wallet config;
    # short-circuit tilt's encoded labels. Late-bound module global, so the
    # action functions pick the patched version up.
    orig_resolve = module._resolve_wallet_label

    async def _resolve_wallet_label(config: dict[str, Any]) -> str:
        label = str(config.get("wallet") or "")
        if _parse_rotator_label(label):
            return label
        return await orig_resolve(config)

    module._resolve_wallet_label = _resolve_wallet_label
    _ROTATOR_MAIN = module
    return module


async def run_rotator(
    *,
    strategy_name: str,
    spec: dict[str, Any],
    amount_usd: float,
    wallet_id: str,
    wallet_address: str,
    caip2: str,
) -> dict[str, Any]:
    """Drive the rotator path's deposit action against the user's Privy
    server wallet: scan venues, re-check the target market, gas-check, lend."""
    expected_caip2 = spec.get("caip2")
    if expected_caip2 and caip2 != expected_caip2:
        raise ValueError(f"{strategy_name} requires {expected_caip2}, got {caip2}")

    _configure_wayfinder_sdk()
    module = _rotator_main()
    config = {
        **ROTATOR_CONFIG_BASE,
        "wallet": _rotator_label(wallet_id, wallet_address),
    }

    result = await module.action_deposit(config, asset="USDC", human_amount=amount_usd)
    ok = result.get("status") == "ok"
    out: dict[str, Any] = {
        "success": ok,
        "strategyName": strategy_name,
        "status": {"deposit": _jsonable(result)},
        "txHashes": [],
    }
    if not ok:
        out["error"] = f"deposit {result.get('status')}: {result.get('reason')}"
    return out


# ─── Funding conversion ──────────────────────────────────────────────────


def _caip2_chain_id(caip2: str) -> int:
    """`eip155:8453` → 8453."""
    return int(caip2.rsplit(":", 1)[-1])


async def _enriched_balances(from_address: str) -> list[dict[str, Any]]:
    if not _wayfinder_installed():
        raise StrategyImportError(
            "wayfinder_paths is not installed in this Python runtime"
        )
    _configure_wayfinder_sdk()
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
    """USD of native gas the funding wallet must hold on a non-Base source
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
    """Does the funding wallet hold enough raw Base ETH for the gas float plus
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
    native_by_chain = _native_usd_by_chain(balances)
    gross = sum(float(b.get("value_usd") or 0) for b in balances if _bridgeable(b))
    total = sum(
        _spendable_usd(b)
        for b in balances
        if _usable_chain(b, native_by_chain, base_gas_ok)
    )
    print(
        f"[balance] from={from_address} holdings={len(balances)} "
        f"base_gas_ok={base_gas_ok} gross_usd={gross:.2f} investable={total:.2f}",
        flush=True,
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
    """Build the unsigned txs that turn the funding wallet's holdings into
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
            "error": "funding wallet needs Base ETH to pay gas",
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
    # the client to wait until the funding wallet's Base USDC balance covers
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
