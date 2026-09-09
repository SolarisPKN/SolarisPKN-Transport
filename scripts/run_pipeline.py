#!/usr/bin/env python3
"""Orquesta conectores, fallback GTFS y salidas locales por etapas."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from connectors import (
    ConnectorConfigurationError,
    ConnectorExecutionError,
    PipelineContext,
    load_connectors,
)
from procesar_horarios import rebuild_database_atomic
from scripts.export_csv import export_csv
from scripts.update_schedules import load_config as load_schedule_config

DEFAULT_CONFIG = PROJECT_ROOT / "config" / "pipeline.json"
logger = logging.getLogger("solaris.pipeline")


def load_pipeline(path: Path) -> dict[str, Any]:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConnectorConfigurationError(f"No se pudo leer {path}: {exc}") from exc
    if config.get("version") != 1:
        raise ConnectorConfigurationError("Version de pipeline no soportada")
    for section in ("inputs", "outputs", "policy", "connectors"):
        if section not in config:
            raise ConnectorConfigurationError(f"pipeline.json no contiene {section}")
    return config


def _write_report(path: Path | None, report: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent,
    )
    os.close(descriptor)
    candidate = Path(temp_name)
    try:
        candidate.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(candidate, path)
    finally:
        candidate.unlink(missing_ok=True)


def build_context(
    config_path: Path,
    *,
    force_catalog: bool = False,
    dry_run: bool = False,
) -> tuple[PipelineContext, dict[str, tuple[Any, dict[str, Any]]]]:
    pipeline = load_pipeline(config_path)
    schedules = load_schedule_config(
        PROJECT_ROOT / pipeline["inputs"]["schedules"]
    )
    context = PipelineContext(
        PROJECT_ROOT, pipeline, schedules,
        force_catalog=force_catalog, dry_run=dry_run,
    )
    return context, load_connectors(pipeline)


def run_connector(
    context: PipelineContext,
    connectors: dict[str, tuple[Any, dict[str, Any]]],
    connector_id: str,
) -> dict[str, Any]:
    if connector_id not in connectors:
        raise ConnectorConfigurationError(f"Conector no registrado: {connector_id}")
    module, settings = connectors[connector_id]
    if not settings.get("enabled", True):
        return {"id": connector_id, "status": "disabled"}
    logger.info("Etapa conector: %s", connector_id)
    return module.run(context, settings)


def run_outputs(context: PipelineContext) -> dict[str, Any]:
    root = context.project_root
    xlsx_root = root / context.pipeline["inputs"]["xlsxRoot"]
    db_path = root / context.pipeline["outputs"]["sqlite"]
    csv_path = root / context.pipeline["outputs"]["csv"]
    stats = rebuild_database_atomic(db_path, xlsx_root, strict=True)
    rows = export_csv(db_path, csv_path)
    return {
        "status": "success",
        "sqlite": str(db_path.relative_to(root)),
        "csv": str(csv_path.relative_to(root)),
        "xlsxFound": stats["found"],
        "gridsCreated": stats["grids_created"],
        "scheduleRows": rows,
    }


def execute(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    context, connectors = build_context(
        args.config, force_catalog=args.force_catalog, dry_run=args.dry_run,
    )
    report: dict[str, Any] = {
        "version": 1, "stage": args.stage, "status": "success", "results": [],
    }
    exit_code = 0

    if args.stage in {"connector", "all"}:
        selected = [args.connector] if args.connector else [
            connector_id for connector_id, (_, settings) in connectors.items()
            if settings.get("role") == "primary" and settings.get("enabled", True)
        ]
        for connector_id in selected:
            try:
                result = run_connector(context, connectors, connector_id)
            except ConnectorExecutionError as exc:
                result = exc.result or {"id": connector_id, "status": "error"}
                result.setdefault("message", str(exc))
                report["status"] = "degraded"
                exit_code = 3
            except Exception as exc:
                result = {"id": connector_id, "status": "error", "message": str(exc)}
                report["status"] = "degraded"
                exit_code = 3
            report["results"].append(result)

    if args.stage in {"fallback", "all"}:
        fallback_ids = [
            connector_id for connector_id, (_, settings) in connectors.items()
            if settings.get("role") == "fallback" and settings.get("enabled", True)
        ]
        for connector_id in fallback_ids:
            try:
                result = run_connector(context, connectors, connector_id)
            except Exception as exc:
                result = {"id": connector_id, "status": "error", "message": str(exc)}
                report["status"] = "degraded"
                exit_code = max(exit_code, 3)
            if result.get("status") not in {"success", "disabled"}:
                report["status"] = "degraded"
            report["results"].append(result)

    if args.stage in {"outputs", "all"}:
        try:
            report["outputs"] = run_outputs(context)
        except Exception as exc:
            report["outputs"] = {"status": "error", "message": str(exc)}
            report["status"] = "error"
            exit_code = 4

    # En modo all, un conector remoto caido no invalida salidas locales sanas.
    if args.stage == "all" and report.get("outputs", {}).get("status") == "success":
        exit_code = 0
    return report, exit_code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--stage", choices=("connector", "fallback", "outputs", "all"),
        default="all",
    )
    parser.add_argument("--connector")
    parser.add_argument("--force-catalog", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    try:
        report, exit_code = execute(args)
    except ConnectorConfigurationError as exc:
        report, exit_code = {
            "version": 1, "stage": args.stage,
            "status": "error", "message": str(exc),
        }, 2
    _write_report(args.report, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
