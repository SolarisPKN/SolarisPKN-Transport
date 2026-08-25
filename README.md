# 🚆 SolarisPKN-Transport

> A resilient transport timetable pipeline for Argentine trains and buses: provider timetable data in, auditable XLSX and query-ready SQLite out.

🇺🇸 **English** | [🇦🇷 Español](README.es.md)

> [!IMPORTANT]
> This is an independent, unofficial interoperability project. It is not affiliated with, sponsored by, or endorsed by Trenes Argentinos Operaciones, SOFSE, Nación Servicios, SUBE, or any transport operator. Third-party names are used only to identify factual data sources. Read the [legal, attribution, and data notice](LEGAL.md) before deploying or redistributing generated data.

---

## Overview

SolarisPKN-Transport collects published timetables from the same backends used by the Trenes Argentinos and Cuándo SUBO applications, validates every candidate schedule, preserves it in a human-readable spreadsheet, and builds a normalized SQLite database for reliable web queries.

The project exists because a transport website should not become useless whenever an upstream service is unavailable. The live API remains the best source for a vehicle's current position; the local database is the dependable source for planned services and the fallback when live data cannot be reached.

This is deliberately more than a scraper. It is a conservative data pipeline: incomplete, ambiguous, or inconsistent API responses never overwrite the last trusted timetable.

## Project goals

- Keep train and bus timetables current without manually editing code for every new route.
- Preserve a readable and auditable XLSX copy of each timetable.
- Produce a stable SQLite source that a website can query quickly.
- Use data from the official applications when public PDFs are incomplete or poorly structured.
- Retain the last trustworthy result when an upstream API fails or changes.
- Separate scheduled services from live vehicle tracking so each can degrade independently.

## Key features

- **Spreadsheet-driven configuration.** Select routes from `ramales.xlsx`; no Python or JSON change is required for a route already published by a supported API.
- **Automatic route discovery.** New selections are resolved to provider IDs, directions, stations or stops, and output folders.
- **Official-app backends.** Train data comes from SOFSE services used by Trenes Argentinos; bus data comes from the Cuándo SUBO OneBusAway instance.
- **Safe replacement.** A workbook is replaced only after semantic validation and a successful parse through the same importer used for SQLite.
- **Atomic persistence.** Candidate XLSX and database files are prepared and validated before replacing the trusted copy.
- **Manual-data protection.** A failed or partial update leaves the previous file byte-for-byte intact.
- **Daily automation.** GitHub Actions tests the connectors, refreshes schedules, rebuilds SQLite only when needed, and avoids empty commits.
- **Traceable provenance.** Cell `A24` in every timetable says whether its update method is `API` or `Manual`.
- **Bilingual documentation.** English and Spanish documentation follow the rest of the SolarisPKN ecosystem.

## Current routes

The initial curated profiles cover the routes that motivated the project:

| Mode | Line / branch | Route | Operational note |
|---|---|---|---|
| Train | Belgrano Sur | González Catán ↔ Lozano | Includes Villars and the newer Lozano station; published weekend services are preserved. |
| Train | Sarmiento | Merlo ↔ Lobos | The historical route is still identified as Merlo–Lobos, while the currently published reduced operation terminates at Las Heras during infrastructure works. |
| Bus | 136, branch A | Primera Junta ↔ Navarro | Fast service profile from Cuándo SUBO. |
| Bus | 322 | Marcos Paz ↔ Luján | Curated reference stops include Las Heras, Villars, and Plomer. |
| Bus | 322 | Marcos Paz ↔ Cañuelas | Both published directions are processed. |

The 136 service through Villars/Plomer is not automated as a separate branch because Cuándo SUBO does not currently publish it as an independent route. A manually maintained workbook is kept untouched when the API cannot identify an exact equivalent.

These five profiles are safe overrides in `config/schedule_sources.json`. They define reviewed identifiers and reference stops. Any additional selection is discovered from the catalog in `ramales.xlsx`.

## How it works

```text
ramales.xlsx / Configurador
          |
          v
route and direction discovery -----> SOFSE REST / Cuándo SUBO REST
          |                                      |
          +------------------+-------------------+
                             v
                  candidate timetable in memory
                             |
                semantic + structural validation
                             |
             +---------------+----------------+
             |                                |
          valid                            unsafe
             |                                |
     atomic XLSX replacement          keep trusted XLSX
             |
             v
  procesar_horarios.py --rebuild --strict
             |
      SQLite integrity checks
             |
             v
         horarios.db
             |
             v
    stable timetable queries for the website
```

For each selected route, the updater finds the closest representative date for `Laboral`, `Sabado`, and `Domingo`, builds one workbook per direction and day type, and validates that:

- the response belongs to the requested route and direction;
- at least one unique service was returned;
- trip times remain chronological, including midnight crossings;
- the expected destination has sufficient coverage unless short workings are explicitly allowed;
- the generated workbook can be read by the strict SQLite importer.

