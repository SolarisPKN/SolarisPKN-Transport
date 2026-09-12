# Worker live self-hosted

## Dos capas que no se mezclan

El pipeline existente (`Horarios/`, `horarios.db`, `BD CSV/horarios.csv`) describe el servicio programado. El
Worker de `live/` conserva únicamente datos efectivamente realtime: GPS, timestamps, estado, demora, próxima
parada, alertas y llegadas/salidas cuando el proveedor las entrega. No recorre planillas, no interpola
vehículos y no convierte ausencia de GPS en cancelación.

Un frontend debe combinar ambas capas. Primero calcula el servicio previsto con su cronograma y shape; luego
aplica demoras y usa GPS como corrección. Sin realtime, el servicio programado debe seguir visible.

## Configuración

Copiá o editá `config/live.json`:

- `providers[].enabled` controla si un conector puede ejecutarse.
- `lines[].mode` acepta `train` o `bus`.
- `lines[].connectors` ordena proveedores con `priority` e incluye sus IDs externos.
- `quality.positionToleranceMeters` evita repetir ruido GPS menor al umbral.
- `deployment.allowedOrigins` limita CORS a los frontends de tu propia instancia.

El compilador elimina los proveedores deshabilitados del plan ejecutable. Si el principal produce datos
válidos y frescos, los fallbacks no reciben requests.

## Instalación

Requisitos: Node 22, una cuenta Cloudflare y un bucket R2 propio creado antes del primer deploy. El workflow
no crea ni reutiliza recursos de SolarisPKN: los nombres se resuelven desde las variables del fork o, si no
se definieron, desde su propio `config/live.json`.

```bash
npm ci
npm test
npm run live:build
npm run live:check
```

Configurá en GitHub:

| Tipo | Nombre | Uso |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Token limitado a editar este Worker y bucket. |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cuenta dueña de la instancia. |
| Secret | `R2_ACCESS_KEY_ID` | Lectura/borrado del prefijo histórico para archivado. |
| Secret | `R2_SECRET_ACCESS_KEY` | Par de la credencial R2. |
| Variable | `LIVE_WORKER_NAME` | Nombre exclusivo del Worker del fork. |
| Variable | `LIVE_R2_BUCKET_NAME` | Bucket exclusivo del fork. |
| Variable | `LIVE_CONFIG_PATH` | Opcional; por defecto `config/live.json`. |

Una credencial opcional de proveedor se instala como secret del Worker y sólo se necesita si se habilita su
conector. Nunca se incluye en JSON, bundle, GitHub Variables o JavaScript del navegador.

`.github/workflows/deploy-live.yml` se ejecuta una vez al día y también por `workflow_dispatch`. Primero prueba,
prepara el Registry del día anterior, lo commitea y confirma el push, recién entonces borra esos deltas de R2;
por último compila, configura CORS/binding/cron y despliega la instancia del fork.

El build deshabilita `workers.dev` y las preview URLs. Para un frontend estático, publicá exclusivamente
`current.json` mediante un dominio propio del bucket R2 (o una ruta propia controlada), mantené CORS limitado a
los orígenes declarados y aplicá rate limiting/WAF en esa zona si lo necesitás. No documentes esa URL como API
compartida ni intentes protegerla con un secreto JavaScript: todo valor enviado al navegador es público.

## Contrato actual

`current.json` contiene `schemaVersion: 2`, `updatedAt` y dos grupos independientes: `trains` y `buses`. Cada
grupo guarda `checkedAt`, `sourceTimestamp`, estado, vehículos, alertas y diagnóstico sanitizado de intentos.
Actualizar trenes conserva colectivos y viceversa.

En cada vehículo:

- `checkedAt`: cuándo consultó nuestro Worker;
- `sourceTimestamp`: cuándo produjo el dato el proveedor;
- `changedAt`: cuándo cambió posición, estado, demora, progreso, alerta o movimiento;
- `confirmedAt`: última observación que confirmó el mismo estado.

El esquema admite campos opcionales: identidad, coordenadas, bearing/velocidad, progreso, horas
programadas/estimadas/reales, demora, estado, alertas y calidad. No guarda ocupación, capacidad, patente,
colores ni decoración de agencia.

## Historial y analítica

Cada ejecución escribe exactamente un delta en `history/YYYY-MM-DD/HHmm-train.json` o `...-bus.json`. Una
confirmación sin movimiento omite coordenadas y referencia el último cambio. Cambios de estado, demora,
parada, alerta, velocidad o bearing sí generan delta aunque latitud/longitud sean iguales.

El Registry comprimido conserva NDJSON cronológico en `History/YYYY/MM/`. Sirve para análisis de puntualidad,
demora, velocidades por tramo, detenciones, cancelaciones explícitas y confiabilidad de cronogramas.

## Añadir un conector

1. Creá `live/src/connectors/nombre.js` y exportá `collect({ provider, line, context, checkedAt, env })`.
2. Devolvé `{ vehicles, alerts, sourceTimestamp }` usando `normalizeVehicle` y `normalizeAlert`.
3. Registralo en `live/src/connectors/index.js`.
4. Añadilo deshabilitado a la configuración y escribí tests del normalizador, errores, stale y fallback.
5. Habilitalo sólo con documentación/licencia/autorización y credenciales válidas.

Transporte YA permanece como stub porque su API comercial no fue autorizada y su scraping está prohibido.
Cuándo SUBO está implementado para instalaciones que cuenten con acceso válido, pero el ejemplo no lo ejecuta.

## Integración frontend mínima

```js
const live = await fetch(LIVE_URL, { headers: { Accept: 'application/json' } }).then((r) => r.json());
const trains = live.schemaVersion === 2 ? live.trains.vehicles : [];
```

`LIVE_URL` pertenece a tu propia instancia. No embebas secretos: un sitio estático no puede ocultarlos. Aplicá
CORS por origen, cache corto y límites de Cloudflare, y no presentes el endpoint como API pública compartida.
