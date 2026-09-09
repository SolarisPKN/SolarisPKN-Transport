"""Fallback GTFS: solo crea XLSX ausentes y nunca reemplaza existentes."""

from __future__ import annotations

import csv
import datetime as dt
import io
import os
import tempfile
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from connectors import ConnectorExecutionError, PipelineContext
from scripts.update_schedules import (
    ScheduleSnapshot,
    create_workbook,
    normalize_text,
    validate_generated_workbook,
    validate_snapshot,
)

CONNECTOR_ID = "gtfs"
REQUIRED = {"routes.txt", "trips.txt", "stop_times.txt", "stops.txt"}


def _date(value: str) -> dt.date:
    return dt.datetime.strptime(value, "%Y%m%d").date()


def _minutes(value: str) -> int:
    parts = value.strip().split(":")
    if len(parts) != 3:
        raise ValueError(f"Hora GTFS invalida: {value!r}")
    hour, minute, second = map(int, parts)
    if hour < 0 or minute not in range(60) or second not in range(60):
        raise ValueError(f"Hora GTFS invalida: {value!r}")
    return hour * 60 + minute + (1 if second >= 30 else 0)


class GtfsFeed:
    def __init__(self, path: Path):
        self.path = path
        self.archive = zipfile.ZipFile(path)
        self.members = {
            Path(name).name: name for name in self.archive.namelist()
            if not name.endswith("/")
        }
        self._trips_by_route: dict[str, dict[str, dict[str, str]]] = {}
        self._sequences_by_route: dict[str, dict[str, list[dict[str, str]]]] = {}
        missing = REQUIRED - self.members.keys()
        if missing:
            self.close()
            raise ConnectorExecutionError(
                f"GTFS incompleto {path.name}: faltan {', '.join(sorted(missing))}"
            )

    def close(self) -> None:
        self.archive.close()

    def rows(self, name: str) -> Iterable[dict[str, str]]:
        member = self.members.get(name)
        if not member:
            return iter(())
        binary = self.archive.open(member)
        text = io.TextIOWrapper(binary, encoding="utf-8-sig", newline="")
        return csv.DictReader(text)

    def services(self, weekday: int) -> tuple[set[str], dt.date]:
        service_ids: set[str] = set()
        dates: list[dt.date] = []
        if "calendar.txt" in self.members:
            columns = [
                "monday", "tuesday", "wednesday", "thursday",
                "friday", "saturday", "sunday",
            ]
            for row in self.rows("calendar.txt"):
                dates.append(_date(row["end_date"]))
                if row.get(columns[weekday]) == "1":
                    service_ids.add(row["service_id"])
        elif "calendar_dates.txt" in self.members:
            candidates: Counter[str] = Counter()
            for row in self.rows("calendar_dates.txt"):
                current = _date(row["date"])
                dates.append(current)
                if row.get("exception_type") == "1" and current.weekday() == weekday:
                    candidates[row["service_id"]] += 1
            if candidates:
                maximum = max(candidates.values())
                service_ids = {
                    key for key, count in candidates.items() if count == maximum
                }
        if not service_ids or not dates:
            raise ConnectorExecutionError(
                f"{self.path.name} no define servicios para weekday={weekday}"
            )
        return service_ids, max(dates)

    def route_id(self, mapping: dict[str, Any]) -> str:
        exact = str(mapping.get("routeId") or "").strip()
        short_name = normalize_text(mapping.get("routeShortName"))
        description = normalize_text(mapping.get("routeDescriptionContains"))
        matches: list[str] = []
        for row in self.rows("routes.txt"):
            if exact and row.get("route_id") != exact:
                continue
            if short_name and normalize_text(row.get("route_short_name")) != short_name:
                continue
            detail = normalize_text(
                f"{row.get('route_long_name', '')} {row.get('route_desc', '')}"
            )
            if description and description not in detail:
                continue
            if row.get("route_id"):
                matches.append(row["route_id"])
        unique = sorted(set(matches))
        if len(unique) != 1:
            raise ConnectorExecutionError(
                f"Mapeo GTFS ambiguo o ausente: aparecieron {len(unique)} rutas"
            )
        return unique[0]

    def route_data(
        self, route_id: str,
    ) -> tuple[dict[str, dict[str, str]], dict[str, list[dict[str, str]]]]:
        if route_id in self._trips_by_route:
            return self._trips_by_route[route_id], self._sequences_by_route[route_id]
        trips = {
            row["trip_id"]: row for row in self.rows("trips.txt")
            if row.get("route_id") == route_id
        }
        sequences: dict[str, list[dict[str, str]]] = {key: [] for key in trips}
        for row in self.rows("stop_times.txt"):
            trip_id = row.get("trip_id")
            if trip_id in sequences:
                sequences[trip_id].append(row)
        sequences = {
            key: sorted(value, key=lambda row: int(row["stop_sequence"]))
            for key, value in sequences.items() if len(value) >= 2
        }
        self._trips_by_route[route_id] = trips
        self._sequences_by_route[route_id] = sequences
        return trips, sequences

    def snapshot(
        self,
        route_mapping: dict[str, Any],
        direction_mapping: dict[str, Any],
        weekday: int,
    ) -> tuple[ScheduleSnapshot, str]:
        service_ids, feed_date = self.services(weekday)
        route_id = self.route_id(route_mapping)
        direction_id = str(direction_mapping["directionId"])
        headsign = normalize_text(direction_mapping.get("headsignContains"))
        all_trips, all_sequences = self.route_data(route_id)
        trips = {
            trip_id: row for trip_id, row in all_trips.items()
            if row.get("service_id") in service_ids
            and str(row.get("direction_id")) == direction_id
            and (
                not headsign
                or headsign in normalize_text(row.get("trip_headsign"))
            )
        }
        if not trips:
            raise ConnectorExecutionError(
                f"GTFS sin viajes para ruta={route_id}, sentido={direction_id}"
            )
        sequences = {
            trip_id: all_sequences[trip_id] for trip_id in trips
            if trip_id in all_sequences
        }
        if not sequences:
            raise ConnectorExecutionError("GTFS sin secuencias utilizables")

        canonical_trip = max(sequences, key=lambda key: len(sequences[key]))
        stop_ids = [row["stop_id"] for row in sequences[canonical_trip]]
        needed = set(stop_ids)
        names = {
            row["stop_id"]: str(row.get("stop_name") or row["stop_id"]).strip()
            for row in self.rows("stops.txt") if row.get("stop_id") in needed
        }
        stations = _unique_names(
            [names.get(stop_id, stop_id) for stop_id in stop_ids], stop_ids,
        )
        destination = str(
            direction_mapping.get("fallbackDestination") or stations[-1]
        ).strip()
        stations[-1] = destination

        formations: list[str] = []
        matrix: list[list[int | None]] = []
        seen: set[str] = set()
        for trip_id in sorted(sequences, key=lambda key: _first(sequences[key])):
            values = {
                row["stop_id"]: _minutes(
                    row.get("arrival_time") or row.get("departure_time") or ""
                ) for row in sequences[trip_id]
            }
            row_values = [values.get(stop_id) for stop_id in stop_ids]
            if sum(value is not None for value in row_values) < 2:
                continue
            formation = str(trips[trip_id].get("trip_short_name") or trip_id).strip()
            if normalize_text(formation) in seen:
                formation = f"{formation}-{trip_id}"
            seen.add(normalize_text(formation))
            formations.append(formation)
            matrix.append(row_values)

        snapshot = ScheduleSnapshot(stations, formations, matrix, feed_date)
        validate_snapshot(snapshot, allow_short_turns=True)
        return snapshot, destination