Network failures, authentication changes, malformed payloads, insufficient coverage, and ambiguous selections are reported without replacing an existing file.

## `ramales.xlsx`: the route configurator

The root workbook has two sheets:

### `Configurador`

This is the source of truth for what the daily runner processes.

- Column `Tren`: selected train routes.
- Column `Colectivos`: selected bus routes.
- A selection may use the visible name or the technical ID shown in the catalog.
- Blank rows are ignored.
- Unknown or ambiguous values are reported as unresolved and do not modify existing schedules.

### `Lista de ramales`

This is a cached discovery catalog containing the mode, provider, API ID, public name, agency/company, and description available from both backends. The current generated snapshot contains 27 train branches and 1,381 grouped bus services. Opposite bus directions are grouped in one row when possible, for example `135_1623 / 135_1624`.

The catalog is refreshed every seven days by default rather than being rediscovered during every daily run. This keeps the configurator useful while avoiding hundreds of unnecessary provider requests.

### Add a route without changing code

1. Open `ramales.xlsx`.
2. Find the desired route in `Lista de ramales`.
3. Add its name or API ID to the matching column in `Configurador`.
4. Save the workbook.
5. Run the updater locally or wait for the next GitHub Actions execution.

For example, adding `Once - Moreno` resolves SOFSE branch ID `1`, discovers both directions and their published stations, creates `Horarios/Trenes/Once-Moreno/`, and writes the six weekday/weekend workbooks automatically.

## Data sources and API strategy

### Trenes Argentinos / SOFSE

The train connector uses SOFSE REST endpoints discovered from the official Trenes Argentinos Android application. It retrieves management/line catalogs, branches, stations, and published arrivals used to reconstruct full timetables. This source includes recent stations that may be absent from third-party datasets, such as Lozano.

### Cuándo SUBO / OneBusAway

The bus connector uses the REST API exposed by the Cuándo SUBO application. It obtains agencies, route variants, stops, and stop schedules. Curated profiles retain their exact reviewed stops.

The deployed Cuándo SUBO instance does not expose a complete `schedule-for-route` response, so a newly selected bus route keeps both endpoints and at most twelve evenly distributed published stops. This bounds network traffic while retaining useful route coverage.

### GraphQL

Neither verified backend exposes a usable GraphQL API, so the current connectors use REST. SolarisPKN-Transport will use GraphQL for a future provider only when that provider actually offers it and a grouped query materially reduces calls. The project does not wrap REST calls in cosmetic GraphQL or claim an endpoint that does not exist.

## XLSX timetable format

Generated files preserve the existing `Horarios/` convention:

- metadata labels and values live in columns `A:B`;
- stations or stops begin at column `C`;
- each subsequent row represents one train or bus service;
- each cell contains the time at that station/stop;
- `A24` stores the provenance method: `API` or `Manual`.

The same parser validates generated candidates and imports them into SQLite, preventing the producer and consumer from silently drifting apart.

## SQLite model

`procesar_horarios.py` normalizes the workbooks into `horarios.db`. The main entities are:

- `recorridos`: transport mode, company, line/branch, and route identity;
- `estaciones`: reusable station and stop names;
- `dias`: normalized day types;
- `grillas`: one timetable for a route, direction, and day type, including source and update method;
- `grilla_estaciones`: ordered stations/stops for each timetable;
- `grilla_formaciones`: individual published services;
- `horarios`: the time of each service at each station/stop;
- `import_logs`: import traceability and failures.

The strict rebuild uses a temporary database, checks SQLite integrity, requires usable grids and schedules, and only then replaces `horarios.db`.

## Quick start

### Requirements

- Python 3.11 or newer
- Node.js 20 or newer for the SOFSE connector test
- Network access to the provider APIs when refreshing data

### Install and validate

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
node --test scripts/sofse_api.test.mjs
```

### Refresh the catalog

```bash
python scripts/update_route_catalog.py --force
```

Without `--force`, the command keeps the existing catalog until it is older than seven days. Useful options include `--max-age-days`, `--branches`, `--output-json`, and `--verbose`.

### Preview and update schedules

```bash
python scripts/update_schedules.py --dry-run
python scripts/update_schedules.py
```

To test one route or reproduce a run for a fixed date:

```bash
python scripts/update_schedules.py \
  --route tren-catan-lozano \
  --today 2026-08-25 \
  --dry-run \
  --verbose
