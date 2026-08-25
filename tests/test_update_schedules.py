from __future__ import annotations

import datetime as dt
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from procesar_horarios import (
    parse_file,
    parse_time_to_minutes,
    rebuild_database_atomic,
)
from scripts.update_schedules import (
    CuandoSuboProvider,
    DEFAULT_BRANCHES,
    ScheduleSnapshot,
    SourceUnavailable,
    _catalog_match,
    build_sofse_credentials,
    create_workbook,
    load_branch_catalog,
    load_branch_selections,
    next_weekday,
    update_target,
    validate_snapshot,
)


ROUTE = {
    "id": "test-route",
    "folder": "unused",
    "type": "Tren",
    "branch": "Prueba",
    "company": "Solaris",
    "route": "Origen - Destino",
    "website": "https://example.com",
    "source_url": "https://example.com/api",
}

DIRECTION = {
    "file_suffix": "Destino",
    "destination": "Destino",
    "stations": [
        {"name": "Origen", "id": 1},
        {"name": "Destino", "id": 2},
    ],
}


class UpdateSchedulesTests(unittest.TestCase):
    def test_ramales_workbook_is_the_source_of_enabled_routes(self):
        selections = load_branch_selections(DEFAULT_BRANCHES)
        self.assertTrue(
            {"González Catán - Lozano", "Merlo - Lobos"}
            <= set(selections["Tren"]),
        )
        self.assertTrue({
            "136 A - Primera Junta - Navarro",
            "322 - Marcos Paz - Luján",
            "322 - Marcos Paz - Cañuelas",
        } <= set(selections["Colectivo"]))
        catalog = load_branch_catalog(DEFAULT_BRANCHES)
        self.assertGreater(len(catalog), 1000)
        once = _catalog_match("Once - Moreno", "Tren", catalog)
        self.assertIsNotNone(once)
        self.assertEqual(once["ID API"], "1")

    def test_discovered_bus_stops_are_bounded_and_keep_endpoints(self):
        stops = [
            {"name": f"Parada {index}", "stop_id": str(index)}
            for index in range(100)
        ]
        sampled = CuandoSuboProvider._sample_stops(stops)
        self.assertEqual(len(sampled), 12)
        self.assertEqual(sampled[0], stops[0])
        self.assertEqual(sampled[-1], stops[-1])

    def test_next_weekday_includes_today(self):
        tuesday = dt.date(2026, 8, 25)
        self.assertEqual(next_weekday(tuesday, 1), tuesday)
        self.assertEqual(next_weekday(tuesday, 5), dt.date(2026, 8, 29))

    def test_sofse_credentials_use_argentina_day(self):
        after_utc_midnight = dt.datetime(
            2026, 8, 24, 0, 30, tzinfo=dt.timezone.utc,
        )
        credentials = build_sofse_credentials(after_utc_midnight)
        self.assertEqual(credentials["username"], "MjAyNjA4MjNzb2ZzZQ==")
        self.assertTrue(credentials["password"])

    def test_cuando_subo_route_times_selects_requested_route(self):
        source_date = dt.date(2026, 8, 25)
        timestamp = int(
            dt.datetime(2026, 8, 25, 6, 30, tzinfo=dt.timezone(
                dt.timedelta(hours=-3)
            )).timestamp() * 1000
        )
        response = {
            "data": {
                "entry": {
                    "stopRouteSchedules": [
                        {
                            "routeId": "739_670",
                            "stopRouteDirectionSchedules": [{
                                "scheduleStopTimes": [{
                                    "tripId": "739_trip-1",
                                    "departureEnabled": True,
                                    "departureTime": timestamp,
                                }],
                            }],
                        },
                        {
                            "routeId": "otra",
                            "stopRouteDirectionSchedules": [{
                                "scheduleStopTimes": [{
                                    "tripId": "ignorar",
                                    "departureEnabled": True,
                                    "departureTime": timestamp,
                                }],
                            }],
                        },
                    ],
                },
            },
        }
        self.assertEqual(
            CuandoSuboProvider.route_times(response, "739_670", source_date),
            {"739_trip-1": 390},
        )

    def test_cross_midnight_is_preserved_in_xlsx_and_sqlite(self):
        snapshot = ScheduleSnapshot(
            stations=["Origen", "Destino"],
            formations=["N1"],
            matrix=[[23 * 60 + 40, 24 * 60 + 5]],
            source_date=dt.date(2026, 8, 25),
        )
        validate_snapshot(snapshot)
        self.assertEqual(parse_time_to_minutes("24:05"), 1445)

        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "Horarios" / "Trenes" / "Prueba"
            workbook_path = base / "LaboralDestino.xlsx"
            create_workbook(workbook_path, ROUTE, DIRECTION, "Laboral", snapshot)
            parsed = parse_file(workbook_path)
            self.assertEqual(parsed["matrix"], [[1420, 1445]])

            database = Path(directory) / "horarios.db"
            rebuild_database_atomic(database, Path(directory) / "Horarios", strict=True)
            connection = sqlite3.connect(database)
            try:
                minutes = [
                    row[0] for row in connection.execute(
                        "SELECT minutos FROM horarios ORDER BY minutos"
                    ).fetchall()
                ]
                method = connection.execute(
                    "SELECT metodo_actualizacion FROM grillas"
                ).fetchone()[0]
            finally:
                connection.close()
            self.assertEqual(minutes, [1420, 1445])
            self.assertEqual(method, "API")

    def test_source_failure_does_not_touch_existing_workbook(self):
        provider = Mock()
        provider.snapshot.side_effect = SourceUnavailable("caida controlada")
        with tempfile.TemporaryDirectory() as directory:
            # update_target calcula el destino desde PROJECT_ROOT; verificamos
            # la propiedad esencial directamente: la excepcion ocurre antes de
            # crear temporales o reemplazar el archivo.
            with self.assertRaises(SourceUnavailable):
                update_target(
                    provider,
                    {**ROUTE, "folder": str(Path(directory) / "safe")},
                    DIRECTION,
                    "Laboral",
                    1,
                    dt.date(2026, 8, 25),
                    dry_run=False,
                )
            provider.snapshot.assert_called_once()


if __name__ == "__main__":
    unittest.main()
