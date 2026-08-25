# 🚆 SolarisPKN-Transport

> Un pipeline resistente de cronogramas para trenes y colectivos argentinos: entran datos publicados por proveedores y salen XLSX auditables y una base SQLite lista para consultar.

[🇺🇸 English](README.md) | 🇦🇷 **Español**

> [!IMPORTANT]
> Este es un proyecto independiente y no oficial de interoperabilidad. No está afiliado, patrocinado ni respaldado por Trenes Argentinos Operaciones, SOFSE, Nación Servicios, SUBE ni ningún operador de transporte. Los nombres de terceros se usan únicamente para identificar fuentes fácticas. Leé el [aviso legal, de atribución y de datos](LEGAL.es.md) antes de desplegar o redistribuir los datos generados.

---

## Descripción general

SolarisPKN-Transport recopila cronogramas publicados desde los mismos backends que consumen las aplicaciones de Trenes Argentinos y Cuándo SUBO, valida cada horario candidato, lo conserva en una hoja de cálculo legible y construye una base SQLite normalizada para consultas web confiables.

El proyecto existe porque una web de transporte no debería quedar inútil cada vez que un servicio externo se cae. La API en vivo sigue siendo la mejor fuente para conocer la posición actual de una unidad; la base local es la fuente estable para los servicios programados y el respaldo cuando no se puede acceder al dato vivo.

Esto es deliberadamente más que un scraper. Es un pipeline conservador de datos: una respuesta incompleta, ambigua o incoherente nunca pisa el último cronograma confiable.

## Objetivos del proyecto

- Mantener actualizados los horarios de trenes y colectivos sin editar código por cada ramal nuevo.
- Conservar una copia XLSX legible y auditable de cada cronograma.
- Producir una fuente SQLite estable para consultas web rápidas.
- Usar datos de las aplicaciones oficiales cuando los PDF públicos son incompletos o están mal estructurados.
- Retener el último resultado confiable cuando una API externa falla o cambia.
- Separar los cronogramas programados del seguimiento en vivo para que cada capa pueda degradar de manera independiente.

## Características principales

- **Configuración desde una planilla.** Los recorridos se eligen en `ramales.xlsx`; no hace falta cambiar Python ni JSON si el ramal ya está publicado por una API compatible.
- **Descubrimiento automático.** Una selección nueva se resuelve a IDs del proveedor, sentidos, estaciones o paradas y carpetas de salida.
- **Backends de aplicaciones oficiales.** Los trenes provienen de los servicios SOFSE usados por Trenes Argentinos y los colectivos de la instancia OneBusAway de Cuándo SUBO.
- **Reemplazo seguro.** Una planilla sólo se reemplaza después de validarla semánticamente y procesarla con el mismo importador que genera SQLite.
- **Persistencia atómica.** Los XLSX y la base candidatos se preparan y validan antes de reemplazar la copia confiable.
- **Protección del dato manual.** Una actualización fallida o parcial deja el archivo anterior byte por byte intacto.
- **Automatización diaria.** GitHub Actions prueba los conectores, refresca cronogramas, reconstruye SQLite sólo cuando corresponde y evita commits vacíos.
- **Procedencia visible.** La celda `A24` de cada cronograma indica si el método de actualización fue `API` o `Manual`.
- **Documentación bilingüe.** La documentación en inglés y español conserva el estilo del ecosistema SolarisPKN.

## Recorridos actuales

Los perfiles iniciales revisados cubren los ramales que dieron origen al proyecto:

| Medio | Línea / ramal | Recorrido | Nota operativa |
|---|---|---|---|
| Tren | Belgrano Sur | González Catán ↔ Lozano | Incluye Villars y la nueva estación Lozano; se conservan los servicios publicados para fines de semana. |
| Tren | Sarmiento | Merlo ↔ Lobos | El recorrido histórico sigue identificado como Merlo–Lobos, aunque la operación reducida publicada actualmente termina en Las Heras por las obras de infraestructura. |
| Colectivo | 136, ramal A | Primera Junta ↔ Navarro | Perfil de servicio rápido obtenido de Cuándo SUBO. |
| Colectivo | 322 | Marcos Paz ↔ Luján | Las paradas de referencia revisadas incluyen Las Heras, Villars y Plomer. |
| Colectivo | 322 | Marcos Paz ↔ Cañuelas | Se procesan ambos sentidos publicados. |

El servicio 136 por Villars/Plomer todavía no se automatiza como un ramal separado porque Cuándo SUBO no lo publica actualmente como recorrido independiente. Si existe una planilla mantenida a mano, queda intacta cuando la API no permite identificar un equivalente exacto.

