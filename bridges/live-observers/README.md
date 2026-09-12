# Bridges locales de posiciones y arribos

> **Archivo historico, deshabilitado y no desplegable.** ADR 0005 reemplazo este enfoque por
> conectores API fail-closed dentro de `live/`. Ningun workflow, paquete raiz ni Worker vigente
> ejecuta este directorio.

Este paquete ejecuta un observador deliberadamente separado de los cronogramas versionados:

- **Cuando SUBO** rota paginas HTML publicas de paradas con un minimo obligatorio de una solicitud por minuto. Extrae
  linea, viaje, destino, hora y minutos de arribo. Esos datos son observaciones de ETA, no coordenadas GPS.

**Transporte YA no se automatiza.** El 2 de septiembre de 2026, el flujo publico `Entrar a la App Web` mostro el aviso
literal `Prohibido Scrapping`. Esa prohibicion cierra el enfoque de browser observer. El contrato de ingreso de
Villars puede permanecer preparado para una futura fuente autorizada, pero este repositorio no incluye un colector
operativo de Transporte YA. Se necesita permiso escrito o una API publica documentada por sus responsables.

El proceso habilitado genera un sobre JSON pequeno y sanitizado bajo `.state/output/`. La publicacion hacia Villars esta
apagada en `config.example.json`; por lo tanto, clonar e iniciar el paquete no cambia ningun servicio externo.

## Cobertura de referencia para Villars

| Servicio | IDs conocidos | Fuente utilizable sin inventar datos | Posición que puede publicarse |
| --- | --- | --- | --- |
| González Catán - Lozano | SOFSE línea 67 | posición y estado informados por SOFSE | `reported` cuando llegan coordenadas; cronograma como fallback |
| Merlo - Lobos | SOFSE línea 53 | posición y estado informados por SOFSE | `reported` en el tramo operativo; conservar aparte el cronograma histórico/completo |
| 136 Rápido | `739_670`, `739_671` | ETA pública de parada, rotada y limitada | sólo `estimated`; `reported` requiere una fuente GPS autorizada |
| 136 Villars / Plomer | cronograma local protegido | cronograma versionado | sólo `estimated`; no existe una fuente abierta independiente comprobada |
| 322 Luján | `135_1623`, `135_1624` | ETA pública de parada, rotada y limitada | sólo `estimated`; `reported` requiere una fuente GPS autorizada |
| 322 Cañuelas | `135_1625`, `135_1626` | ETA pública de parada, rotada y limitada | sólo `estimated`; `reported` requiere una fuente GPS autorizada |

La matriz reusable completa está en
`docs/resources/villars-live-transport-reference/route-matrix.example.json`. Los IDs sirven para filtrar una respuesta
obtenida por una vía autorizada; no conceden acceso ni licencia por sí solos.

## Limites no negociables

- No extraer ni copiar credenciales de las aplicaciones de terceros.
- No automatizar, observar frames ni extraer datos de Transporte YA mientras mantenga su aviso de no scraping.
- No llamar a endpoints autenticados de Cuando SUBO desde este paquete.
- No llamar `GPS` a una ETA ni a una interpolacion de cronograma.
- Detener el observador si aparece CAPTCHA, bloqueo, prohibicion expresa de automatizacion o un cambio de contrato.
- No guardar frames o respuestas crudas. Solo queda el ultimo resultado normalizado y con TTL.
- Las lineas permitidas son 136 y 322 y las coordenadas deben caer dentro del rectangulo regional configurado.

## Preparacion

```powershell
cd bridges/live-observers
npm install
Copy-Item config.example.json config.local.json
```

Para una prueba de Cuando SUBO sin publicar:

```powershell
npm run once:cuando-subo
```

Para dejar rotando una parada por minuto:

```powershell
npm run start:cuando-subo
```

## Publicacion hacia Villars

La frontera implementada es `POST /ingest/cuando-subo`; el Worker tambien reserva `POST /ingest/transporteya` sin
colector activo, para no exigir otro cambio de contrato si se obtiene autorizacion. La firma
usa un secreto **propio de SolarisPKN**, timestamp y nonce. El bridge nunca recibe un token de cuenta Cloudflare.

1. Crear `config.local.json`, completar `ingestBaseUrl` con el dominio verificado del Worker y cambiar `publish` a
   `true` solamente cuando el endpoint haya sido desplegado.
2. Definir `SOLARIS_BRIDGE_INGEST_SECRET` en el proceso local y el mismo valor como secreto del Worker.
3. Mantener el secreto fuera del JSON, Git, logs y documentacion.

Un despliegue de Worker, la creacion del secreto y cualquier ruta publica son cambios Cloudflare independientes; este
paquete no los ejecuta.

## Semantica

`cuando-subo-bridge` produce `arrivals`; por sí solo no produce marcadores. Un agregador posterior puede usar esas ETA
para recalibrar una estimación basada en cronogramas, siempre rotulada `estimated` y nunca `reported`. La rotación
de ejemplo incluye puntos del 136 Rápido y de los dos ramales de la 322; cada ejecución consulta una sola parada.

## Validacion

```powershell
npm run validate
```

Las pruebas son offline y usan HTML/JSON sinteticos. No prueban que un proveedor externo siga operativo ni que el
endpoint de Villars este desplegado.
