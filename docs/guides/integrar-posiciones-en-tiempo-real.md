# Integrar posiciones en tiempo real

> **Guia historica del contrato v1.** Se conserva como contexto, pero no describe el Worker vigente.
> Para implementar o desplegar una instancia use
> [`self-hosted-live-worker.md`](self-hosted-live-worker.md) y el schema v2.

Esta guía explica cómo incorporar una capa viva a un sitio que ya consulta cronogramas de
SolarisPKN-Transport. Es reusable, independiente del proveedor y del producto de nube, y no despliega ni
modifica infraestructura.

> **Regla principal:** un cronograma responde qué debería pasar; una posición viva responde qué informó o
> qué pudo estimar una fuente ahora. Si sólo existe el cronograma, mostrale horarios al usuario, no un
> marcador inventado.

## Inicio rápido offline

Requisitos: Node.js 20 o posterior. Desde la raíz del repositorio:

```bash
node --test tests/live-positions-contract.test.mjs
```

Después inspeccioná:

- el [JSON Schema canónico](../contracts/live-positions.schema.json);
- los [fixtures sanitizados](../../tests/fixtures/live-positions/);
- el [agregador mínimo](../../examples/live-positions/aggregator.mjs);
- el [cliente web mínimo](../../examples/live-positions/client.mjs).

Las pruebas son completamente offline: no consultan proveedores, no acceden a cuentas, no escriben en un
almacenamiento remoto y no necesitan secretos.

## Arquitectura de referencia

```text
                         servidor / runtime controlado
 proveedor A ---> colector A --+
                               |
 proveedor B ---> colector B --+--> normalizador --> validador --> consolidador
                                                                  |
                                                      escritura atómica / ETag
                                                                  |
                                                                  v
                                                current.json de vida corta
                                                                  |
                         navegador                                v
 horarios.db ----------> vista de cronograma <--------- cliente validador
                                                      /     |       \
                                              marcadores   lista   estado
```

Cada colector conoce un proveedor. El consolidador sólo conoce el contrato canónico. El navegador no
llama a los proveedores y no recibe secretos.

## 1. Definí la semántica antes del endpoint

Documentá por fuente:

| Pregunta | Decisión requerida |
|---|---|
| ¿Qué identifica de forma estable una unidad o servicio? | Construir `id` con namespace; no usar el índice de un array. |
| ¿La coordenada viene del proveedor? | Usar `reported` sólo con evidencia directa. |
| ¿La coordenada se interpola? | Usar `estimated`, registrar el algoritmo fuera del payload y no prometer precisión. |
| ¿Puede haber servicio activo sin coordenadas? | Conservarlo con `positionKind: none`; no crear marcador. |
| ¿Qué significa una lista vacía válida? | Definir el envoltorio y los campos que demuestran “cero unidades”. |
| ¿Cuándo vence el dato? | Fijar ventana fresca y retención según frecuencia y latencia reales. |
| ¿Qué autorización y atribución aplican? | Verificar términos actuales y permiso antes de operar públicamente. |

No deduzcas “activo” sólo porque un viaje existe en el cronograma. El adaptador necesita una señal viva del
proveedor o debe usar `status: unknown`.

## 2. Implementá un colector aislado

El colector vive del lado servidor y devuelve:

```js
{
  status: 'ok', // o 'degraded' cuando la respuesta válida es parcial
  vehicles: [/* unidades ya normalizadas al contrato */],
}
```

El flujo recomendado es:

1. aplicar timeout y cancelación;
2. ejecutar la autenticación autorizada sin registrar credenciales;
3. comprobar el estado HTTP;
4. validar el envoltorio específico del proveedor;
5. decidir si una lista vacía es semánticamente válida;
6. filtrar recorridos permitidos;
7. normalizar identificadores, tiempos y coordenadas;
8. validar cada vehículo canónico;
9. devolver el resultado o un código de error sanitizado.

El helper `acceptProviderResponse` del ejemplo convierte un HTTP 200 con cuerpo inesperado en
`semantic-invalid-response`. No conserva el cuerpo crudo porque podría incluir datos sensibles o detalles
internos.

### Identidad estable

Preferí una composición reproducible:

```text
<modo>:<proveedor>:<id-de-unidad-o-servicio>
```

