# Pipeline modular de cronogramas

La automatización se configura en `config/pipeline.json` y se ejecuta mediante `scripts/run_pipeline.py`. El patrón está inspirado en SolarisPKN-Stats: configuración declarativa, conectores pequeños y fallas independientes. La semántica de transporte sigue siendo conservadora: una fuente nueva sólo reemplaza un XLSX después de pasar validación completa.

## Orden de ejecución

1. SOFSE intenta actualizar los trenes configurados.
2. Cuándo SUBO intenta actualizar los colectivos configurados.
3. Cada error queda limitado a su conector; los otros continúan.
4. GTFS revisa los destinos esperados y actúa únicamente donde el XLSX no existe.
5. Los 55 XLSX válidos se importan atómicamente a `horarios.db`.
6. La misma base se exporta a un único `BD CSV/horarios.csv`.

Si un XLSX ya existe, GTFS no lo abre, no rellena sus celdas vacías y no lo reemplaza. “Completar vacíos” significa cubrir la ausencia total de un libro de recorrido/día/sentido. Mezclar una API actual con un GTFS histórico dentro de la misma grilla produciría horarios con una vigencia falsa.

## Archivos importantes

- `config/pipeline.json`: registro, políticas, feeds, entradas y salidas.
- `config/schedule_sources.json`: recorridos, sentidos, estaciones y objetivos XLSX.
- `connectors/sofse.py`: adaptador ferroviario primario.
- `connectors/cuando_subo.py`: adaptador primario de colectivos.
- `connectors/gtfs.py`: fallback no destructivo.
- `scripts/run_pipeline.py`: orquestación genérica por etapas.
- `scripts/export_csv.py`: vista CSV consolidada.
- `.github/workflows/update-schedules.yml`: agenda y aislamiento transaccional en CI.

## Comandos

```powershell
# Ejecutar una fuente primaria
python scripts/run_pipeline.py --stage connector --connector sofse
python scripts/run_pipeline.py --stage connector --connector cuando_subo

# Comprobar el fallback sin escribir
python scripts/run_pipeline.py --stage fallback --dry-run

# Crear únicamente XLSX ausentes mediante GTFS
python scripts/run_pipeline.py --stage fallback

# Reconstruir las dos salidas derivadas
python scripts/run_pipeline.py --stage outputs

# Pipeline completo: errores remotos no invalidan salidas locales sanas
python scripts/run_pipeline.py --stage all
```

Los reportes JSON opcionales se generan con `--report ruta/reporte.json`. `.pipeline/` y `.cache/gtfs/` están ignorados por Git.

## Agregar un conector

1. Crear `connectors/nueva_fuente.py`.
2. Exportar `CONNECTOR_ID = "nueva_fuente"`.
3. Implementar `run(context, settings)` y devolver un diccionario con `status`.
4. Registrar módulo, rol y opciones en `config/pipeline.json`.
5. Agregar pruebas de caída, preservación atómica y procedencia.

El orquestador lo descubrirá sin agregar condicionales específicos. Si la fuente falla, debe lanzar `ConnectorExecutionError`; esto hace visible el fallo sin detener los demás conectores.

## Cobertura GTFS actual

Los feeds configurados provienen de Buenos Aires Data y están marcados por el propio portal como suspendidos/en revisión. Se admiten porque el fallback fue solicitado aun para datos antiguos, pero la fecha real queda en `Vigencia` y el método queda como `GTFS`.

- Rama ferroviaria 53: Merlo–Lobos.
- Rama ferroviaria 67: respaldo histórico González Catán–20 de Junio; no inventa Lozano.
- Colectivo 136A: Primera Junta–Navarro.
- 322 Luján/Cañuelas: sin mapeo, porque el feed sólo ofrece 322A Morón–Marcos Paz.

Un mapeo faltante aparece como `unmapped`. Esa es una salida segura y deliberada, no un error para ocultar.
