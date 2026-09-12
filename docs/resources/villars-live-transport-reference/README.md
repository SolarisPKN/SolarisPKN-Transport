# Referencia de integración de transporte vivo de Villars

> **Snapshot historico e inerte.** No es codigo fuente vigente, no participa del build y no debe
> desplegarse. La implementacion canonica self-hosted esta en `live/`; Villars-Informa conserva
> solamente el frontend consumidor y una copia de recuperacion del Worker anterior.

Este directorio es un paquete de trabajo para documentar en `SolarisPKN-Transport` una integración reutilizable de posiciones de trenes y colectivos. Fue copiado desde `Villars-Informa` como referencia verificable; **no es una segunda implementación canónica ni debe desplegarse desde esta ubicación**.

## Objetivo

Usar el caso real de Villars para producir documentación, un contrato JSON versionado, fixtures sanitizados y ejemplos genéricos que expliquen cómo separar:

- cronogramas confiables y versionados;
- formaciones o unidades activas;
- coordenadas informadas por el proveedor;
- posiciones estimadas;
- datos vencidos o no disponibles.

El codigo operativo anterior vivia en `Villars-Informa`; desde ADR 0005 la implementacion live
canonica vive en `SolarisPKN-Transport/live`. Este directorio conserva solamente la procedencia
del prototipo reemplazado.

## Procedencia de los archivos

| Archivo en este paquete | Origen en `Villars-Informa` | Función |
| --- | --- | --- |
| `worker/src/index.js` | `workers/transport-live/src/index.js` | Agregador de SOFSE, bridges autorizados y estimaciones por cronograma, con validación y escritura en R2. |
| `worker/src/bridge-ingest.js` | `workers/transport-live/src/bridge-ingest.js` | Ingesta firmada y acotada de observadores externos; rechaza rutas fuera de la allowlist. |
| `worker/wrangler.jsonc` | `workers/transport-live/wrangler.jsonc` | Configuración concreta del Worker de Villars; solo referencia. |
| `worker/r2-cors.json` | `workers/transport-live/r2-cors.json` | Política CORS concreta del bucket de Villars; solo referencia. |
| `web/transport-map.js` | `src/scripts/transport-map.js` | Cliente de mapa, PMTiles, filtros, ETag, frescura y polling. |
| `web/transport.js` | `src/scripts/transport.js` | Interacción de grillas y selector de servicios. |
| `web/transport-services.js` | `src/utils/transport-services.js` | Cálculos de destinos, sentidos, próximas formaciones y grillas. |
| `web/transport-route-model.js` | `src/utils/transport-route-model.js` | Modelo común de familias, sentidos y claves de recorrido. |
| `web/transport-map-live.js` | `src/utils/transport-map-live.js` | Normalización, deduplicación y filtrado de posiciones para el mapa. |
| `web/transport-operational-status.js` | `src/utils/transport-operational-status.js` | Estados programado, confirmado, en curso, demorado y cancelado. |
| `web/transport-map.json` | `src/data/transport-map.json` | Trazas y paradas estáticas usadas por el mapa de Villars. |
| `web/transport-136-villars.example.json` | `src/data/transport-136-villars.json` | Patrón de la T local con ramales E, F, G, H e I y estimaciones separadas de GPS. |
| `web/transporte.astro` | `src/pages/transporte.astro` | Aplicación completa en una página Astro estática. |
| `tests/transport-live.test.mjs` | `tests/transport-live.test.mjs` | Contratos del Worker, fuentes parciales, R2 y tren activo sin GPS. |
| `tests/transport-data.test.mjs` | `tests/transport-data.test.mjs` | Contratos de horarios, grillas, mapa y comportamiento móvil. |
| `tests/bridge-ingest.test.mjs` | `tests/bridge-ingest.test.mjs` | Firma, sanitización y allowlist de la ingesta del bridge. |
| `tests/transport-map-live.test.mjs` | `tests/transport-map-live.test.mjs` | Familias de mapa separadas y posiciones normalizadas. |
| `tests/transport-operational-status.test.mjs` | `tests/transport-operational-status.test.mjs` | Semántica visual de estados operativos y fallback programado. |
| `route-matrix.example.json` | síntesis sanitizada del caso Villars | Plantilla de servicios, IDs, límites de simultaneidad y política de evidencia. |

