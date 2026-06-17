"""Gas-float gating tests for the Wayfinder sidecar.

These lock in the execution-wallet-aware gas logic and, by exercising both
``balance_fund`` and ``plan_fund`` end to end (SDK stubbed), guard the
function-signature contract with ``_base_gas_ok`` — the caller mismatch that
shipped a "_base_gas_ok() missing 1 required positional argument" crash.

``execute.py``'s wayfinder_paths imports are lazy (inside functions), so the
module imports with only the stdlib and the SDK is stubbed where a code path
reaches it. Run: ``pytest api/wayfinder/tests``.
"""

import asyncio
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import execute  # noqa: E402

ETH = 10**18
USDC = 10**6
BASE = execute.BASE_CHAIN_ID
TRIGGER = execute.GAS_FLOAT_TRIGGER_WEI  # 0.0005 ETH — top-up floor
FLOAT = execute.GAS_FLOAT_WEI  # 0.001 ETH — float amount
PAD = execute.BASE_GAS_PADDING_WEI  # 0.0003 ETH — funding wallet's own tx gas


def _base_native(wei: int) -> dict:
    return {
        "address": "native",
        "chain": "base",
        "chain_id": BASE,
        "amount": wei,
        "value_usd": wei / ETH * 3000,
        "symbol": "ETH",
    }


def _base_usdc(units: int) -> dict:
    return {
        "address": execute.USDC_BASE,
        "chain": "base",
        "chain_id": BASE,
        "amount": units,
        "value_usd": units / USDC,
        "symbol": "USDC",
    }


def _run(coro):
    return asyncio.run(coro)


# --- _base_gas_ok: the threshold logic the fix introduced -------------------


@pytest.mark.parametrize(
    "funding_wei, server_wei, expected",
    [
        # Execution wallet above the floor → no float owed → only padding needed.
        (PAD, TRIGGER, True),
        (PAD - 1, TRIGGER, False),
        # Execution wallet below the floor → funding must cover float + padding.
        (FLOAT + PAD, TRIGGER - 1, True),
        (FLOAT + PAD - 1, TRIGGER - 1, False),
        # Regression: funding 0.000942 ETH, execution 0.000857 ETH (above floor)
        # — used to be blocked by the flat 0.0013 reserve, now passes.
        (941_993_575_224_841, 857_324_982_512_149, True),
    ],
)
def test_base_gas_ok_threshold(funding_wei, server_wei, expected):
    assert execute._base_gas_ok([_base_native(funding_wei)], server_wei) is expected


# --- balance_fund: guards its _base_gas_ok call + the fix's behavior --------


def test_balance_fund_counts_usdc_when_execution_wallet_has_gas(monkeypatch):
    balances = [_base_usdc(2_430_000), _base_native(941_993_575_224_841)]

    async def fake(_addr):
        return balances

    monkeypatch.setattr(execute, "_enriched_balances", fake)
    res = _run(
        execute.balance_fund(
            from_address="0xfund",
            recipient_address=None,
            target_usdc_units=0,
            amount_usd=None,
            target_caip2=execute.DEFAULT_CAIP2,
            server_gas_wei=857_324_982_512_149,  # above the floor → no float owed
        )
    )
    assert res["baseGasOk"] is True
    assert res["investableUsd"] == pytest.approx(2.43, abs=0.01)


def test_balance_fund_gates_when_execution_wallet_empty(monkeypatch):
    balances = [_base_usdc(2_430_000), _base_native(941_993_575_224_841)]

    async def fake(_addr):
        return balances

    monkeypatch.setattr(execute, "_enriched_balances", fake)
    res = _run(
        execute.balance_fund(
            from_address="0xfund",
            recipient_address=None,
            target_usdc_units=0,
            amount_usd=None,
            target_caip2=execute.DEFAULT_CAIP2,
            server_gas_wei=0,  # empty → float owed → funding 0.000942 < 0.0013
        )
    )
    assert res["baseGasOk"] is False
    assert res["investableUsd"] == 0


# --- plan_fund: guards its _base_gas_ok call (the shipped crash) ------------


def _install_fake_brap(monkeypatch):
    """Stub the lazy ``from wayfinder_paths...brap_adapter.adapter import
    BRAPAdapter`` so plan_fund runs without the SDK."""
    names = [
        "wayfinder_paths",
        "wayfinder_paths.adapters",
        "wayfinder_paths.adapters.brap_adapter",
        "wayfinder_paths.adapters.brap_adapter.adapter",
    ]
    mods = {name: types.ModuleType(name) for name in names}
    for name, mod in mods.items():
        monkeypatch.setitem(sys.modules, name, mod)
    mods["wayfinder_paths"].adapters = mods["wayfinder_paths.adapters"]
    mods["wayfinder_paths.adapters"].brap_adapter = mods["wayfinder_paths.adapters.brap_adapter"]
    mods["wayfinder_paths.adapters.brap_adapter"].adapter = mods[
        "wayfinder_paths.adapters.brap_adapter.adapter"
    ]

    class FakeBRAP:
        def __init__(self, *args, **kwargs):
            pass

        async def best_quote(self, **kwargs):
            raise AssertionError("USDC-only plan should not need a BRAP quote")

    mods["wayfinder_paths.adapters.brap_adapter.adapter"].BRAPAdapter = FakeBRAP


def test_plan_fund_builds_transfer_from_base_usdc(monkeypatch):
    _install_fake_brap(monkeypatch)
    balances = [_base_usdc(1_000_000), _base_native(PAD + 1)]

    async def fake(_addr):
        return balances

    monkeypatch.setattr(execute, "_enriched_balances", fake)
    res = _run(
        execute.plan_fund(
            from_address="0xfund",
            recipient_address="0xserver",
            target_usdc_units=1_000_000,
            amount_usd=1.0,
            target_caip2=execute.DEFAULT_CAIP2,
            server_gas_wei=FLOAT,
        )
    )
    assert res["mode"] == "plan"
    assert res.get("error") is None
    # Funds already on Base as USDC → a single transfer to the server wallet.
    assert len(res["txs"]) == 1
    assert res["txs"][0]["to"].lower() == execute.USDC_BASE.lower()