Estos cinco perfiles funcionan como overrides seguros en `config/schedule_sources.json`: fijan identificadores revisados y paradas de referencia. Cualquier selección adicional se descubre desde el catálogo incluido en `ramales.xlsx`.

## Cómo funciona

```text
ramales.xlsx / Configurador
          |
          v
descubrimiento de ramal y sentidos -> REST SOFSE / REST Cuándo SUBO
          |                                      |
          +------------------+-------------------+
                             v
                   cronograma candidato en memoria
                             |
                validación semántica y estructural
                             |
             +---------------+----------------+
             |                                |
           válido                         inseguro
             |                                |
      reemplazo atómico del XLSX      conservar XLSX confiable
             |
             v
  procesar_horarios.py --rebuild --strict
             |
     verificación de integridad SQLite
             |
             v
         horarios.db
             |
             v
 consultas estables de cronogramas desde la web
```

Para cada recorrido seleccionado, el actualizador busca la fecha representativa más cercana para `Laboral`, `Sabado` y `Domingo`, crea una planilla por sentido y tipo de día, y valida que:

- la respuesta corresponda al ramal y sentido solicitados;
- exista al menos un servicio único;
- las horas de cada viaje mantengan el orden cronológico, incluidos los cruces de medianoche;
- el destino esperado tenga cobertura suficiente, salvo que se permitan explícitamente servicios cortos;
- el XLSX generado pueda ser leído por el importador estricto de SQLite.

Los fallos de red, cambios de autenticación, payloads malformados, cobertura insuficiente y selecciones ambiguas se informan sin reemplazar un archivo existente.

## `ramales.xlsx`: el configurador de recorridos

La planilla de la raíz tiene dos hojas:

### `Configurador`

Es la fuente de verdad de lo que procesa el runner diario.

- Columna `Tren`: ramales ferroviarios seleccionados.
- Columna `Colectivos`: recorridos de colectivos seleccionados.
- Se puede escribir el nombre visible o el ID técnico mostrado en el catálogo.
- Las filas vacías se ignoran.
- Los valores desconocidos o ambiguos se reportan como no resueltos y no modifican cronogramas existentes.

### `Lista de ramales`

Es un catálogo de descubrimiento cacheado con el medio, proveedor, ID de API, nombre público, empresa/agencia y descripción disponibles en ambos backends. La instantánea generada actualmente contiene 27 ramales ferroviarios y 1.381 servicios de colectivos agrupados. Cuando es posible, los sentidos opuestos de un colectivo aparecen en una sola fila; por ejemplo, `135_1623 / 135_1624`.

El catálogo se refresca cada siete días de manera predeterminada, en lugar de redescubrirlo durante cada ejecución diaria. Así el configurador se mantiene útil sin disparar cientos de consultas innecesarias a los proveedores.

### Agregar un ramal sin tocar código

1. Abrí `ramales.xlsx`.
2. Buscá el recorrido en `Lista de ramales`.
3. Agregá su nombre o ID de API en la columna correspondiente de `Configurador`.
4. Guardá la planilla.
5. Ejecutá el actualizador localmente o esperá la próxima corrida de GitHub Actions.

Por ejemplo, al agregar `Once - Moreno`, el sistema resuelve el ramal SOFSE con ID `1`, descubre ambos sentidos y sus estaciones publicadas, crea `Horarios/Trenes/Once-Moreno/` y genera automáticamente las seis planillas de días laborales y fin de semana.

## Fuentes de datos y estrategia de APIs

### Trenes Argentinos / SOFSE

El conector ferroviario usa endpoints REST de SOFSE descubiertos desde la aplicación Android oficial de Trenes Argentinos. Obtiene catálogos de gerencias/líneas, ramales, estaciones y arribos publicados con los que reconstruye los cronogramas completos. Esta fuente contiene estaciones recientes que pueden faltar en conjuntos de terceros, como Lozano.

### Cuándo SUBO / OneBusAway

El conector de colectivos usa la API REST expuesta por la aplicación Cuándo SUBO. Obtiene agencias, variantes de recorridos, paradas y horarios por parada. Los perfiles revisados conservan sus paradas exactas.

La instancia desplegada por Cuándo SUBO no expone una respuesta completa de `schedule-for-route`; por eso, para un colectivo nuevo se conservan ambas cabeceras y como máximo doce paradas publicadas distribuidas uniformemente. Esto limita el tráfico de red sin perder una cobertura útil del recorrido.

### GraphQL

