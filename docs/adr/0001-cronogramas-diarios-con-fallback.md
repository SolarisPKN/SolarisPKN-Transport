# ADR 0001: Cronogramas diarios con XLSX y SQLite como respaldo

- Estado: Aceptada
- Fecha: 2026-08-25

## Contexto

SolarisPKN necesita responder próximos horarios aun cuando una API oficial esté caída o cambie. Los PDF públicos no ofrecen una estructura suficientemente estable y varias fuentes de terceros no contienen estaciones nuevas, como Lozano. Las aplicaciones oficiales sí consultan datos actualizados, pero sus endpoints son interfaces internas sin contrato público de estabilidad.

También existe un formato XLSX manual ya definido y `procesar_horarios.py` lo convierte en un modelo relacional. Debemos conservar esa fuente humana cuando la automatización no tenga evidencia suficiente para reemplazarla.

## Decisión

Se adopta un pipeline diario y conservador:

```text
API oficial -> candidato en memoria -> validación semántica
                                      |
                                      v
                           reemplazo atómico del XLSX
                                      |
                                      v
                         reconstrucción atómica de SQLite
                                      |
                                      v
                    consulta estable desde la aplicación web
```

La configuración declarativa vive en `config/schedule_sources.json`. Cada salida tiene empresa, recorrido, día, sentido, estaciones, vigencia, enlaces y método de actualización.

Un XLSX sólo se reemplaza cuando:

- la fuente responde y corresponde al recorrido configurado;
- hay servicios y formaciones únicas;
- los horarios de cada viaje son cronológicos, incluyendo cruces de medianoche;
- el destino tiene cobertura suficiente, salvo recorridos cortos explícitamente permitidos;
- el archivo candidato vuelve a ser aceptado por el mismo parser que genera la base.

Una falla de red, autenticación, formato o cobertura se trata como `preserved`: el archivo anterior queda byte por byte intacto. Los errores de configuración sí detienen la ejecución para no ocultar un defecto del repositorio.

`procesar_horarios.py --rebuild --strict` crea una base temporal en el mismo volumen, procesa todos los XLSX y exige integridad SQLite, al menos una grilla, al menos un horario y cero archivos rechazados antes de reemplazar `horarios.db`.

## Consecuencias

Ventajas:

- La web dispone de una fuente local aun durante caídas de las APIs.
- XLSX y SQLite son auditables y reproducibles.
- Una respuesta parcial nunca destruye el último cronograma confiable.
- La celda `A24` permite distinguir datos manuales de datos obtenidos por API.
- GitHub Actions evita commits diarios vacíos: la base sólo se reconstruye si cambió un XLSX o se fuerza manualmente.

Costos y límites:

- Los endpoints internos pueden cambiar y requieren mantenimiento del conector.
- `Laboral`, `Sabado` y `Domingo` usan la próxima fecha representativa; no se inventan reglas para feriados.
- El recorrido se identifica históricamente como Merlo–Lobos. Las Heras se registra como cabecera operativa temporal y los servicios cortos se conservan porque reflejan los cortes publicados.
- La posición en vivo no forma parte del snapshot. Debe consultarse por separado y degradar al cronograma local si falla.

## Alternativas descartadas

- Scrapear PDF como fuente primaria: frágil ante diagramación y texto desestructurado.
- Consumir exclusivamente una API de terceros: puede quedar desactualizada y omitir estaciones nuevas.
- Reemplazar parcialmente una planilla: mezcla fechas y puede fabricar viajes inexistentes.
- Consultar siempre en vivo desde el navegador: expone el servicio externo, agrega CORS y deja a la web sin fallback.
