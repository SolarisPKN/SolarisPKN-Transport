"""Registro dinamico de conectores del pipeline de cronogramas."""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


class ConnectorConfigurationError(RuntimeError):
    """El registro de conectores no cumple el contrato esperado."""


class ConnectorExecutionError(RuntimeError):
    """Un conector fallo sin invalidar la ejecucion de los demas."""

    def __init__(self, message: str, result: dict[str, Any] | None = None):
        super().__init__(message)
        self.result = result or {}


@dataclass(frozen=True)
class PipelineContext:
    project_root: Path
    pipeline: dict[str, Any]
    schedules: dict[str, Any]
    force_catalog: bool = False
    dry_run: bool = False


class ConnectorModule(Protocol):
    CONNECTOR_ID: str

    def run(
        self,
        context: PipelineContext,
        settings: dict[str, Any],
    ) -> dict[str, Any]: ...


def load_connectors(config: dict[str, Any]) -> dict[str, tuple[ConnectorModule, dict[str, Any]]]:
    """Carga solamente los modulos declarados y valida IDs duplicados."""
    loaded: dict[str, tuple[ConnectorModule, dict[str, Any]]] = {}
    entries = config.get("connectors")
    if not isinstance(entries, list) or not entries:
        raise ConnectorConfigurationError("pipeline.json no declara conectores")

    for settings in entries:
        if not isinstance(settings, dict):
            raise ConnectorConfigurationError("Cada conector debe ser un objeto")
        connector_id = str(settings.get("id") or "").strip()
        module_name = str(settings.get("module") or "").strip()
        if not connector_id or not module_name:
            raise ConnectorConfigurationError("Conector sin id o module")
        if connector_id in loaded:
            raise ConnectorConfigurationError(f"Conector duplicado: {connector_id}")
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            raise ConnectorConfigurationError(
                f"No se pudo cargar {connector_id} desde {module_name}: {exc}"
            ) from exc
        exported_id = str(getattr(module, "CONNECTOR_ID", "")).strip()
        runner = getattr(module, "run", None)
        if exported_id != connector_id or not callable(runner):
            raise ConnectorConfigurationError(
                f"{module_name} no implementa el contrato del conector {connector_id}"
            )
        loaded[connector_id] = (module, settings)
    return loaded