Ninguno de los backends comprobados expone una API GraphQL utilizable, de modo que los conectores actuales usan REST. SolarisPKN-Transport usará GraphQL en un proveedor futuro solamente si el proveedor realmente lo ofrece y una consulta agrupada reduce de forma material las llamadas. El proyecto no disfraza REST como GraphQL ni inventa un endpoint inexistente.

## Formato de los cronogramas XLSX

Los archivos generados preservan la convención existente en `Horarios/`:

- las etiquetas y valores de metadatos viven en las columnas `A:B`;
- las estaciones o paradas comienzan en la columna `C`;
- cada fila siguiente representa una formación o servicio;
- cada celda contiene su hora en esa estación o parada;
- `A24` guarda el método de procedencia: `API` o `Manual`.

El mismo parser valida los candidatos generados y los importa en SQLite. Esto evita que el productor y el consumidor del formato se descoordinen silenciosamente.

## Modelo SQLite

`procesar_horarios.py` normaliza las planillas dentro de `horarios.db`. Sus entidades principales son:

- `recorridos`: medio, empresa, línea/ramal e identidad del recorrido;
- `estaciones`: nombres reutilizables de estaciones y paradas;
- `dias`: tipos de día normalizados;
- `grillas`: cronograma de un recorrido, sentido y tipo de día, incluida su fuente y método de actualización;
- `grilla_estaciones`: estaciones/paradas ordenadas de cada grilla;
- `grilla_formaciones`: servicios publicados individuales;
- `horarios`: hora de cada servicio en cada estación/parada;
- `import_logs`: trazabilidad y errores de importación.

La reconstrucción estricta usa una base temporal, verifica la integridad SQLite, exige grillas y horarios utilizables y recién entonces reemplaza `horarios.db`.

## Inicio rápido

### Requisitos

- Python 3.11 o posterior
- Node.js 20 o posterior para probar el conector SOFSE
- Acceso de red a las APIs de los proveedores al refrescar datos

### Instalar y validar

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
node --test scripts/sofse_api.test.mjs
```

### Refrescar el catálogo

```bash
python scripts/update_route_catalog.py --force
```

Sin `--force`, el comando conserva el catálogo existente hasta que supera los siete días. También admite `--max-age-days`, `--branches`, `--output-json` y `--verbose`.

### Previsualizar y actualizar cronogramas

```bash
python scripts/update_schedules.py --dry-run
python scripts/update_schedules.py
```

Para probar un solo recorrido o reproducir una corrida con fecha fija:

```bash
python scripts/update_schedules.py \
  --route tren-catan-lozano \
  --today 2026-08-25 \
  --dry-run \
  --verbose
