"""Adaptador comun para fuentes vivas que ya implementa update_schedules."""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any

from connectors import ConnectorExecutionError, PipelineContext
from scripts.update_route_catalog import (
    build_catalog,
    catalog_age_days,
    catalog_update_dates,
    load_branch_catalog,
    merge_provider_catalog,
    write_catalog,
)
from scripts.update_schedules import ARGENTINA_TZ, SourceUnavailable, run as run_schedules


def _refresh_catalog(
    provider: str,
    branches: Path,
    max_age_days: int,
    force: bool,
    dry_run: bool,
) -> dict[str, Any]:
    today = dt.datetime.now(ARGENTINA_TZ).date()
    age = catalog_age_days(branches, today, provider)
    if not force and age is not None and age < max_age_days:
        return {"status": "fresh", "ageDays": age}

    try:
        replacement = build_catalog(provider)
    except SourceUnavailable as exc:
        return {"status": "error", "message": str(exc)}

    if dry_run:
        return {"status": "would_update", "routes": len(replacement)}

    dates = catalog_update_dates(branches)
    rows = merge_provider_catalog(
        load_branch_catalog(branches), replacement, provider,
    )
    dates[provider] = today
    write_catalog(branches, rows, today, dates)
    return {"status": "updated", "routes": len(replacement)}


def run_provider(
    provider: str,
    context: PipelineContext,
    settings: dict[str, Any],
) -> dict[str, Any]:
    branches = context.project_root / context.pipeline["inputs"]["branches"]
    catalog = _refresh_catalog(
        provider,
        branches,
        int(settings.get("catalogMaxAgeDays", 7)),
        context.force_catalog,
        context.dry_run,
    )

    schedules = run_schedules(
        context.project_root / context.pipeline["inputs"]["schedules"],
        branches_path=branches,
        dry_run=context.dry_run,
        only_providers={provider},
    )
    result = {
        "id": provider,
        "role": "primary",
        "catalog": catalog,
        "schedules": schedules,
        "status": "success",
    }
    if catalog.get("status") == "error":
        result["status"] = "degraded"
    if schedules.get("connector_failures"):
        result["status"] = "error"
        failure = schedules["connector_failures"].get(provider) or str(
            schedules["connector_failures"]
        )
        raise ConnectorExecutionError(failure, result)
    return result
