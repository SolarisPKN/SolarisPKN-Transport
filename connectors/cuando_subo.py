"""Conector modular para cronogramas de colectivos de Cuando SUBO."""

from __future__ import annotations

from typing import Any

from connectors import PipelineContext
from connectors.api_source import run_provider

CONNECTOR_ID = "cuando_subo"


def run(context: PipelineContext, settings: dict[str, Any]) -> dict[str, Any]:
    return run_provider(CONNECTOR_ID, context, settings)
