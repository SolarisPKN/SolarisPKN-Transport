# ADR 0002: Posiciones vivas separadas de cronogramas

> **Superado por [ADR 0005](0005-worker-live-self-hosted-y-registry-delta.md).** Se conserva por trazabilidad histórica; no describe el runtime actual.

- Estado: Aceptada
- Fecha: 2026-08-30
- Responsables: mantenedores de SolarisPKN-Transport

## Contexto

SolarisPKN-Transport conserva cronogramas publicados en XLSX y SQLite. Esos artefactos son
versionables, auditables y adecuados para responder qué servicio está programado, pero no demuestran
dónde está una unidad ahora. Una interpolación entre estaciones tampoco se convierte en GPS por el
solo hecho de poder dibujarla en un mapa.

La implementación comprobada de Villars-Informa demostró que un agregador puede consultar proveedores
independientes, validar sus respuestas, retener temporalmente el último resultado válido de una fuente
fallida y publicar una sola instantánea para el navegador. También reveló límites que no deben convertirse
en contrato general: rutas y estaciones locales, dependencias de un proveedor de nube, coordenadas como
campos planos, los nombres `observed`/`predicted` y el descarte de formaciones activas sin coordenadas.

Una respuesta HTTP 200 sólo acredita que hubo una respuesta HTTP. Un cuerpo vacío con estructura
documentada puede significar que no hay unidades activas; un cuerpo vacío, truncado o con un esquema
inesperado puede significar que el proveedor cambió. Confundir ambos casos borraría el último estado válido.

## Impulsores de la decisión

- No representar un cronograma como telemetría.
- Diferenciar posición informada, posición estimada y actividad sin posición.
- Mantener separados el origen de la posición y su frescura.
- Degradar por proveedor sin ocultar datos sanos de otras fuentes.
- Evitar que el navegador conozca credenciales o contratos internos de proveedores.
- Permitir distintos runtimes y productos de almacenamiento sin atar el contrato a Cloudflare.
- Conservar un fallback útil cuando la capa viva deja de ser confiable.
- Reducir llamadas mediante una instantánea consolidada y revalidación con ETag.

## Decisión

Se adoptan dos capas con ciclos de vida y almacenes independientes:

```text
cronogramas publicados                    posiciones vivas
API/PDF/manual                            proveedores de telemetría/estado
       |                                             |
       v                                             v
XLSX -> validación -> SQLite              colectores aislados en servidor
       |                                             |
       |                                  normalización + contrato v1
       |                                             |
       |                                  snapshot corto y consolidado
       |                                             |
       +---------- fallback UI <--------- cliente web validador
```

Los cronogramas siguen el ADR 0001. No contienen posiciones y no se actualizan con cada sondeo vivo. El
snapshot vivo no contiene grillas horarias: sólo puede referenciar `horarios.db` como fallback
`timetable-only` cuando ya no queda ningún estado vivo utilizable.

El contrato normativo es
[`docs/contracts/live-positions.schema.json`](../contracts/live-positions.schema.json). Usa JSON Schema
Draft 2020-12 y exige:

- identificadores estables y con namespace para cada unidad o servicio;
- estado global `ok`, `degraded` o `unavailable`;
- estado independiente por fuente: `ok`, `degraded`, `unavailable` o `disabled`;
- `positionKind: reported` sólo cuando la coordenada fue informada por el proveedor;
- `positionKind: estimated` para una coordenada inferida, siempre rotulada como estimación;
- `positionKind: none` y `position: null` para una unidad activa sin coordenadas;
- `dataStatus: fresh` o `stale` como dimensión separada del origen de la posición;
- tiempos `generatedAt`, `expiresAt` y `discardAfter` explícitos;
- códigos de error acotados y sanitizados, nunca cuerpos crudos, URLs firmadas ni credenciales.

### Ventanas de frescura

Cada integración define ventanas según la frecuencia real del proveedor. El ejemplo reusable usa dos
minutos para pasar de fresco a vencido y diez minutos para descartar. Son valores iniciales, no promesas
universales.

1. Hasta `expiresAt`, una unidad recibida en la corrida actual puede ser `fresh`.
2. Después de una falla, el último resultado válido puede conservarse hasta el límite configurado, pero
   debe salir como `stale` y el snapshot global como `degraded`.
3. Después de `discardAfter`, el cliente no dibuja ninguna posición de esa instantánea.
4. Si ninguna fuente actual ni retenida es utilizable, el snapshot es `unavailable`, no contiene unidades
   y selecciona `timetable-only`.

Una formación activa sin coordenadas no es un error ni una posición estimada. Puede aparecer en una lista
de servicios activos, pero no genera un marcador.

### Fallos parciales y HTTP 200 inválido

Los colectores se ejecutan de forma independiente. Si una fuente falla y otra responde correctamente, el
snapshot es `degraded`; los datos sanos se publican y el último resultado todavía utilizable de la fuente
fallida se conserva como `stale`.

