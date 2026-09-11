"""Conector determinista para referencias públicas transcritas y auditables.

No scrapea sitios en tiempo de ejecución. El manifiesto conserva URL, fecha de
consulta y matriz; una fuente API con igual o mayor vigencia siempre prevalece.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from connectors import ConnectorExecutionError, PipelineContext
from scripts.update_schedules import ScheduleSnapshot, create_workbook, validate_generated_workbook

CONNECTOR_ID = "curated_public"


def _date(value: Any) -> dt.date:
    try:
        return dt.date.fromisoformat(str(value))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Fecha ISO inválida en manifiesto curado: {value!r}") from exc


def _minutes(value: Any) -> int | None:
    if value is None:
        return None
    hours, minutes = str(value).split(":", 1)
    result = int(hours) * 60 + int(minutes)
    if result < 0:
        raise ValueError(f"Horario inválido: {value!r}")
    return result


def _should_preserve_api(path: Path, checked_at: dt.date) -> bool:
    if not path.exists():
        return False
    parsed = validate_generated_workbook(path)
    return (
        parsed["metodo_actualizacion"].strip().casefold() == "api"
        and _date(parsed["vigencia_iso"]) >= checked_at
    )


def run(context: PipelineContext, settings: dict[str, Any]) -> dict[str, Any]:
    manifest_path = context.project_root / str(settings.get("manifest") or "")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    checked_at = _date(manifest.get("checkedAt"))
    staged: list[tuple[Path, Path]] = []
    results: list[dict[str, str]] = []

    try:
        for grid in manifest.get("grids", []):
            output = context.project_root / grid["path"]
            if settings.get("preserveCurrentApi", True) and _should_preserve_api(output, checked_at):
                results.append({"path": grid["path"], "status": "preserved_api"})
                continue

            route = {
                "id": grid["routeId"], "type": "Colectivo", "branch": grid["branch"],
                "company": grid["company"], "route": grid["route"],
                "website": grid["website"], "source_url": grid["sourceUrl"],
            }
            direction = {"destination": grid["destination"], "file_suffix": grid["fileSuffix"]}
            snapshot = ScheduleSnapshot(
                stations=list(grid["stations"]),
                formations=[service["name"] for service in grid["services"]],
                matrix=[[_minutes(value) for value in service["times"]] for service in grid["services"]],
                source_date=checked_at,
            )
            if any(len(row) != len(snapshot.stations) for row in snapshot.matrix):
                raise ValueError(f"Matriz incompatible con estaciones: {grid['path']}")

            output.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(prefix=".curated-", suffix=".xlsx", dir=output.parent, delete=False) as handle:
                candidate = Path(handle.name)
            create_workbook(candidate, route, direction, grid["day"], snapshot, method=grid.get("method", "Manual"))
            candidate_parsed = validate_generated_workbook(candidate)
            if output.exists() and validate_generated_workbook(output)["hash"] == candidate_parsed["hash"]:
                candidate.unlink(missing_ok=True)
                results.append({"path": grid["path"], "status": "unchanged"})
                continue
            staged.append((candidate, output))
            results.append({"path": grid["path"], "status": "would_update" if context.dry_run else "updated"})

        if not context.dry_run:
            for candidate, output in staged:
                os.replace(candidate, output)
        return {"id": CONNECTOR_ID, "status": "success", "checkedAt": checked_at.isoformat(), "results": results}
    except Exception as exc:
        raise ConnectorExecutionError(
            f"No se pudo aplicar el manifiesto curado: {exc}",
            {"id": CONNECTOR_ID, "status": "error", "results": results},
        ) from exc
    finally:
        for candidate, _ in staged:
            candidate.unlink(missing_ok=True)
