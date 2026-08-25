# SolarisPKN Transport

Repositorio de cronogramas de transporte para SolarisPKN. Mantiene una copia auditable en XLSX y una base SQLite lista para consultar desde la web, sin depender de que las APIs oficiales estén disponibles en el momento de cada consulta.

## Fuentes actuales

- Trenes Argentinos (SOFSE): cronogramas de González Catán–Lozano y Merlo–Lobos, obtenidos de la misma API que consume la aplicación oficial. El segundo recorrido opera temporalmente sólo entre Merlo y Las Heras con servicios reducidos por las obras.
- Cuándo SUBO: cronogramas del 136 rápido Primera Junta–Navarro y de los ramales 322 Marcos Paz–Luján y Marcos Paz–Cañuelas, reconstruidos desde su API OneBusAway.

El ramal 136 por Villars/Plomer no se automatiza todavía porque Cuándo SUBO no lo publica como recorrido independiente. Si se agrega un XLSX manual, el actualizador no lo borra ni lo inventa.

## Flujo de actualización

Cada día, GitHub Actions ejecuta este circuito:

1. consulta la fecha representativa más próxima para `Laboral`, `Sabado` y `Domingo`;
2. arma y valida un cronograma candidato;
3. reemplaza el XLSX únicamente si la respuesta es completa y coherente;
4. conserva intacto el archivo anterior cuando una API falla o entrega datos insuficientes;
5. si cambió algún XLSX, reconstruye `horarios.db` en un archivo temporal, verifica su integridad y lo reemplaza atómicamente;
6. publica solamente los artefactos que realmente cambiaron.

La celda `A24` de cada hoja indica `API` o `Manual`. Los archivos generados automáticamente conservan la estructura definida en `Horarios/`: metadatos en la columna A, estaciones desde la columna C y una formación por fila.

## Uso local

Requiere Python 3.11 o posterior.

```powershell
python -m pip install -r requirements.txt
python scripts/update_schedules.py --dry-run
python scripts/update_schedules.py
python procesar_horarios.py --rebuild --strict
python -m unittest discover -s tests -v
```

Para limitar una prueba a una fuente configurada:

```powershell
python scripts/update_schedules.py --route tren-catan-lozano --dry-run --verbose
```

Los recorridos, sentidos, estaciones y archivos de salida se declaran en `config/schedule_sources.json`. El parámetro `--today AAAA-MM-DD` permite reproducir una ejecución para una fecha determinada.

## Límites deliberados

- Los horarios son una copia de respaldo del cronograma publicado, no una predicción en tiempo real.
- La posición viva del tren debe consultarse directamente a la API desde un backend o proxy controlado; no se guarda en estos XLSX.
- Las APIs usadas son interfaces internas de aplicaciones oficiales y pueden cambiar sin aviso. Por eso todo reemplazo es conservador y validado.
- Feriados y servicios especiales no se infieren: si no existe una fuente inequívoca, se mantiene el último dato confiable o el XLSX manual.

La arquitectura y la investigación reproducible están documentadas en `docs/adr/0001-cronogramas-diarios-con-fallback.md`, `docs/research/trenes-argentinos-api.md` y `docs/research/cuando-subo-api.md`.
