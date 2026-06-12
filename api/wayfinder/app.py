"""FastAPI sidecar — thin HTTP adapter over the Wayfinder engine (execute.py).

Three real endpoints plus health:
  POST /fund/plan      — Wayfinder builds unsigned funding txs for the user
  POST /fund/balance   — investable USD for the amount presets
  POST /strategy/run   — run a strategy step; async job when the ledger is
                         configured (returns jobId, writes status rows),
                         synchronous otherwise (returns the final result)

A legacy POST / route keeps the old single-endpoint body contract working
while a previous Next.js deploy is still live.

Auth on every POST:
  - x-tilt-internal-secret: shared Next.js → sidecar secret
  - x-tilt-user-jwt: Privy user access token forwarded after verifyAuthToken
    (Cloud Run swallows `Authorization: Bearer` as Google IAM auth).

uvicorn provides the single long-lived event loop the SDK's module-level
httpx clients require; background jobs run on it via asyncio.create_task,
so the Cloud Run service must keep CPU always allocated.
"""

from __future__ import annotations

import asyncio
import traceback
import uuid
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

import execute
import ledger

app = FastAPI(title="tilt wayfinder sidecar")


def _auth(
    x_tilt_internal_secret: str | None = Header(default=None),
    x_tilt_user_jwt: str | None = Header(default=None),
) -> str:
    if not execute.INTERNAL_SECRET:
        raise HTTPException(503, "internal sidecar secret is not configured")
    if x_tilt_internal_secret != execute.INTERNAL_SECRET:
        raise HTTPException(403, "forbidden")
    jwt = (x_tilt_user_jwt or "").strip()
    if not jwt:
        raise HTTPException(401, "missing user JWT")
    return jwt


def _engine_error(exc: Exception) -> JSONResponse:
    if isinstance(exc, execute.StrategyImportError):
        return JSONResponse(status_code=503, content={
            "ok": False,
            "source": "missing-dep",
            "error": str(exc),
            "hint": "Add wayfinder-paths to api/wayfinder/requirements.txt and redeploy.",
        })
    return JSONResponse(status_code=502, content={
        "ok": False,
        "source": "wayfinder-error",
        "error": execute._wayfinder_error_message(exc),
        "trace": traceback.format_exc(),
    })


@app.get("/")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "wayfinder-executor",
        "strategies": list(execute.STRATEGY_SPECS.keys()),
        "wayfinderInstalled": execute._wayfinder_installed(),
        "ledger": ledger.enabled(),
    }


@app.post("/fund/plan")
async def fund_plan(body: dict[str, Any], _jwt: str = Depends(_auth)):
    from_address = body.get("fromAddress")
    recipient_address = body.get("recipientAddress")
    target_units = body.get("targetUsdcUnits")
    if not (from_address and recipient_address and target_units):
        raise HTTPException(400, "fromAddress, recipientAddress, targetUsdcUnits required")
    try:
        result = await execute.plan_fund(
            from_address=from_address,
            recipient_address=recipient_address,
            target_usdc_units=int(target_units),
            amount_usd=float(body["amountUsd"]) if body.get("amountUsd") is not None else None,
            target_caip2=body.get("caip2", execute.DEFAULT_CAIP2),
        )
    except Exception as exc:  # noqa: BLE001 — surfaced to the caller
        return _engine_error(exc)
    return {"ok": True, "source": "live", **result}


@app.post("/fund/balance")
async def fund_balance(body: dict[str, Any], _jwt: str = Depends(_auth)):
    from_address = body.get("fromAddress")
    if not from_address:
        raise HTTPException(400, "fromAddress required")
    try:
        result = await execute.balance_fund(
            from_address=from_address,
            recipient_address=None,
            target_usdc_units=0,
            amount_usd=None,
            target_caip2=body.get("caip2", execute.DEFAULT_CAIP2),
        )
    except Exception as exc:  # noqa: BLE001
        return _engine_error(exc)
    return {"ok": True, "source": "live", **result}


# ─── Strategy runs ─────────────────────────────────────────────────────────