```

`--route` puede repetirse. `--config` y `--branches` permiten elegir perfiles técnicos y planillas de configuración alternativas.

### Reconstruir SQLite

```bash
python procesar_horarios.py --rebuild --strict
```

Usá `--db` o `--horarios-dir` para validar en ubicaciones temporales sin tocar los artefactos del repositorio.

## Automatización diaria

`.github/workflows/update-schedules.yml` se ejecuta todos los días a las **06:17 de America/Argentina/Buenos_Aires** y también se puede lanzar manualmente.

El workflow:

1. clona el repositorio e instala las dependencias Python fijadas;
2. ejecuta las pruebas de Python y la prueba del conector SOFSE en Node.js;
3. refresca `Lista de ramales` sólo si venció o se fuerza manualmente;
4. lee `ramales.xlsx` y actualiza candidatos de cronograma seguros;
5. reconstruye SQLite sólo si cambió una planilla, falta la base o se forzó la reconstrucción;
6. commitea `ramales.xlsx`, `Horarios/` y `horarios.db` únicamente si cambió su contenido.

Entradas manuales:

- `force_catalog`: ignora la caché de siete días del catálogo.
- `force_rebuild`: reconstruye `horarios.db` aunque ningún XLSX haya cambiado.

La concurrencia está serializada y el job tiene un timeout de 30 minutos, evitando que dos escritores compitan sobre los mismos artefactos.

## Estructura del repositorio

```text
SolarisPKN-Transport/
├── .github/workflows/update-schedules.yml  # pipeline diario seguro
├── config/
│   └── schedule_sources.json             # overrides de ramales revisados
├── docs/
│   ├── adr/                              # decisiones de arquitectura
│   └── research/                         # investigación reproducible de APIs
├── Horarios/
│   ├── Trenes/                           # XLSX ferroviarios auditables
│   └── Colectivos/                       # XLSX de colectivos auditables
├── scripts/
│   ├── update_route_catalog.py           # refresca Lista de ramales
│   ├── update_schedules.py               # descubre y actualiza recorridos
│   └── sofse_api.mjs                     # helper SOFSE para la web
├── tests/                                 # regresiones y pruebas de descubrimiento
├── procesar_horarios.py                   # importador estricto XLSX a SQLite
├── ramales.xlsx                           # registro de recorridos para personas
└── horarios.db                            # base estable de consulta
```

## Garantías de confiabilidad y límites deliberados

- Los horarios son instantáneas del cronograma publicado, no predicciones en tiempo real.
- La posición viva de trenes o colectivos debe consultarse por separado mediante un backend/proxy controlado y degradar a `horarios.db` cuando no esté disponible.
- Los endpoints usados son interfaces internas de aplicaciones oficiales y pueden cambiar sin aviso.
- No se inventan feriados ni servicios especiales. Si no existe una fuente inequívoca, se conserva la última planilla confiable o manual.
- Una actualización parcial nunca se mezcla con una planilla existente, porque combinar fechas de publicación puede crear servicios que jamás existieron.
- El repositorio no almacena credenciales privadas de usuarios ni tokens personales.

Para conocer la justificación completa y la investigación reproducible de endpoints, consultá:

- [`docs/adr/0001-cronogramas-diarios-con-fallback.md`](docs/adr/0001-cronogramas-diarios-con-fallback.md)
- [`docs/research/trenes-argentinos-api.md`](docs/research/trenes-argentinos-api.md)
- [`docs/research/cuando-subo-api.md`](docs/research/cuando-subo-api.md)

## Tecnologías

- **Python 3.11+** para descubrimiento, validación, generación XLSX e importación SQLite
- **openpyxl** para leer y generar hojas de cálculo
- **SQLite** para consultas portables e indexadas de cronogramas
- **Node.js** para el conector web de SOFSE y sus pruebas de contrato
- **GitHub Actions** para ejecución programada y publicación de artefactos
- **REST / OneBusAway** para integraciones externas

## Filosofía de diseño

SolarisPKN-Transport sigue cuatro reglas:

1. **La confianza se gana en cada actualización.** Una respuesta HTTP exitosa no alcanza.
2. **El dato legible por personas importa.** XLSX es un artefacto de primera clase, no un intermediario descartable.
3. **La configuración vive fuera del núcleo.** Los recorridos se eligen en una planilla y los overrides revisados viven en JSON.
4. **La eficiencia debe reflejar la realidad.** Se cachean catálogos costosos, se limitan consultas por parada y sólo se usa GraphQL cuando un proveedor verdaderamente lo admite.

## Hoja de ruta

- Incorporar más proveedores ferroviarios y de colectivos mediante conectores aislados.
- Exponer consultas de sólo lectura documentadas para los próximos servicios de `horarios.db`.
- Agregar tableros de fecha de publicación y anomalías del catálogo y los horarios.
- Modelar feriados y servicios excepcionales cuando exista una fuente confiable.
- Integrar posiciones en vivo como una capa separada y degradable para los proyectos web SolarisPKN.
- Ampliar los fixtures por ramal y el monitoreo de contratos de API.

## Ecosistema SolarisPKN

- [SolarisPKN-Labs](https://github.com/SolarisPKN/SolarisPKN-Labs) — hub de proyectos y laboratorio experimental.
- [SolarisPKN-Control](https://github.com/SolarisPKN/SolarisPKN-Control) — plataforma de monitoreo y control.
- [SolarisPKN-LiveTools](https://github.com/SolarisPKN/SolarisPKN-LiveTools) — utilidades y diagnósticos en vivo para el navegador.
- [SolarisPKN-Stats](https://github.com/SolarisPKN/SolarisPKN-Stats) — pipelines automatizados de métricas e historial.

## Contribuciones

Las contribuciones son bienvenidas. Antes de abrir un pull request:

1. mantené la selección de recorridos en `ramales.xlsx` y la lógica propia del proveedor dentro de un conector;
2. preservá el contrato XLSX y el comportamiento conservador de fallback;
3. agregá cobertura de regresión para nuevas reglas de descubrimiento o validación;
4. ejecutá ambas suites de pruebas;
5. actualizá el ADR o las notas de investigación cuando cambie un contrato externo.

Nunca subas secretos, credenciales privadas de API ni datos de usuarios.

## Licencia

El código fuente original de SolarisPKN-Transport se distribuye bajo la [GNU General Public License v3.0](LICENSE). Esa licencia no pretende cubrir marcas, aplicaciones móviles, servicios de proveedores ni datos de cronogramas pertenecientes a terceros. Consultá el [aviso legal, de atribución y de datos](LEGAL.es.md).

---

**SolarisPKN-Transport** — en vivo cuando se puede, confiable cuando importa.
