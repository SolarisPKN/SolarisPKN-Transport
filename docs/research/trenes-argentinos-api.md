# Investigación de la API usada por Trenes Argentinos

## Artefacto analizado

- Artefacto temporal aportado por el usuario para investigación local de compatibilidad; no se evaluó su canal de obtención y no se distribuye con el proyecto.
- Versión visible: `7.70.1`
- SHA-256: `EF33FAFC21EBC074CB2EED49EB18B97229517CEFFA8559EED9D9767E59F6FD7C`

El APK nunca fue agregado a Git y fue eliminado del workspace después del análisis. El historial público tampoco contiene el paquete, archivos decompilados, recursos gráficos ni código fuente de la aplicación. El hash se conserva únicamente como registro reproducible del artefacto observado.

La investigación se limitó a interoperabilidad con datos públicos de horarios. No incluyó cuentas de usuarios, datos personales, transacciones, explotación de vulnerabilidades ni copia de código o recursos de la aplicación. Los conectores de este repositorio son implementaciones propias basadas en comportamiento observable.

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
- Que un endpoint sea técnicamente accesible no constituye por sí solo una autorización de uso. Quien despliegue el conector debe verificar que cuenta con autorización suficiente y respetar los términos vigentes del proveedor.
- El mecanismo de autorización, los identificadores o el cuerpo de respuesta podrían cambiar.
- Una autenticación fallida, un JSON incompleto o una cobertura insuficiente nunca reemplazan el último XLSX válido.
- La posición en vivo es una consulta distinta; no se mezcla con el snapshot diario de horarios.
- El proyecto es independiente y no está respaldado ni afiliado a SOFSE o Trenes Argentinos Operaciones.