def _first(rows: list[dict[str, str]]) -> int:
    return _minutes(rows[0].get("departure_time") or rows[0]["arrival_time"])


def _unique_names(names: list[str], stop_ids: list[str]) -> list[str]:
    counts = Counter(normalize_text(name) for name in names)
    return [
        f"{name} ({stop_id})" if counts[normalize_text(name)] > 1 else name
        for name, stop_id in zip(names, stop_ids)
    ]


def _download(feed: dict[str, Any], cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = cache_dir / f"{feed['id']}.zip"
    if destination.exists():
        try:
            with zipfile.ZipFile(destination) as archive:
                if REQUIRED <= {Path(name).name for name in archive.namelist()}:
                    return destination
        except zipfile.BadZipFile:
            pass
    candidate: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{feed['id']}-", suffix=".zip", dir=cache_dir, delete=False,
        ) as temp_file:
            candidate = Path(temp_file.name)
        request = urllib.request.Request(
            feed["url"], headers={"User-Agent": "SolarisPKN-Transport/GTFS-fallback"},
        )
        with urllib.request.urlopen(request, timeout=60) as response, candidate.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        with zipfile.ZipFile(candidate) as archive:
            missing = REQUIRED - {Path(name).name for name in archive.namelist()}
            if missing:
                raise ConnectorExecutionError(
                    f"Descarga GTFS incompleta: {', '.join(sorted(missing))}"
                )
        os.replace(candidate, destination)
        candidate = None
        return destination
    finally:
        if candidate is not None:
            candidate.unlink(missing_ok=True)


