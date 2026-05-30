#!/usr/bin/env python3
"""Stable Lender deploy-test helper.

Default mode is safe: it validates the Python runtime, dependency install,
Wayfinder strategy contract, gas-float sizing, and sidecar lifecycle wiring
without submitting transactions.

Live mode submits real Stable Lender deposit/update transactions from the
provided Privy server wallet:

    python3.12 scripts/stable_lender_deploy_test.py --live \
      --wallet-id <privy-wallet-id> \
      --wallet-address 0x... \
      --amount-usd 2
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import inspect
import json
import os
import sys
from decimal import Decimal
from importlib import metadata
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV_FILE = ROOT / ".env.local"
STABLE_STRATEGY = "stablecoin_yield_strategy"
BASE_CAIP2 = "eip155:8453"
BASE_CHAIN_ID = 8453
USDC_DECIMALS = 6
WEI_PER_ETH = Decimal("1000000000000000000")


def main() -> int:
    env_parser = argparse.ArgumentParser(add_help=False)
    env_parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    env_args, _ = env_parser.parse_known_args()
    load_env(env_args.env_file)

    parser = argparse.ArgumentParser(description=__doc__, parents=[env_parser])
    parser.add_argument("--live", action="store_true", help="submit real on-chain transactions")
    parser.add_argument("--wallet-id", default=os.environ.get("STABLE_LENDER_TEST_WALLET_ID"))
    parser.add_argument(
        "--wallet-address",
        default=os.environ.get("STABLE_LENDER_TEST_WALLET_ADDRESS"),
    )
    parser.add_argument(
        "--amount-usd",
        type=Decimal,
        default=_decimal_env("STABLE_LENDER_TEST_AMOUNT_USD"),
    )
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT))

    try:
        execute = importlib.import_module("api.wayfinder.execute")
        strategy_class = validate_preflight(execute)
        asyncio.run(validate_lifecycle_wiring(execute))
        print("OK sidecar lifecycle calls deposit() and update()")

        if not args.live:
            print("SKIP live run: pass --live with a funded Privy server wallet to submit transactions")
            return 0

        amount = args.amount_usd
        if amount is None:
            raise CheckFailed("--amount-usd is required in --live mode")
        if amount < Decimal(str(execute.STRATEGY_SPECS[STABLE_STRATEGY]["min_amount_usd"])):
            raise CheckFailed("amount is below the Stable Lender minimum")
        if not args.wallet_id or not args.wallet_address:
            raise CheckFailed("--wallet-id and --wallet-address are required in --live mode")
        require_env("PRIVY_APP_SECRET")
        if not (os.environ.get("PRIVY_APP_ID") or os.environ.get("NEXT_PUBLIC_PRIVY_APP_ID")):
            raise CheckFailed("PRIVY_APP_ID or NEXT_PUBLIC_PRIVY_APP_ID is required")

        asyncio.run(validate_live_balances(execute, strategy_class, args.wallet_address, amount))
        result = asyncio.run(
            execute.run_strategy(
                strategy_name=STABLE_STRATEGY,
                spec=execute.STRATEGY_SPECS[STABLE_STRATEGY],
                amount_usd=float(amount),
                wallet_id=args.wallet_id,
                wallet_address=args.wallet_address,
                caip2=BASE_CAIP2,
            )
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        if not result.get("success"):
            raise CheckFailed(result.get("error") or "Stable Lender live run failed")
        print("OK Stable Lender live deposit/update completed")
        return 0
    except CheckFailed as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1


class CheckFailed(RuntimeError):
    pass


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _decimal_env(key: str) -> Decimal | None:
    value = os.environ.get(key)
    return Decimal(value) if value else None


def require_env(key: str) -> None:
    if not os.environ.get(key):
        raise CheckFailed(f"{key} is required")


def validate_preflight(execute: Any) -> type:
    if sys.version_info < (3, 12):
        raise CheckFailed("Python 3.12+ is required for wayfinder-paths")
    print(f"OK Python {sys.version.split()[0]}")

    version = metadata.version("wayfinder-paths")
    print(f"OK wayfinder-paths {version}")

    python_version_file = ROOT / ".python-version"
    if python_version_file.read_text().strip() != "3.12":
        raise CheckFailed(".python-version must pin Vercel Python to 3.12")
    print("OK .python-version pins Python 3.12")

    spec = execute.STRATEGY_SPECS[STABLE_STRATEGY]
    module = importlib.import_module(spec["module"])
    strategy_class = getattr(module, spec["class_name"])

    constructor = inspect.signature(strategy_class)
    expected_kwargs = {
        "main_wallet",
        "strategy_wallet",
        "main_wallet_signing_callback",
        "strategy_wallet_signing_callback",
    }
    missing = expected_kwargs.difference(constructor.parameters)
    if missing:
        raise CheckFailed(f"strategy constructor missing {sorted(missing)}")

    deposit = getattr(strategy_class, "deposit", None)
    update = getattr(strategy_class, "update", None)
    if not inspect.iscoroutinefunction(deposit):
        raise CheckFailed("StablecoinYieldStrategy.deposit must be async")
    if not inspect.iscoroutinefunction(update):
        raise CheckFailed("StablecoinYieldStrategy.update must be async")
    if "main_token_amount" not in inspect.signature(deposit).parameters:
        raise CheckFailed("deposit() must accept main_token_amount")

    min_gas = Decimal(str(getattr(strategy_class, "MIN_GAS", "0")))
    gas_float = Decimal(execute.GAS_FLOAT_WEI) / WEI_PER_ETH
    if gas_float < min_gas:
        raise CheckFailed(f"gas float {gas_float} ETH is below strategy MIN_GAS {min_gas} ETH")
    print(f"OK gas float {gas_float} ETH covers StablecoinYieldStrategy MIN_GAS {min_gas} ETH")
    print("OK StablecoinYieldStrategy constructor/deposit/update contract")
    return strategy_class


async def validate_lifecycle_wiring(execute: Any) -> None:
    spec = execute.STRATEGY_SPECS[STABLE_STRATEGY]
    module = importlib.import_module(spec["module"])
    original = getattr(module, spec["class_name"])
    calls: list[str] = []

    class FakeStrategy:
        def __init__(self, **_kwargs: Any) -> None:
            calls.append("init")

        async def deposit(self, main_token_amount: float = 0.0, gas_token_amount: float = 0.0):
            calls.append(f"deposit:{main_token_amount}:{gas_token_amount}")
            return True, "deposit ok"

        async def update(self):
            calls.append("update")
            return True, "update ok"

    setattr(module, spec["class_name"], FakeStrategy)
    try:
        result = await execute.run_strategy(
            strategy_name=STABLE_STRATEGY,
            spec=spec,
            amount_usd=2.0,
            wallet_id="test-wallet-id",
            wallet_address="0x0000000000000000000000000000000000000001",
            caip2=BASE_CAIP2,
        )
    finally:
        setattr(module, spec["class_name"], original)

    if not result.get("success"):
        raise CheckFailed(f"dry-run lifecycle failed: {result}")
    if calls != ["init", "deposit:2.0:0.0", "update"]:
        raise CheckFailed(f"unexpected lifecycle calls: {calls}")


async def validate_live_balances(
    execute: Any,
    strategy_class: type,
    wallet_address: str,
    amount: Decimal,
) -> None:
    balances = await execute._enriched_balances(wallet_address)
    base_usdc_units = 0
    base_eth_wei = 0
    for balance in balances:
        chain_id = int(balance.get("chain_id") or 0)
        if chain_id != BASE_CHAIN_ID:
            continue
        address = str(balance.get("address") or "").lower()
        raw_amount = int(balance.get("amount") or 0)
        if address == execute.USDC_BASE.lower():
            base_usdc_units += raw_amount
        if address in execute.NATIVE_SENTINELS:
            base_eth_wei += raw_amount

    required_usdc_units = int(amount * (10**USDC_DECIMALS))
    min_gas_wei = int(Decimal(str(getattr(strategy_class, "MIN_GAS", "0"))) * WEI_PER_ETH)
    required_eth_wei = max(int(execute.GAS_FLOAT_WEI), min_gas_wei)

    if base_usdc_units < required_usdc_units:
        have = Decimal(base_usdc_units) / Decimal(10**USDC_DECIMALS)
        raise CheckFailed(f"server wallet has {have} Base USDC, needs {amount}")
    if base_eth_wei < required_eth_wei:
        have = Decimal(base_eth_wei) / WEI_PER_ETH
        need = Decimal(required_eth_wei) / WEI_PER_ETH
        raise CheckFailed(f"server wallet has {have} Base ETH, needs at least {need}")
    print("OK live wallet has enough Base USDC and ETH")


if __name__ == "__main__":
    raise SystemExit(main())
