from __future__ import annotations

import csv
import datetime as dt
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from connectors import ConnectorExecutionError, PipelineContext, load_connectors
from connectors.gtfs import run as run_gtfs
from procesar_horarios import parse_file, rebuild_database_atomic
from scripts.export_csv import COLUMNS, export_csv
from scripts.run_pipeline import execute
from scripts.update_schedules import ScheduleSnapshot, create_workbook


ROUTE = {
    "id": "route-test",
    "provider": "test",
    "folder": "Horarios/Colectivos/Test",
    "type": "Colectivo",
    "branch": "136 Test",
    "company": "Operador Test",
    "route": "Origen - Destino",
    "website": "https://example.com",
    "source_url": "https://example.com/source",
    "days": ["Laboral"],
    "directions": [{
        "file_suffix": "Destino",
        "destination": "Destino",
        "stations": [{"name": "Origen"}, {"name": "Destino"}],
    }],
}


def make_feed(path: Path) -> None:
    files = {
        "routes.txt": (
            "route_id,route_short_name,route_long_name,route_desc,route_type\n"
            "R1,136A,Linea 136,Ramal A - Origen - Destino,3\n"
        ),
        "calendar.txt": (
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
            "W,1,1,1,1,1,0,0,20200201,20200430\n"
        ),
        "trips.txt": (
            "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,shape_id\n"
            "R1,W,T1,Destino,F1,0,S1\n"
            "R1,W,T2,Destino,F2,0,S1\n"
        ),
        "stop_times.txt": (
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint\n"
            "T1,06:00:00,06:00:00,O,1,1\n"
            "T1,06:30:00,06:30:00,D,2,1\n"
            "T2,07:00:00,07:00:00,O,1,1\n"
            "T2,07:30:00,07:30:00,D,2,1\n"
        ),
        "stops.txt": (
            "stop_id,stop_name,stop_lat,stop_lon\n"
            "O,Origen,-34.0,-58.0\n"
            "D,Destino,-34.1,-58.1\n"
        ),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            archive.writestr(name, value)


class PipelineTests(unittest.TestCase):
    def test_registry_loads_all_configured_connectors(self):
        config = {
            "connectors": [
                {"id": "sofse", "module": "connectors.sofse"},
                {"id": "cuando_subo", "module": "connectors.cuando_subo"},
                {"id": "gtfs", "module": "connectors.gtfs"},
            ]
        }
        self.assertEqual(
            set(load_connectors(config)), {"sofse", "cuando_subo", "gtfs"},
        )

    def test_all_stage_continues_after_one_primary_connector_fails(self):
        context = PipelineContext(
            Path("."),
            {"policy": {"continueAfterConnectorError": True}},
            {"days": {}, "routes": []},
        )
        connectors = {
            "sofse": (object(), {"role": "primary", "enabled": True}),
            "cuando_subo": (object(), {"role": "primary", "enabled": True}),
            "gtfs": (object(), {"role": "fallback", "enabled": True}),
        }

        def connector_result(_context, _connectors, connector_id):
            if connector_id == "sofse":
                raise ConnectorExecutionError(
                    "caida controlada", {"id": "sofse", "status": "error"},
                )
            return {"id": connector_id, "status": "success"}

        args = SimpleNamespace(
            config=Path("unused.json"), force_catalog=False, dry_run=False,
            stage="all", connector=None,
        )
        with (
            patch("scripts.run_pipeline.build_context", return_value=(context, connectors)),
            patch("scripts.run_pipeline.run_connector", side_effect=connector_result),
            patch("scripts.run_pipeline.run_outputs", return_value={"status": "success"}),
        ):
            report, exit_code = execute(args)

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            [result["id"] for result in report["results"]],
            ["sofse", "cuando_subo", "gtfs"],
        )
        self.assertEqual(report["outputs"]["status"], "success")

    def test_gtfs_creates_only_missing_xlsx_and_marks_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / ".cache" / "gtfs"
            make_feed(cache / "test-feed.zip")
            schedules = {"days": {"Laboral": 1}, "routes": [ROUTE]}
            pipeline = {
                "inputs": {"xlsxRoot": "Horarios"},
                "outputs": {},
            }
            settings = {
                "cacheDir": ".cache/gtfs",
                "feeds": [{
                    "id": "test-feed",
                    "url": "https://invalid.example/feed.zip",
                    "datasetUrl": "https://example.com/dataset",
                }],
                "mappings": {"route-test": {
                    "feed": "test-feed",
                    "routeId": "R1",
                    "directions": {"Destino": {
                        "directionId": "0",
                        "fallbackDestination": "Destino",
                    }},
                }},
            }
            context = PipelineContext(root, pipeline, schedules)
            first = run_gtfs(context, settings)
            output = root / "Horarios/Colectivos/Test/LaboralDestino.xlsx"
            self.assertEqual(first["created"], 1)
            parsed = parse_file(output)
            self.assertEqual(parsed["metodo_actualizacion"], "GTFS")
            self.assertEqual(parsed["vigencia_iso"], "2020-04-30")
            original = output.read_bytes()

            second = run_gtfs(context, settings)
            self.assertEqual(second["created"], 0)
            self.assertEqual(output.read_bytes(), original)

    def test_gtfs_reports_unmapped_missing_target_without_inventing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = PipelineContext(
                root,
                {"inputs": {"xlsxRoot": "Horarios"}, "outputs": {}},
                {"days": {"Laboral": 1}, "routes": [ROUTE]},
            )
            result = run_gtfs(context, {"feeds": [], "mappings": {}})
            self.assertEqual(result["created"], 0)
            self.assertEqual(len(result["unmapped"]), 1)
            self.assertFalse((root / ROUTE["folder"]).exists())

    def test_csv_export_contains_every_schedule_cell(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            xlsx = root / "Horarios/Colectivos/Test/LaboralDestino.xlsx"
            snapshot = ScheduleSnapshot(
                ["Origen", "Destino"], ["F1", "F2"],
                [[360, 390], [420, 450]], dt.date(2026, 9, 8),
            )
            create_workbook(
                xlsx, ROUTE, ROUTE["directions"][0], "Laboral", snapshot,
            )
            database = root / "horarios.db"
            rebuild_database_atomic(database, root / "Horarios", strict=True)
            output = root / "BD CSV/horarios.csv"
            self.assertEqual(export_csv(database, output), 4)
            with output.open(encoding="utf-8-sig", newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(list(rows[0]), COLUMNS)
            self.assertEqual([row["horario"] for row in rows], [
                "06:00", "06:30", "07:00", "07:30",
            ])


if __name__ == "__main__":
    unittest.main()
