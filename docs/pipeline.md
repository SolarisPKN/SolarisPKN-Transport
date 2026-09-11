# Modular timetable pipeline

The automation is configured in `config/pipeline.json` and runs through `scripts/run_pipeline.py`. The pattern is adapted from SolarisPKN-Stats: declarative configuration, small connectors, and failure isolation. Transport keeps a stricter data rule: a new source replaces an XLSX workbook only after full validation.

## Execution order

1. SOFSE attempts to refresh configured train timetables.
2. Cuándo SUBO attempts to refresh configured bus timetables.
3. Each failure remains contained in its connector; other connectors keep running.
4. `curated_public` applies versioned public references where no open connector exists, while preserving an API grid with an equal or newer validity date.
5. GTFS checks expected targets and runs only when an XLSX workbook is absent.
5. All valid XLSX workbooks are atomically imported into `horarios.db`.
6. The same database is exported into one `BD CSV/horarios.csv` file.

If an XLSX already exists, GTFS does not open it, fill its empty cells, or replace it. “Fill missing data” means covering the total absence of a route/day/direction workbook. Combining a current API response with a historical GTFS feed inside one grid would create a false publication date.

## Important files

- `config/pipeline.json`: connector registry, policies, feeds, inputs, and outputs.
- `config/curated_public_schedules.json`: transcribed matrices with source URL, verification date, and calendar profiles; it performs no runtime scraping.
- `config/schedule_sources.json`: routes, directions, stations, and expected XLSX targets.
- `connectors/sofse.py`: primary train adapter.
- `connectors/cuando_subo.py`: primary bus adapter.
- `connectors/gtfs.py`: non-destructive fallback.
- `scripts/run_pipeline.py`: provider-neutral staged orchestration.
- `scripts/export_csv.py`: consolidated CSV view.
- `.github/workflows/update-schedules.yml`: schedule and CI transaction boundaries.

## Commands

```powershell
# Run one primary source
python scripts/run_pipeline.py --stage connector --connector sofse
python scripts/run_pipeline.py --stage connector --connector cuando_subo
python scripts/run_pipeline.py --stage connector --connector curated_public

# Inspect fallback decisions without writing
python scripts/run_pipeline.py --stage fallback --dry-run

# Create only missing XLSX workbooks through GTFS
python scripts/run_pipeline.py --stage fallback

# Rebuild both derived outputs
python scripts/run_pipeline.py --stage outputs

# Full pipeline: remote failures do not invalidate healthy local outputs
python scripts/run_pipeline.py --stage all
```

Optional JSON reports use `--report path/report.json`. `.pipeline/` and `.cache/gtfs/` are ignored by Git.

Workbooks support five canonical calendars: `Lunes a Viernes`, `Sábado`, `Domingo`, `Feriados`, and `No Laboral`. A holiday/non-working-day grid is created only from specific evidence; the Sunday schedule is never copied automatically.

## Adding a connector

1. Create `connectors/new_source.py`.
2. Export `CONNECTOR_ID = "new_source"`.
3. Implement `run(context, settings)` and return a dictionary containing `status`.
4. Register the module, role, and options in `config/pipeline.json`.
5. Add tests for source failure, atomic preservation, and provenance.

The orchestrator discovers the module without provider-specific conditionals. A failed source should raise `ConnectorExecutionError`; that makes the failure visible while allowing every other connector to continue.

## Current GTFS coverage

The configured feeds come from Buenos Aires Data. The portal currently marks API/GTFS datasets as suspended and under review. They are accepted because an outdated last-resort fallback was explicitly required, but every generated workbook preserves the real feed date and uses `GTFS` as its method.

- Train branch 53: Merlo–Lobos.
- Train branch 67: historical González Catán–20 de Junio fallback; it does not invent Lozano.
- Bus 136A: Primera Junta–Navarro.
- 322 Luján/Cañuelas: intentionally unmapped because the inspected feed only contains 322A Morón–Marcos Paz.

A missing mapping is reported as `unmapped`. This is a deliberate safe result, not an error to conceal.
