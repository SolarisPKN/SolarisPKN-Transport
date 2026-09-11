import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from connectors import PipelineContext
from connectors.curated_public import run
from procesar_horarios import parse_file
from scripts.update_schedules import ScheduleSnapshot, create_workbook


class CuratedPublicTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        manifest = {
            "checkedAt": "2026-09-11",
            "grids": [{
                "routeId": "test", "branch": "322 Luján", "company": "Operador",
                "route": "Origen - Destino", "day": "Feriado", "destination": "Destino",
                "fileSuffix": "Destino", "path": "Horarios/Test/FeriadoDestino.xlsx",
                "method": "Manual", "website": "https://example.com",
                "sourceUrl": "https://example.com/horario", "stations": ["Origen", "Destino"],
                "services": [{"name": "salida 1", "times": ["23:55", "24:15"]}],
            }],
        }
        (self.root / "config").mkdir()
        (self.root / "config/curated.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.context = PipelineContext(self.root, {}, {}, dry_run=False)
        self.settings = {"manifest": "config/curated.json", "preserveCurrentApi": True}
        self.output = self.root / "Horarios/Test/FeriadoDestino.xlsx"

    def tearDown(self):
        self.temp.cleanup()

    def test_generates_auditable_grid_and_is_idempotent(self):
        first = run(self.context, self.settings)
        parsed = parse_file(self.output)
        self.assertEqual(first["status"], "success")
        self.assertEqual(parsed["dia_canonical"], "Feriados")
        self.assertEqual(parsed["metodo_actualizacion"], "Manual")
        self.assertEqual(parsed["matrix"], [[1435, 1455]])
        self.assertEqual(run(self.context, self.settings)["results"][0]["status"], "unchanged")

    def test_preserves_equally_new_api_grid(self):
        route = {
            "id": "test", "type": "Colectivo", "branch": "322 Luján", "company": "Operador",
            "route": "Origen - Destino", "website": "https://example.com", "source_url": "https://example.com/api",
        }
        direction = {"destination": "Destino", "file_suffix": "Destino"}
        snapshot = ScheduleSnapshot(["Origen", "Destino"], ["api 1"], [[600, 620]], dt.date(2026, 9, 11))
        create_workbook(self.output, route, direction, "Laboral", snapshot, method="API")
        result = run(self.context, self.settings)
        self.assertEqual(result["results"][0]["status"], "preserved_api")
        self.assertEqual(parse_file(self.output)["metodo_actualizacion"], "API")


if __name__ == "__main__":
    unittest.main()