# In-memory job mirror for debugging; the Postgres ledger is the source of
# truth the client polls (via Next.js).
_JOBS: dict[str, dict[str, Any]] = {}


async def _dispatch(strategy_name: str, spec: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    runner = execute.run_rotator if spec.get("kind") == "path" else execute.run_strategy
    return await runner(
        strategy_name=strategy_name,
        spec=spec,
        amount_usd=float(body["amountUsd"]),
        wallet_id=body["walletId"],
        wallet_address=body["walletAddress"],
        caip2=body.get("caip2", execute.DEFAULT_CAIP2),
    )


async def _run_job(
    job_id: str,
    execution_id: str,
    step_id: str,
    strategy_name: str,
    spec: dict[str, Any],
    body: dict[str, Any],
) -> None:
    _JOBS[job_id] = {"status": "running"}
    try:
        result = await _dispatch(strategy_name, spec, body)
    except Exception as exc:  # noqa: BLE001 — recorded on the ledger
        error = execute._wayfinder_error_message(exc)
        _JOBS[job_id] = {"status": "failed", "error": error}
        await ledger.update_step(execution_id, step_id, status="failed", error=error)
        await ledger.set_execution_status(execution_id, "failed")
        return
    ok = bool(result.get("success"))
    _JOBS[job_id] = {"status": "succeeded" if ok else "failed", "result": result}
    await ledger.update_step(
        execution_id,
        step_id,
        status="succeeded" if ok else "failed",
        error=None if ok else str(result.get("error") or "strategy failed"),
        tx_hashes=result.get("txHashes") or [],
        result=result,
    )
    if ok:
        await ledger.complete_execution_if_done(execution_id)
    else:
        await ledger.set_execution_status(execution_id, "failed")


@app.post("/strategy/run")
async def strategy_run(body: dict[str, Any], _jwt: str = Depends(_auth)):
    try:
        strategy_name, spec = execute.resolve_strategy(
            body.get("profileId"), body.get("strategyName")
        )
    except execute.StrategyResolutionError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not (body.get("walletId") and body.get("walletAddress")
            and isinstance(body.get("amountUsd"), (int, float))):
        raise HTTPException(400, "walletId, walletAddress, amountUsd required")

    execution_id = body.get("executionId")
    step_id = body.get("stepId")

    # Durable path: detach the run as a job and let the client poll the ledger.
    if ledger.enabled() and execution_id and step_id:
        job_id = uuid.uuid4().hex
        await ledger.update_step(execution_id, step_id, status="running", job_id=job_id)
        await ledger.set_execution_status(execution_id, "running")
        asyncio.create_task(
            _run_job(job_id, execution_id, step_id, strategy_name, spec, dict(body))
        )
        return {"ok": True, "source": "job", "jobId": job_id}

    # Dev fallback: no ledger to poll, so run synchronously.
    try:
        result = await _dispatch(strategy_name, spec, body)
    except Exception as exc:  # noqa: BLE001
        return _engine_error(exc)
    if not result.get("success", False):
        return JSONResponse(status_code=502, content={"ok": False, "source": "wayfinder-error", **result})
    return {"ok": True, "source": "live", **result}


@app.get("/jobs/{job_id}")
async def job_status(job_id: str, _jwt: str = Depends(_auth)) -> dict[str, Any]:
    return {"ok": True, "job": _JOBS.get(job_id) or {"status": "unknown"}}


# ─── Legacy combined route (migration overlap only) ───────────────────────


@app.post("/")
async def legacy(body: dict[str, Any], _jwt: str = Depends(_auth)):
    """Old single-endpoint contract: operation=fund (plan/balance) or a
    synchronous strategy execution. Remove once no pre-ledger Next.js deploy
    is live."""
    if body.get("operation") == "fund":
        if body.get("mode", "plan") == "balance":
            return await fund_balance(body, _jwt)
        return await fund_plan(body, _jwt)
    return await strategy_run({k: v for k, v in body.items() if k not in ("executionId", "stepId")}, _jwt)