def _targets(
    context: PipelineContext,
    settings: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    mappings = settings.get("mappings") or {}
    missing: list[dict[str, Any]] = []
    unmapped: list[dict[str, str]] = []
    for route in context.schedules["routes"]:
        route_mapping = mappings.get(route["id"])
        for day in route["days"]:
            for direction in route["directions"]:
                output = (
                    context.project_root / route["folder"]
                    / f"{day}{direction['file_suffix']}.xlsx"
                )
                if output.exists():
                    continue
                direction_mapping = (
                    (route_mapping or {}).get("directions", {})
                    .get(direction["file_suffix"])
                )
                if not route_mapping or not direction_mapping:
                    unmapped.append({
                        "route": route["id"], "day": day,
                        "direction": direction["file_suffix"],
                        "file": str(output.relative_to(context.project_root)),
                    })
                else:
                    missing.append({
                        "route": route, "route_mapping": route_mapping,
                        "direction": direction,
                        "direction_mapping": direction_mapping,
                        "day": day,
                        "weekday": int(context.schedules["days"][day]),
                        "output": output,
                    })
    return missing, unmapped


def run(context: PipelineContext, settings: dict[str, Any]) -> dict[str, Any]:
    missing, unmapped = _targets(context, settings)
    result: dict[str, Any] = {
        "id": CONNECTOR_ID, "role": "fallback", "status": "success",
        "created": 0, "wouldCreate": 0, "preservedExisting": 0,
        "unmapped": unmapped, "errors": [], "targets": [],
    }
    if not missing:
        return result

    feeds = {feed["id"]: feed for feed in settings.get("feeds", [])}
    cache_dir = context.project_root / settings.get("cacheDir", ".cache/gtfs")
    opened: dict[str, GtfsFeed] = {}
    try:
        for target in missing:
            output: Path = target["output"]
            mapping = target["route_mapping"]
            feed_id = mapping.get("feed")
            try:
                if feed_id not in feeds:
                    raise ConnectorExecutionError(f"Feed GTFS desconocido: {feed_id}")
                if feed_id not in opened:
                    opened[feed_id] = GtfsFeed(_download(feeds[feed_id], cache_dir))
                snapshot, destination = opened[feed_id].snapshot(
                    mapping, target["direction_mapping"], target["weekday"],
                )
                if output.exists():
                    result["preservedExisting"] += 1
                    continue
                route = dict(target["route"])
                route["website"] = feeds[feed_id]["datasetUrl"]
                route["source_url"] = feeds[feed_id]["url"]
                direction = dict(target["direction"])
                direction["destination"] = destination
                if context.dry_run:
                    status = "would_create"
                    result["wouldCreate"] += 1
                else:
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile(
                        prefix=".solaris-gtfs-", suffix=".xlsx",
                        dir=output.parent, delete=False,
                    ) as temp_file:
                        candidate = Path(temp_file.name)
                    try:
                        create_workbook(
                            candidate, route, direction, target["day"], snapshot,
                            method="GTFS",
                        )
                        validate_generated_workbook(candidate)
                        if output.exists():
                            status = "preserved"
                            result["preservedExisting"] += 1
                        else:
                            os.replace(candidate, output)
                            status = "created"
                            result["created"] += 1
                    finally:
                        candidate.unlink(missing_ok=True)
                result["targets"].append({
                    "route": route["id"], "day": target["day"],
                    "direction": destination,
                    "file": str(output.relative_to(context.project_root)),
                    "status": status,
                    "feedDate": snapshot.source_date.isoformat(),
                })
            except Exception as exc:
                result["status"] = "degraded"
                result["errors"].append({
                    "route": target["route"]["id"], "day": target["day"],
                    "direction": target["direction"]["file_suffix"],
                    "message": str(exc),
                })
    finally:
        for feed in opened.values():
            feed.close()
    return result
