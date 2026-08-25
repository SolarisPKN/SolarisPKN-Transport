# Aviso legal, de atribución y de datos

[🇺🇸 English](LEGAL.md) | 🇦🇷 **Español**

Última revisión: 2026-08-25

Este documento registra la procedencia y los límites pretendidos de SolarisPKN-Transport. Se publica por transparencia y para reducir riesgos; no constituye asesoramiento legal ni reemplaza la revisión de un abogado argentino calificado o una autorización escrita de los proveedores de datos.

## Condición independiente y no oficial

SolarisPKN-Transport es un proyecto independiente y de código abierto orientado a la interoperabilidad. No está afiliado, patrocinado, aprobado ni respaldado por:

- Trenes Argentinos Operaciones o SOFSE;
- Nación Servicios S.A., SUBE o Cuándo SUBO;
- ninguna empresa ferroviaria o de colectivos, agencia de transporte, tienda de aplicaciones o distribuidor de paquetes móviles.

Nombres como “Trenes Argentinos”, “SOFSE”, “SUBE”, “Cuándo SUBO” y los nombres de operadores se usan descriptivamente para identificar fuentes fácticas y recorridos. No se incluyen logotipos, identidad visual ni afirmaciones de oficialidad. Todas las marcas pertenecen a sus respectivos titulares.

## Software y paquetes móviles

La licencia GPL-3.0 del repositorio se aplica únicamente al código fuente original de SolarisPKN-Transport y a contribuciones cuyos autores tengan derechos suficientes. No relicencia software, marcas, servicios ni datos de terceros.

El repositorio actual y su historial Git no distribuyen APK, XAPK, APKS, AAB, código decompilado, recursos gráficos propietarios ni archivos copiados de las aplicaciones. Dos paquetes móviles aportados por el usuario fueron inspeccionados localmente para una investigación puntual de compatibilidad, nunca se incorporaron a Git y se eliminaron después de la auditoría. Sólo permanecen identificadores de versión, hashes criptográficos, hechos observados del protocolo y conectores escritos de manera independiente.

La política del repositorio prohíbe agregar paquetes móviles, almacenes de firma, secretos o resultados de decompilación. Las pruebas automáticas controlan la restricción de binarios móviles.

## Fuentes de datos y atribución

| Fuente | Material utilizado | Atribución y situación |
|---|---|---|
| Trenes Argentinos Operaciones / SOFSE | Hechos públicos de ramales, estaciones y cronogramas | Los términos de sus servicios digitales indican que sus contenidos se licencian bajo CC BY 4.0 salvo indicación contraria. SolarisPKN-Transport recupera, filtra, normaliza y reformatea la información; esas transformaciones son modificaciones. El proyecto no presupone que esa declaración cubra necesariamente todos los elementos de una API no documentada. |
| Cuándo SUBO / Nación Servicios S.A. | Hechos públicos de agencias, recorridos, paradas y cronogramas | La instancia OneBusAway es accesible sin una cuenta personal, pero durante esta revisión no se encontró una licencia específica de datos abiertos para el conjunto de la API. No se afirma propiedad ni licencia abierta sobre ese material. La autorización para redistribuirlo públicamente debería confirmarse con Nación Servicios. |
| Operadores de transporte | Nombres de empresas, ramales, paradas y horas publicadas | Se usan descriptivamente para identificar servicios de transporte. No se afirma respaldo, asociación ni propiedad. |

Cuando corresponda aplicar CC BY 4.0, la atribución es:

> Fuente: Trenes Argentinos Operaciones / Argentina.gob.ar. La información de cronogramas e infraestructura fue recuperada automáticamente y modificada mediante filtrado, normalización, validación y conversión a XLSX/SQLite por SolarisPKN-Transport. Licenciada bajo CC BY 4.0 cuando así lo indica la fuente. No se implica respaldo institucional.

CC BY 4.0 exige crédito adecuado, enlace a la licencia, indicación de cambios y no sugerir respaldo del licenciante. Consultá <https://creativecommons.org/licenses/by/4.0/deed.es>.

Los XLSX y la base SQLite contienen instantáneas fácticas de horarios y metadatos de procedencia. El proyecto no afirma que GPL-3.0 otorgue derechos sobre hechos, bases de proveedores, nombres o marcas de terceros. Cada reutilizador debe determinar si la redistribución, publicación o explotación comercial que pretende realizar está autorizada.

## Acceso a APIs y límites de seguridad

Los conectores apuntan a interfaces observadas en aplicaciones oficiales distribuidas públicamente. Esas interfaces son internas o no documentadas y pueden cambiar o retirarse sin aviso. La accesibilidad técnica no se considera equivalente a una autorización legal.

El proyecto:

- no usa cuentas de pasajeros, identificadores de tarjetas SUBE, historiales de viaje, información de pago ni otros datos personales;
- no almacena contraseñas personales ni tokens duraderos de usuarios;
- no evade muros de pago, controles de cuentas ni accesos a registros privados;
- no realiza escaneo de vulnerabilidades, explotación, pruebas de carga ni evasión de controles de seguridad;
- cachea catálogos, limita consultas por parada, serializa actualizaciones y opera con baja frecuencia para reducir carga;
- se detiene o conserva la última instantánea local cuando un proveedor rechaza el acceso o devuelve datos inseguros.

El conector SOFSE reproduce un flujo de autenticación de compatibilidad observado en un cliente público y obtiene un token temporal del servicio. Como la interfaz requiere autenticación y no está documentada como API pública para desarrolladores, desplegarla sin autorización del proveedor mantiene una incertidumbre legal y contractual. Para un despliegue público de menor riesgo, corresponde obtener permiso escrito o una credencial oficial de SOFSE.

El conector de Cuándo SUBO usa la clave pública del cliente `web` y ninguna credencial personal. Su disponibilidad no establece una licencia de redistribución. Se recomienda obtener una aclaración escrita de Nación Servicios antes de operar un espejo público o un servicio comercial.

## Privacidad

El repositorio está diseñado para procesar cronogramas de transporte público, no personas. La auditoría no encontró registros de pasajeros, ubicaciones precisas de usuarios, números de tarjeta, historiales de transacciones, correos electrónicos, cookies de autenticación ni otros conjuntos de datos personales. Las contribuciones no deben incorporar esa información.

## Solicitudes de retiro y titulares de derechos

Si representás a un titular de derechos y considerás que un archivo o conjunto de datos no debería estar presente:

1. abrí un issue de GitHub identificando el archivo o material exacto y el derecho o término involucrado; o
2. usá el canal privado de reporte de vulnerabilidades de GitHub cuando el aviso contenga credenciales o información sensible de seguridad.

No publiques secretos ni datos personales en un issue público. Los reclamos fundamentados se revisarán con prontitud y el material discutido podrá deshabilitarse o retirarse mientras se evalúa la situación.

## Puntos todavía no resueltos

- El repositorio no conserva una autorización escrita de SOFSE para este conector independiente.
- Durante la revisión del 25 de agosto de 2026 no se encontró una licencia explícita de datos abiertos para el conjunto de la API OneBusAway de Cuándo SUBO.
- Los términos, endpoints y declaraciones de licencia de los proveedores pueden cambiar.

Por eso el repositorio puede quedar transparente y prudente, pero nadie puede garantizar honestamente que sea inmune a reclamos. Antes de un uso de alto tráfico, comercial o como espejo público, se recomienda revisión profesional y permisos escritos de los proveedores.
