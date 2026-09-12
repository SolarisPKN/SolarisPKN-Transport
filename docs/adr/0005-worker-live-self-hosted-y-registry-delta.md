# ADR 0005: Worker live self-hosted y Registry por deltas

## Estado

Aceptado.

## Decisión

Los cronogramas y el tiempo real son subsistemas independientes. `Horarios/`, SQLite, CSV y sus conectores continúan en el pipeline diario. El Worker live sólo consulta evidencia operativa de proveedores y persiste `current.json` más un delta por ejecución.

Un único cron `*/2 * * * *` alterna usando `scheduledTime`: minutos divisibles por cuatro procesan trenes y minutos cuyo resto es dos procesan colectivos. Cada categoría se consulta cada cuatro minutos; nunca se cargan cronogramas en el Worker.

Cada fork compila `config/live.json`, usa sus propios nombres de Worker/R2 mediante variables de GitHub y despliega su propia instancia. Este repositorio no ofrece una API pública compartida y la instancia de Villars Informa no es infraestructura para terceros.

La ausencia de una unidad o de GPS no equivale a cancelación. `cancelled` requiere evidencia explícita del proveedor.

## Consecuencias

- Menos CPU y requests por ciclo.
- Fallback sólo cuando el proveedor prioritario falla, queda stale o no entrega datos válidos.
- Historial analizable sin duplicar snapshots completos.
- Transporte YA queda deshabilitado hasta contar con API y autorización válidas.
- Cuándo SUBO queda implementado pero deshabilitado por defecto.