Si el proveedor no ofrece un ID de vehículo, puede usarse una combinación documentada de servicio,
sentido y fecha operativa. No uses coordenadas, hora de recepción ni posición en el array: cambian en cada
corrida y producirían marcadores duplicados.

### Normalización de posiciones

| Caso de origen | `positionKind` | `position` | `observedAt` | Representación web |
|---|---|---|---|---|
| GPS/coordenada informada | `reported` | lat/lon válidas | obligatorio | marcador “informado” |
| Interpolación verificable | `estimated` | lat/lon calculadas | puede ser `null` | marcador “estimado” |
| Formación activa sin coordenada | `none` | `null` | puede ser `null` | lista, sin marcador |

No conviertas una estación, la cabecera del recorrido ni el centro del mapa en posición de una unidad.
Tampoco interpoles sobre una línea recta si no existe geometría o secuencia de estaciones verificada.

## 3. Consolidá sin acoplar proveedores

Inyectá los colectores al agregador. El ejemplo ejecuta las fuentes en paralelo y aplica estas reglas:

- resultado actual válido: reemplaza sólo esa fuente;
- resultado actual válido pero parcial: fuente `degraded`;
- timeout, error HTTP o HTTP 200 semánticamente inválido: fuente `unavailable`;
- fallo con último resultado todavía retenible: conservar unidades como `stale`;
- fallo después del límite de retención: eliminar esas unidades;
- al menos una fuente sana o retenida: snapshot `degraded` si existe algún problema;
- ninguna fuente utilizable: snapshot `unavailable`, array de vehículos vacío y fallback
  `timetable-only`.

Una fuente deshabilitada se publica como `disabled`, con `lastAttemptAt` y `errorCode` nulos. Deshabilitar
una integración intencionalmente no debe aparecer como una falsa caída.

## 4. Validá dos veces

Usá un validador JSON Schema Draft 2020-12 en la frontera de publicación. Además aplicá reglas semánticas,
porque JSON Schema no cubre de forma cómoda:

- unicidad de IDs de fuentes y vehículos;
- correspondencia entre `provider` y `source.id`;
- existencia de la fuente referenciada;
- conteo `vehicleCount` por fuente;
- orden `generatedAt < expiresAt < discardAfter`;
- coherencia entre estado global, fuentes, vehículos y fallback;
- `observedAt <= receivedAt`;
- políticas de frescura propias del proveedor.

`examples/live-positions/contract.mjs` implementa estas comprobaciones críticas sin dependencias. Para una
aplicación de producción, mantené además un validador estándar del schema como primera barrera.

## 5. Publicá un solo objeto de vida corta

El destino puede ser un almacenamiento de objetos, un CDN con origen propio, un servicio web o una base
con una ruta de sólo lectura. La interfaz pública debe ofrecer una clave estable, por ejemplo
`live-positions/current.json`, y reemplazo atómico.

Configuración recomendada:

- `Content-Type: application/json; charset=utf-8`;
- ETag o equivalente para revalidación;
- caché mucho más corta que `discardAfter`;
- CORS limitado a los orígenes web que realmente consumen el objeto;
- HTTPS;
- sin listado público de buckets ni permisos de escritura desde el navegador.

No publiques respuestas crudas, tokens, headers de autorización, URLs firmadas, nombres de cuenta,
identificadores de usuario ni variables de entorno. Los ejemplos no contienen nombres reales de bucket,
dominio o proveedor y no deben desplegarse sin una revisión propia.

## 6. Consumí defensivamente en el navegador

El cliente mínimo hace lo siguiente:

1. consulta una sola URL;
2. envía `If-None-Match` cuando existe ETag;
3. valida el candidato antes de reemplazar la última copia;
4. conserva la última copia válida si recibe un HTTP 200 semánticamente inválido;
5. pausa el polling con la pestaña oculta;
6. agrega jitter para evitar sincronizar todos los clientes;
7. deja de mostrar posiciones después de `discardAfter`;
8. separa unidades con marcador de formaciones activas sin coordenadas.

Mostrá estados accesibles con texto además de color:

