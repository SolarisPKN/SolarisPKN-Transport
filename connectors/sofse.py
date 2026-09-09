"""Conector modular para cronogramas ferroviarios SOFSE."""

from __future__ import annotations

from typing import Any

from connectors import PipelineContext
from connectors.api_source import run_provider

CONNECTOR_ID = "sofse"


def run(context: PipelineContext, settings: dict[str, Any]) -> dict[str, Any]:
    return run_provider(CONNECTOR_ID, context, settings)