```

`--route` may be repeated. `--config` and `--branches` select alternative technical profiles and configurator workbooks.

### Rebuild SQLite

```bash
python procesar_horarios.py --rebuild --strict
```

Use `--db` or `--horarios-dir` to validate into temporary locations without touching the repository artifacts.

## Daily automation

`.github/workflows/update-schedules.yml` runs every day at **06:17 America/Argentina/Buenos_Aires** and can also be launched manually.

The workflow:

1. checks out the repository and installs pinned Python dependencies;
2. runs Python tests and the Node.js SOFSE connector test;
3. refreshes `Lista de ramales` only when expired or manually forced;
4. reads `ramales.xlsx` and updates safe timetable candidates;
5. rebuilds SQLite only when a timetable changed, the database is missing, or rebuilding was forced;
6. commits `ramales.xlsx`, `Horarios/`, and `horarios.db` only if their contents changed.

Manual inputs:

- `force_catalog`: bypass the seven-day catalog cache.
- `force_rebuild`: rebuild `horarios.db` even when no XLSX changed.

Concurrency is serialized and the job has a 30-minute timeout, preventing overlapping writers from racing over the same artifacts.

## Repository structure

```text
SolarisPKN-Transport/
├── .github/workflows/update-schedules.yml  # daily safe-update pipeline
├── config/
│   └── schedule_sources.json             # reviewed route overrides
├── docs/
│   ├── adr/                              # architectural decisions
│   └── research/                         # reproducible API research
├── Horarios/
│   ├── Trenes/                           # auditable train XLSX files
│   └── Colectivos/                       # auditable bus XLSX files
├── scripts/
│   ├── update_route_catalog.py           # refreshes Lista de ramales
│   ├── update_schedules.py               # discovers and updates routes
│   └── sofse_api.mjs                     # web-facing SOFSE helper
├── tests/                                 # regression and discovery tests
├── procesar_horarios.py                   # strict XLSX-to-SQLite importer
├── ramales.xlsx                           # human-facing route registry
└── horarios.db                            # stable query database
```

## Reliability guarantees and deliberate limits

- Schedules are published-plan snapshots, not real-time predictions.
- Live train or bus positions should be queried separately through a controlled backend/proxy and fall back to `horarios.db` when unavailable.
- Provider endpoints are internal interfaces used by official applications and may change without notice.
- Holidays and special services are not guessed. If no unambiguous source exists, the last trusted or manual workbook remains in place.
- A partial update is never merged into an existing workbook because mixing publication dates can create services that never existed.
- No private user credentials or personal tokens are stored in the repository.

For the complete rationale and reproducible endpoint research, read:

- [`docs/adr/0001-cronogramas-diarios-con-fallback.md`](docs/adr/0001-cronogramas-diarios-con-fallback.md)
- [`docs/research/trenes-argentinos-api.md`](docs/research/trenes-argentinos-api.md)
- [`docs/research/cuando-subo-api.md`](docs/research/cuando-subo-api.md)

## Technology stack

- **Python 3.11+** for discovery, validation, XLSX generation, and SQLite import
- **openpyxl** for spreadsheet parsing and generation
- **SQLite** for portable, indexed timetable queries
- **Node.js** for the SOFSE web connector and contract tests
- **GitHub Actions** for scheduled execution and artifact publication
- **REST / OneBusAway** for upstream integration

## Design philosophy

SolarisPKN-Transport follows four rules:

1. **Trust must be earned on every update.** A successful HTTP response is not enough.
2. **Human-readable data matters.** XLSX remains a first-class artifact, not a disposable intermediate file.
3. **Configuration belongs outside the core.** Routes are selected in a workbook and reviewed overrides live in JSON.
4. **Efficiency must reflect reality.** Cache expensive catalogs, bound stop requests, and use GraphQL only where a provider truly supports it.

## Roadmap

- Add more train and bus providers through isolated connectors.
- Expose documented read-only queries for upcoming services from `horarios.db`.
- Add publication-date and anomaly dashboards for catalog and schedule drift.
- Model holidays and exceptional services when a reliable source becomes available.
- Integrate live-position queries as a separate, degradable layer for SolarisPKN web projects.
- Expand route-level fixtures and API contract monitoring.

## SolarisPKN ecosystem

- [SolarisPKN-Labs](https://github.com/SolarisPKN/SolarisPKN-Labs) — project hub and experimental laboratory.
- [SolarisPKN-Control](https://github.com/SolarisPKN/SolarisPKN-Control) — monitoring and control platform.
- [SolarisPKN-LiveTools](https://github.com/SolarisPKN/SolarisPKN-LiveTools) — live browser utilities and diagnostics.
- [SolarisPKN-Stats](https://github.com/SolarisPKN/SolarisPKN-Stats) — automated metrics and historical data pipelines.

## Contributing

Contributions are welcome. Before opening a pull request:

1. keep route selection in `ramales.xlsx` and provider-specific logic inside a connector;
2. preserve the XLSX contract and conservative fallback behavior;
3. add regression coverage for new discovery or validation rules;
4. run both test suites;
5. update the ADR or research notes when an upstream contract changes.

Never commit secrets, private API credentials, or user data.

## License

The original SolarisPKN-Transport source code is released under the [GNU General Public License v3.0](LICENSE). That license does not claim ownership of third-party trademarks, mobile applications, provider services, or upstream timetable data. See [Legal, attribution, and data notice](LEGAL.md).

---

**SolarisPKN-Transport** — live when possible, dependable when it matters.
