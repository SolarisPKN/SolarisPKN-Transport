# ADR 0004: Pipeline modular con conectores aislados y fallback GTFS

- Estado: Aceptada
- Fecha: 2026-09-08

## Contexto

El actualizador combinaba decisiones de GitHub Actions con la implementación de SOFSE y Cuándo SUBO. Aunque cada XLSX se reemplazaba atómicamente, el workflow conocía cada proveedor por nombre y exigía que al menos uno respondiera. Eso dificultaba sumar fuentes y podía impedir la regeneración de SQLite aun cuando existían 55 libros locales válidos.

SolarisPKN-Stats ya resuelve un problema equivalente mediante un registro declarativo, conectores cargados como módulos y fallas contenidas por fuente. Transport necesita esa propiedad sin copiar su dominio: aquí el dato primario es un cronograma, el respaldo durable es XLSX y no se permite mezclar silenciosamente fechas o procedencias.

Los GTFS oficiales de Buenos Aires Data tienen licencia CC-BY-2.5-AR, pero el portal informa que los datasets API/GTFS están suspendidos y en revisión. Además, su cobertura es histórica: el ferroviario publica la rama 67 sólo hasta 20 de Junio y el de colectivos no contiene los ramales locales 322 Luján/Cañuelas. Por eso GTFS no puede competir con los conectores vivos ni asociarse por parecido.

## Decisión

Se adopta el siguiente pipeline:

```text
config/pipeline.json
        |
        v
registro dinámico de connectors/
        |
        +--> SOFSE ---------+
        +--> Cuándo SUBO ---+  fallas independientes
                            |
                            v
                   XLSX existente o nuevo
                            |
             sólo si el XLSX no existe
                            v
                   GTFS explícitamente mapeado
                            |
                            v
             horarios.db + BD CSV/horarios.csv
```

`config/pipeline.json` define módulos, roles, política, entradas, salidas, feeds y mapeos. Un módulo exporta `CONNECTOR_ID` y `run(context, settings)`. El orquestador no contiene lógica específica de proveedores.

Las fuentes primarias se ejecutan primero. Una caída de catálogo se registra como degradación pero no impide consultar rutas ya configuradas. Una caída del conector abre su circuito, preserva sus XLSX y no detiene las demás fuentes.

GTFS cumple reglas más estrictas:

- sólo se evalúa para un objetivo XLSX que no existe;
- nunca rellena celdas dentro de un libro existente ni lo reemplaza;
- requiere un mapeo inequívoco por `route_id` o nombre corto, sentido y cabecera;
- puede usar un feed vencido únicamente como último recurso y conserva su fecha real;
- registra `Metodo = GTFS` y enlaces al dataset empleado;
- una ruta ausente o ambigua queda `unmapped`; no se sustituye por un ramal parecido.

El GTFS ferroviario queda mapeado para las ramas 53 y 67. En la 67, la cabecera de respaldo es honestamente `20 de Junio`, no Lozano. El GTFS de colectivos queda mapeado sólo para 136A. No se configura fallback para 322 Luján/Cañuelas porque el feed inspeccionado sólo contiene 322A Morón–Marcos Paz.

`procesar_horarios.py` reconstruye SQLite de forma atómica y acepta `GTFS` como procedencia explícita. `scripts/export_csv.py` exporta después una fila por celda horaria a un único archivo UTF-8: `BD CSV/horarios.csv`.

## Consecuencias

Ventajas:

- agregar o deshabilitar conectores ya no exige reescribir el workflow;
- SOFSE, Cuándo SUBO y GTFS tienen estados y reportes separados;
- una caída total de Internet no invalida los XLSX, SQLite y CSV existentes;
- GTFS completa ausencia total sin degradar información actualizada;
- SQLite y CSV se derivan siempre del mismo conjunto validado de XLSX;
- el archivo de `stop_times` se escanea una vez por ruta durante cada ejecución.

Costos y límites:

- los feeds GTFS actuales son históricos y no garantizan vigencia operativa;
- las rutas sin correspondencia exacta deben esperar una fuente legítima o carga manual;
- no se fusionan horarios parciales entre API y GTFS dentro de un mismo XLSX, porque eso fabricaría una vigencia inexistente;
- `horarios.csv` es una vista desnormalizada y puede ser grande, pero simplifica reutilización sin SQLite.

## Alternativas descartadas

- Mantener proveedores cableados en YAML: repite lógica y vuelve frágil cada incorporación.
- Fallar todo el workflow ante un conector caído: descarta fuentes y respaldos sanos.
- Sobrescribir planillas con GTFS vencido: rebaja datos actuales sin advertencia.
- Usar el 322A como reemplazo de 322 Luján/Cañuelas: son recorridos distintos.
- Completar huecos celda por celda con otra fecha: mezcla cronogramas incompatibles y pierde trazabilidad.
