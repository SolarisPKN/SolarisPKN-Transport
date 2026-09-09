#!/usr/bin/env python3
"""Exporta toda la base relacional a un unico CSV tabular y atomico."""

from __future__ import annotations

import argparse
import csv
import os
import sqlite3
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "horarios.db"
DEFAULT_OUTPUT = PROJECT_ROOT / "BD CSV" / "horarios.csv"

COLUMNS = [
    "tipo", "ramal", "empresa", "recorrido", "dia", "sentido",
    "formacion", "formacion_orden", "estacion", "estacion_orden",
    "horario", "minutos", "dia_offset", "vigencia", "metodo_actualizacion",
    "fuente_archivo", "website_url", "source_url",
]

QUERY = """
SELECT
    r.tipo, r.ramal, r.empresa, r.nombre AS recorrido,
    d.nombre AS dia, destino.nombre AS sentido,
    gf.nombre AS formacion, gf.orden AS formacion_orden,
    e.nombre AS estacion, ge.orden AS estacion_orden,
    h.minutos, r.vigencia_iso AS vigencia,
    g.metodo_actualizacion, g.fuente_archivo,
    r.website_url, r.pdf_url AS source_url
FROM horarios h
JOIN grilla_formaciones gf ON gf.id = h.grilla_formacion_id
JOIN grilla_estaciones ge ON ge.id = h.grilla_estacion_id
JOIN grillas g ON g.id = gf.grilla_id AND g.id = ge.grilla_id
JOIN recorridos r ON r.id = g.recorrido_id
JOIN dias d ON d.id = g.dia_id
JOIN estaciones e ON e.id = ge.estacion_id
JOIN estaciones destino ON destino.id = g.sentido_estacion_id
ORDER BY
    r.tipo_norm, r.ramal_norm, r.nombre_norm, d.id,
    destino.nombre_norm, gf.orden, ge.orden
"""


def _clock(minutes: int) -> str:
    local = minutes % 1440
    return f"{local // 60:02d}:{local % 60:02d}"


def export_csv(db_path: Path = DEFAULT_DB, output: Path = DEFAULT_OUTPUT) -> int:
    if not db_path.exists():
        raise FileNotFoundError(f"No existe la base SQLite: {db_path}")
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent,
    )
    os.close(descriptor)
    candidate = Path(temp_name)
    rows_written = 0
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        with candidate.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=COLUMNS)
            writer.writeheader()
            for row in connection.execute(QUERY):
                minutes = int(row["minutos"])
                writer.writerow({
                    "tipo": row["tipo"],
                    "ramal": row["ramal"],
                    "empresa": row["empresa"],
                    "recorrido": row["recorrido"],
                    "dia": row["dia"],
                    "sentido": row["sentido"],
                    "formacion": row["formacion"],
                    "formacion_orden": row["formacion_orden"],
                    "estacion": row["estacion"],
                    "estacion_orden": row["estacion_orden"],
                    "horario": _clock(minutes),
                    "minutos": minutes,
                    "dia_offset": minutes // 1440,
                    "vigencia": row["vigencia"],
                    "metodo_actualizacion": row["metodo_actualizacion"],
                    "fuente_archivo": row["fuente_archivo"],
                    "website_url": row["website_url"],
                    "source_url": row["source_url"],
                })
                rows_written += 1
    finally:
        connection.close()
    if rows_written == 0:
        candidate.unlink(missing_ok=True)
        raise RuntimeError("La base no contiene horarios exportables")
    os.replace(candidate, output)
    return rows_written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    rows = export_csv(args.db, args.output)
    print(f"CSV reemplazado atomicamente: {args.output} ({rows} filas)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