| Estado | Texto mínimo | Posiciones |
|---|---|---|
| Fresco | “Posiciones actualizadas” | informadas y estimadas con estilos distintos |
| Vencido retenido | “Datos demorados” | visibles con etiqueta `stale` |
| Parcial | “Seguimiento parcial” | sólo fuentes válidas o retenidas |
| Activo sin coordenadas | “Activo, posición no informada” | sin marcador |
| No disponible | “Mostrando sólo cronogramas” | ninguna |

El mapa base, los recorridos estáticos y el cronograma pueden seguir visibles cuando falla el dato vivo,
pero la interfaz no debe insinuar que están actualizados en tiempo real.

## 7. Conectá el fallback local

`fallback.mode: timetable-only` no contiene un cronograma. Indica al consumidor que cambie a su fuente
local estable, como `horarios.db` o un JSON derivado de ella.

El fallback puede responder:

- próximos horarios programados;
- tabla completa por sentido y tipo de día;
- fecha de vigencia y método de actualización.

No puede responder:

- dónde está la unidad;
- cuántos minutos reales faltan;
- si el servicio está demorado o cancelado, salvo que otra fuente viva lo informe.

## 8. Operación responsable

Por proveedor, fijá:

- frecuencia mínima necesaria y límites documentados;
- timeout más corto que el intervalo de sondeo;
- backoff exponencial ante errores repetidos;
- jitter;
- concurrencia acotada;
- métricas de latencia, validez semántica, cantidad de unidades y antigüedad;
- alerta por cambio brusco de IDs o cero unidades fuera del patrón histórico;
- política de borrado de snapshots y logs.

No uses GitHub Actions para telemetría minuto a minuto ni comitees snapshots vivos. Sí puede ejecutar las
pruebas offline del contrato en cada cambio.

## 9. Seguridad, privacidad y legal

- Guardá credenciales únicamente en el gestor de secretos del runtime servidor.
- Nunca mandes claves al navegador ni las incluyas en fixtures, errores o logs.
- No proceses cuentas de pasajeros, tarjetas, viajes personales ni ubicación de usuarios.
- Limitá el dato a vehículos de transporte público y a la retención operativa mínima.
- La accesibilidad técnica de una API no equivale a permiso de uso o redistribución.
- Verificá términos, atribución, licencia de datos y autorización antes de una operación pública,
  comercial o de alto tráfico.
- Identificá posiciones estimadas como modificaciones/inferencias propias; no las atribuyas al proveedor.
- Conservá un mecanismo de retiro y contacto para titulares de derechos.

Consultá [`LEGAL.md`](../../LEGAL.md) y [`LEGAL.es.md`](../../LEGAL.es.md). Esta guía es técnica, no
asesoramiento legal.

## 10. Checklist antes de producción

- [ ] El adaptador no contiene secretos, endpoints privados copiados ni datos de identidad.
- [ ] Existe autorización suficiente y atribución documentada.
- [ ] Cero unidades válido y HTTP 200 inválido tienen pruebas separadas.
- [ ] `reported`, `estimated` y `none` se ven y se anuncian de forma distinta.
- [ ] `fresh` y `stale` se calculan independientemente de `positionKind`.
- [ ] Una fuente fallida no borra fuentes sanas.
- [ ] Las posiciones vencidas desaparecen después de `discardAfter`.
- [ ] El fallback consulta cronogramas sin fabricar telemetría.
- [ ] El cliente valida antes de reemplazar la última copia.
- [ ] ETag, pausa por visibilidad, jitter, timeout y backoff están activos.
- [ ] CORS y escritura están restringidos al mínimo necesario.
- [ ] Las pruebas offline pasan sin red.
- [ ] Existe rollback a la última versión compatible del agregador y el cliente.

## Referencias del repositorio

- [ADR 0002](../adr/0002-posiciones-vivas-separadas-de-cronogramas.md)
- [Contrato canónico](../contracts/live-positions.schema.json)
- [Ejemplos mínimos](../../examples/live-positions/README.md)
- [Fixtures](../../tests/fixtures/live-positions/)
- [Referencia comprobada de Villars-Informa](../resources/villars-live-transport-reference/README.md)

La referencia de Villars es evidencia de un caso operativo, no una plantilla para copiar IDs, rutas,
dominios, credenciales, configuración de almacenamiento ni reglas de CORS.