Cada adaptador debe validar primero la estructura propia del proveedor y después producir vehículos
canónicos. Un HTTP 200 semánticamente inválido se registra con
`errorCode: semantic-invalid-response`, se trata como fuente no disponible y nunca reemplaza el último
resultado válido. Una lista vacía sólo es aceptable después de validar inequívocamente el envoltorio y el
significado de la respuesta.

### Publicación y consumo

El agregador publica un único objeto validado bajo una clave estable en un almacenamiento de objetos o
servicio HTTP equivalente. La escritura debe ser atómica desde el punto de vista del lector. El producto
concreto, el dominio y la política de CORS pertenecen al despliegue, no al contrato.

El navegador consulta únicamente ese objeto, revalida con ETag, pausa el sondeo cuando la pestaña está
oculta y valida el candidato antes de sustituir la última instantánea aceptada. Los estilos y textos deben
distinguir informado, estimado, vencido y sin posición. Ante indisponibilidad o vencimiento definitivo,
la interfaz conserva el mapa base y consulta el cronograma local sin fabricar ubicación ni tiempo real.

La telemetría de alta frecuencia no se versiona en Git ni se incorpora a `horarios.db`. GitHub Actions
puede probar el contrato y los ejemplos, pero no es el runtime de sondeo vivo.

## Opciones consideradas

### A. Guardar posiciones en XLSX, SQLite y Git

Descartada. Mezcla hechos con frecuencias y retenciones distintas, genera historial de telemetría de poco
valor, convierte el repositorio en una cola de eventos y puede hacer pasar una posición antigua por actual.

### B. Consultar cada proveedor directamente desde el navegador

Descartada. Expone credenciales o detalles internos, multiplica llamadas por visitante, depende del CORS
de terceros y obliga a cada cliente a resolver fallos parciales y cambios de esquema.

### C. Publicar un snapshot por proveedor

No elegida como interfaz web principal. Aísla bien las fuentes, pero traslada al navegador la unión, la
frescura y la degradación. Puede usarse internamente siempre que el objeto público consolidado siga siendo
la frontera canónica.

### D. Agregador servidor + snapshot canónico consolidado

Elegida. Centraliza secretos y validación, reduce llamadas, permite conservar una fuente fallida sin borrar
las sanas y deja al cliente con un único contrato pequeño.

## Tradeoffs

- El snapshot simplifica al cliente, pero agrega un servicio operativo que debe observarse y mantenerse.
- Retener el último dato evita parpadeos, pero exige rotularlo como vencido y limitar estrictamente su vida.
- Un esquema cerrado detecta cambios accidentales, pero requiere versionar el contrato para agregar campos.
- La estimación mejora el contexto visual, pero sólo es aceptable si el algoritmo, la base temporal y la
  etiqueta de estimación son explícitos.
- La disponibilidad parcial conserva utilidad, pero obliga a mostrar estado por fuente y no un único
  indicador engañoso de “todo bien”.

## Consecuencias

### Positivas

- Cronogramas y telemetría pueden fallar, evolucionar y almacenarse de manera independiente.
- Ninguna ausencia de GPS obliga a ocultar una formación activa.
- Un cambio silencioso de proveedor no vacía automáticamente el mapa.
- Las integraciones web pueden compartir un contrato, fixtures y pruebas offline.
- El fallback mantiene una respuesta útil sin afirmar que un horario es una posición.

### Negativas y límites

- JSON Schema no puede expresar por sí solo todas las relaciones temporales, unicidad y conteos; se exige
  validación semántica adicional.
- Los identificadores de proveedor pueden ser inestables y cada adaptador debe diseñar una identidad
  namespaced reproducible.
- Un estado `active` depende de la semántica del proveedor; no implica movimiento ni puntualidad.
- `estimated` no garantiza precisión. El contrato no autoriza a interpolar cuando faltan tiempos o una
  geometría verificada.
- Los endpoints internos y sus condiciones legales pueden cambiar sin aviso.

## Acciones de implementación

- Aplicar [ADR 0005](0005-worker-live-self-hosted-y-registry-delta.md) y la
  [guia self-hosted vigente](../guides/self-hosted-live-worker.md).
- Validar el contrato v2 y sus reglas semanticas antes de reemplazar un snapshot.
- Mantener los conectores deshabilitados sin requests hasta configurar una fuente valida.
- Versionar `schemaVersion` y redactar una migracion antes de cualquier cambio incompatible.
- Definir para cada proveedor autorizacion, limites, atribucion, timeouts, backoff y retencion.
- Conservar los ejemplos v1 solo como archivo historico; no importarlos ni desplegarlos.

## Referencias

- [ADR 0001: cronogramas diarios con XLSX y SQLite](0001-cronogramas-diarios-con-fallback.md)
- [ADR 0005: Worker live self-hosted y Registry por deltas](0005-worker-live-self-hosted-y-registry-delta.md)
- [Guia vigente del Worker self-hosted](../guides/self-hosted-live-worker.md)
- [Ejemplos v1 archivados](../../examples/live-positions/README.md)
- [Snapshot historico de Villars-Informa](../resources/villars-live-transport-reference/README.md)
