# Investigación de la API usada por Trenes Argentinos

## Artefacto analizado

- Archivo local: `research/apk/trenes-argentinos/Trenes+Argentinos_7.70.1_APKPure.apk`
- Versión visible: `7.70.1`
- SHA-256: `EF33FAFC21EBC074CB2EED49EB18B97229517CEFFA8559EED9D9767E59F6FD7C`

El APK no se versiona. El hash identifica el binario exacto analizado.

## Resultado

La aplicación oficial consulta directamente la API de SOFSE:

```text
https://api-servicios.sofse.gob.ar/v1
```

El flujo útil para los cronogramas es:

```text
POST /auth/authorize
GET  /arribos/estacion/{id}?ramal={id}&sentido={id}&cantidad={n}&fecha={AAAA-MM-DD}
```

El catálogo autodescubrible usa además `GET /infraestructura/gerencias`, `GET /infraestructura/ramales?idGerencia={id}` y `GET /infraestructura/estaciones?idRamal={id}`. La aplicación y la API comprobadas no exponen GraphQL; estos listados REST se cachean en la hoja `Lista de ramales` de `ramales.xlsx`.

El primer endpoint recibe la credencial diaria que genera el cliente oficial y devuelve un token temporal. El conector reproduce ese cálculo con la zona horaria de Argentina y no almacena cuentas, contraseñas ni tokens permanentes.

La respuesta de `arribos` contiene el servicio y sus paradas. Se filtra por fecha operativa y se unen consultas desde más de una estación de origen cuando un solo origen no descubre todos los servicios del día. Esto fue necesario para representar correctamente los recorridos cortos y los cortes actuales del ramal Merlo–Lobos, cuya cabecera operativa temporal es Las Heras.

## Estaciones relevantes confirmadas

- Lozano: identificador `6000`.
- González Catán: identificador `154`.
- Merlo: identificador `269`.
- Las Heras: identificador `225`.

El detalle completo de ramales, sentidos y estaciones intermedias está en `config/schedule_sources.json`. La configuración admite recorridos cortos explícitos para no descartar servicios reales que terminan antes de la cabecera durante obras.

## Tratamiento de horarios nocturnos

SOFSE puede publicar un viaje que sale antes de medianoche y llega después. Internamente, el pipeline conserva esas llegadas como minutos del día siguiente; en XLSX se muestran como `24:xx` cuando Excel no puede representarlas sin perder la fecha de servicio. El importador acepta hasta `47:59` y las guarda cronológicamente en SQLite.

## Riesgos operativos

- La interfaz pertenece al servicio oficial, pero no está documentada como API pública estable.
- El mecanismo de autorización, los identificadores o el cuerpo de respuesta podrían cambiar.
- Una autenticación fallida, un JSON incompleto o una cobertura insuficiente nunca reemplazan el último XLSX válido.
- La posición en vivo es una consulta distinta; no se mezcla con el snapshot diario de horarios.
