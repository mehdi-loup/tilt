"""Execution-ledger writes from the sidecar (Neon Postgres via asyncpg).

The Next.js side owns the schema (db/schema.sql) and creates executions/steps
rows at plan time; the sidecar only updates step + execution status as async
strategy jobs progress. When DATABASE_URL is unset (local dev) every write is
a no-op and /strategy/run falls back to synchronous execution, so the caller
still gets a final result in the response.
"""

from __future__ import annotations

import json
import os
from typing import Any

DATABASE_URL = os.environ.get("DATABASE_URL", "")

_POOL: Any = None


def enabled() -> bool:
    return bool(DATABASE_URL)


async def _pool() -> Any:
    global _POOL
    if _POOL is None:
        import asyncpg

        _POOL = await asyncpg.create_pool(DATABASE_URL, min_size=0, max_size=4)
    return _POOL


async def server_wallet_for_user(user_id: str) -> tuple[str, str] | None:
    """Canonical (wallet_id, address) for a user from the registry — the
    authoritative binding for fund-moving endpoints. None if unset or no row."""
    if not enabled():
        return None
    pool = await _pool()
    row = await pool.fetchrow(
        "select wallet_id, address from server_wallets where user_id = $1",
        user_id,
    )
    if row is None:
        return None
    return str(row["wallet_id"]), str(row["address"])


async def update_step(
    execution_id: str,
    step_id: str,
    *,
    status: str | None = None,
    job_id: str | None = None,
    tx_hashes: list[str] | None = None,
    note: str | None = None,
    error: str | None = None,
    result: dict[str, Any] | None = None,
) -> None:
    if not enabled():
        return
    pool = await _pool()
    await pool.execute(
        """
        update steps set
          status      = coalesce($3, status),
          job_id      = coalesce($4, job_id),
          tx_hashes   = coalesce($5::jsonb, tx_hashes),
          note        = coalesce($6, note),
          error       = $7,
          result      = coalesce($8::jsonb, result),
          updated_at  = now()
        where execution_id = $1 and step_id = $2
        """,
        execution_id,
        step_id,
        status,
        job_id,
        json.dumps(tx_hashes) if tx_hashes is not None else None,
        note,
        error,
        json.dumps(result) if result is not None else None,
    )


async def set_execution_status(execution_id: str, status: str) -> None:
    if not enabled():
        return
    pool = await _pool()
    await pool.execute(
        "update executions set status = $2, updated_at = now() where id = $1",
        execution_id,
        status,
    )


async def complete_execution_if_done(execution_id: str) -> None:
    """Mark the execution succeeded when no step remains unfinished."""
    if not enabled():
        return
    pool = await _pool()
    await pool.execute(
        """
        update executions set status = 'succeeded', updated_at = now()
        where id = $1 and not exists (
          select 1 from steps
          where execution_id = $1 and status not in ('succeeded', 'stub')
        )
        """,
        execution_id,
    )
