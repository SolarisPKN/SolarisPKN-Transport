# Investigación de la API usada por Cuándo SUBO

## Artefacto analizado

- Artefacto temporal aportado por el usuario para investigación local de compatibilidad; no se evaluó su canal de obtención y no se distribuye con el proyecto.
- Paquete Android: `org.nssa_sube.android`
- Versión: `1.3.30` (`versionCode` 173)
- SHA-256: `A2E3B48C472923ED1661E04B362CE8F844944D628DD0C900DEB4CBCA62D592B9`

El XAPK nunca fue agregado a Git y fue eliminado del workspace después del análisis. El historial público tampoco contiene el paquete, archivos decompilados, recursos gráficos ni código fuente de la aplicación. El hash se conserva únicamente como registro reproducible del artefacto observado.

La investigación se limitó a interoperabilidad con datos públicos de recorridos y horarios. No incluyó cuentas de usuarios, tarjetas, viajes personales, movimientos, datos personales, explotación de vulnerabilidades ni copia de código o recursos de la aplicación. Los conectores de este repositorio son implementaciones propias basadas en comportamiento observable.

## Resultado

La aplicación es un cliente basado en OneBusAway y apunta directamente a:

```text
https://cuandosubo.sube.gob.ar/onebusaway-api-webapp/api/where
```

El cliente móvil usa la clave pública `web`. No se guarda un token personal ni un secreto de usuario.

Endpoints comprobados:

```text
agencies-with-coverage.json
routes-for-agency/{agency}.json
stops-for-route/{route}.json
schedule-for-stop/{stop}.json?date=AAAA-MM-DD&key=web
```

El backend no expone GraphQL. Aunque OneBusAway documenta el método REST `schedule-for-route`, esta instancia responde `404`; `trips-for-route?includeSchedule=true` sí existe, pero sólo devuelve viajes activos alrededor del instante consultado y no reemplaza al cronograma diario.

OneBusAway no ofrece en esta instancia un cronograma completo por recorrido. El conector consulta `schedule-for-stop` para cada parada configurada, filtra el `routeId` exacto y une las respuestas por `tripId`. De esa unión sale la matriz formación × parada. Para recorridos autodescubiertos se limitan las consultas a las cabeceras y hasta doce paradas uniformemente distribuidas; los perfiles revisados manualmente conservan sus puntos exactos.

El catálogo de `routes-for-agency` se agrupa por servicio y se cachea durante siete días en `ramales.xlsx`, hoja `Lista de ramales`. Así, el barrido de agencies no se repite en la ejecución diaria normal.

## Identificadores confirmados

| Servicio | Empresa/agency | Ida | Vuelta |
| --- | --- | --- | --- |
| 136 rápido Primera Junta–Navarro | `739` | `739_670` | `739_671` |
| 322 Marcos Paz–Luján | `135` | `135_1623` | `135_1624` |
| 322 Marcos Paz–Cañuelas | `135` | `135_1625` | `135_1626` |

Las paradas exactas y su orden están centralizados en `config/schedule_sources.json` para poder corregirlos sin modificar el código.

## Hallazgo sobre Villars/Plomer

El ramal 136 que pasa por Villars/Plomer no aparece como recorrido independiente en la respuesta actual de Cuándo SUBO. No hay evidencia suficiente para construir ese cronograma automáticamente sin mezclar servicios. La política implementada es deliberadamente conservadora: mantener cualquier planilla manual existente y no crear una salida ficticia.

## Riesgos operativos

- Es una API usada por una aplicación oficial, pero no un contrato público documentado.
- Que un endpoint sea técnicamente accesible no constituye por sí solo una autorización de uso. Quien despliegue el conector debe verificar que cuenta con autorización suficiente y respetar los términos vigentes del proveedor.
- La clave `web`, los identificadores y el formato podrían cambiar.
- Cada candidato se valida antes de reemplazar un XLSX; una respuesta vacía o incompleta conserva la última versión confiable.
- Los paquetes APK/XAPK están prohibidos por la política del repositorio y no se conservan localmente ni en Git.
- El proyecto es independiente y no está respaldado ni afiliado a Nación Servicios o SUBE.