Las copias fueron verificadas contra sus fuentes mediante SHA-256 al crear este paquete.

## Elementos omitidos deliberadamente

- `public/maps/villars-region.pmtiles`, porque es un binario regional pesado y no forma parte del contrato.
- `src/data/transport-schedules.json`, porque es un snapshot generado desde este mismo repositorio.
- `node_modules`, `.astro`, `.codex-tmp`, bundles de Wrangler y otros artefactos generados.
- secretos de Cloudflare, claves de API, tokens temporales y valores cifrados con DPAPI.
- datos de identidad o material usado para Trusted Access.

## Dependencias del ejemplo web

- `leaflet`
- `pmtiles`
- `protomaps-leaflet`

El Worker de referencia usa Wrangler y un binding R2 llamado `TRANSPORT_LIVE`. Los nombres de Worker, bucket, dominio, cron y origen CORS son específicos de Villars y deben reemplazarse en cualquier ejemplo genérico.

## Cómo reutilizar esta plantilla

1. Copiar `route-matrix.example.json` fuera de este directorio y reemplazar los identificadores de ejemplo por los
   verificados para el proyecto consumidor.
2. Mantener un adaptador por fuente y normalizar todo al contrato
   `docs/contracts/live-positions.schema.json`.
3. Tratar `reported`, `estimated` y `none` como evidencias distintas. Una ETA de parada nunca se convierte en GPS.
4. Conservar cronogramas, geometría estática y snapshot vivo en capas independientes.
5. Ejecutar las pruebas offline antes de conectar una fuente real y repetir la revisión legal cuando cambien sus términos.

La matriz de Villars cubre Catán-Lozano, Merlo-Lobos, 136 Rápido, 136 Villars/Plomer/Las Heras —ramales E, F, G, H e I—
y los ramales Luján y Cañuelas de la 322. Es una plantilla de integración y nomenclatura, no una autorización para
consultar proveedores. Los horarios marcados `Estimado` conservan salidas y duraciones publicadas, pero sus pasos
intermedios son reconstruidos y nunca se promueven a posición `reported`.

## Límite de seguridad y publicación

`worker/src/index.js` contiene un flujo de compatibilidad observado en un cliente público de SOFSE y referencia el secreto de entorno `CUANDO_SUBO_API_KEY`. No contiene el valor de esa clave, pero **no debe copiarse a una guía pública sin una revisión legal, de seguridad y de términos de uso**.

La verificación de identidad de OpenAI no concede autorización de SOFSE, Nación Servicios, SUBE o Cuándo SUBO. La guía final debe mantener las advertencias y límites documentados en `LEGAL.md`.

No ejecutar desde este directorio:

- `wrangler deploy`;
- creación o modificación de buckets;
- escritura de secretos;
- cambios DNS o CORS;
- llamadas masivas a proveedores.

## Resultado esperado del trabajo posterior

1. Un ADR que mantenga las posiciones vivas separadas de los cronogramas.
2. Una guía de implementación neutral respecto del proveedor y del frontend.
3. Un JSON Schema versionado para el snapshot consolidado.
4. Fixtures sin secretos para posición informada, estimada, no disponible y vencida.
5. Un ejemplo mínimo de Worker y cliente web, sanitizado y sin nombres de infraestructura real.
6. Pruebas del contrato que puedan ejecutarse sin red ni credenciales.
7. Enlaces desde `README.md`, `README.es.md` y `LEGAL.md` cuando corresponda.

El prompt preparado para continuar está en `HANDOFF-PROMPT.md`.
