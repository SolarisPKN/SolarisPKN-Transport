# Prompt para continuar en SolarisPKN-Transport

Trabajá en el repositorio local:

`D:\Usuarios\PabloKoutaNya\Documents\GitHub\SolarisPKN-Transport`

Quiero incorporar como documentación y ejemplo reutilizable la arquitectura de transporte vivo que ya funciona en `Villars-Informa`, sin convertir a SolarisPKN-Transport en el runtime de Villars y sin copiar ciegamente código específico del sitio.

## Contexto y material de referencia

Primero inspeccioná el estado Git y preservá absolutamente todo el trabajo existente. En particular, actualmente existe trabajo sin rastrear bajo `Horarios/Colectivos/136-Villars/`; no lo modifiques, muevas, elimines ni incluyas accidentalmente en tus cambios.

Leé completos antes de implementar:

- `README.md`
- `README.es.md`
- `LEGAL.md`
- `docs/adr/0001-cronogramas-diarios-con-fallback.md`
- `docs/research/trenes-argentinos-api.md`
- `docs/research/cuando-subo-api.md`
- todos los archivos de `docs/resources/villars-live-transport-reference/`

El directorio de recursos contiene una copia verificada de los archivos relevantes de Villars: Worker, configuración R2/CORS, cliente de mapa, página Astro, datos estáticos y pruebas. Es material de análisis. No ejecutes el `wrangler.jsonc` copiado y no despliegues nada desde ese directorio.

## Objetivo

Crear una guía de aplicación y un contrato técnico canónico para integrar posiciones vivas de trenes y colectivos en sitios estáticos, paneles o aplicaciones que consuman SolarisPKN-Transport.

La documentación debe evitar llamar “GPS” a cualquier coordenada que no haya sido informada realmente por el proveedor. Debe distinguir al menos:

- posición informada;
- posición estimada;
- formación activa sin coordenadas;
- dato fresco;
- dato vencido;
- fuente temporalmente no disponible;
- respuesta HTTP exitosa pero semánticamente inválida;
- fallback exclusivo al cronograma local.

## Entregables

1. Crear `docs/adr/0002-posiciones-vivas-separadas-de-cronogramas.md`.
   - Explicar por qué XLSX/SQLite siguen siendo la fuente de cronogramas.
   - Mantener la telemetría fuera de Git y fuera de la base diaria.
   - Definir degradación parcial por proveedor y ventanas de frescura.
   - Prohibir que una estimación sea presentada como posición informada.

2. Crear `docs/guides/integrar-posiciones-en-tiempo-real.md`.
   - Arquitectura proveedor -> agregador -> validación -> objeto consolidado -> almacenamiento -> cliente.
   - Procedimiento para Worker Cron y almacenamiento de objetos, sin acoplarlo exclusivamente a Cloudflare.
   - Procedimiento para un cliente web estático con ETag, polling, pausa en segundo plano y estados accesibles.
   - CORS mínimo, secretos únicamente del lado servidor y política de retención.
   - Atribución, observabilidad, límites de llamadas, rollback y pruebas.
   - Explicar qué archivos del paquete de Villars sirven como referencia para cada sección.

3. Crear `docs/contracts/live-positions.schema.json`.
   - Incluir `schemaVersion`, `generatedAt`, `expiresAt`, `vehicles` y estado por fuente.
   - IDs estables con namespace de modo/proveedor.
   - `mode`, `operator`, `routeId`, `direction`, `status`, `position`, `positionKind`, `observedAt`, `receivedAt`, `dataStatus` y `source`.
   - Permitir coordenadas ausentes cuando existe una unidad o formación activa.
   - No permitir coordenadas fuera de rango ni fechas sin formato ISO 8601.
   - Usar `additionalProperties: false` donde sea razonable.

4. Crear fixtures sanitizados en `tests/fixtures/live-positions/`:
   - `reported.json`
   - `estimated.json`
   - `active-without-position.json`
   - `partial-provider-failure.json`
   - `stale.json`
   - `invalid.json`

5. Crear ejemplos mínimos bajo `examples/live-positions/`.
   - Agregador neutralizado, sin nombres reales de cuenta, bucket, dominio o secretos.
   - Cliente web pequeño que consuma el contrato.
   - `.env.example` únicamente con nombres de variables.
   - README que aclare que es un ejemplo, no un despliegue listo para producción.

6. Añadir pruebas offline del contrato.
   - No deben necesitar red, Cloudflare, SOFSE ni Cuándo SUBO.
   - Deben comprobar rangos, frescura, fuentes parciales y formación activa sin GPS.
   - Reutilizá dependencias existentes cuando sea posible; no agregues una dependencia grande solo para validar unos pocos campos.

7. Enlazar la documentación nueva desde `README.md` y `README.es.md`.
   - Actualizar `LEGAL.md` solamente si es necesario para aclarar el nuevo alcance.
   - No cambiar las advertencias de independencia ni convertir accesibilidad técnica en una afirmación de licencia o autorización.

## Límites de seguridad y legales

- No copies ni publiques el valor de `CUANDO_SUBO_API_KEY`.
- No almacenes tokens temporales de SOFSE.
- No guardes APK, DNI, capturas de identidad, DPAPI, historiales de portapapeles ni material privado.
- No ejecutes extracción de credenciales como parte de esta tarea documental.
- La validación Trusted Access de OpenAI no equivale a permiso del proveedor.
- No declares las APIs internas como contratos públicos estables.
- No despliegues Workers, no escribas en R2, no modifiques DNS, CORS ni secretos.
- No hagas commit ni push sin una solicitud explícita posterior.

## Criterios de calidad

- Adaptá las prácticas; no copies el diseño de Villars como arquitectura universal.
- Evitá duplicar la implementación operativa completa: el código de Villars sigue siendo el caso real y los ejemplos de Transport deben ser mínimos y sanitizados.
- Todo dato del Schema debe estar representado por los ejemplos y explicado en la guía.
- Los tests deben demostrar el comportamiento, no solo comprobar que los archivos existen.
- Ejecutá las pruebas existentes y las nuevas, los validadores del repositorio y un diff check.
- Revisá el estado Git final y separá claramente tus cambios del directorio preexistente `Horarios/Colectivos/136-Villars/`.
- En el informe final, enumerá archivos creados, decisiones, validaciones, límites y un mensaje de commit sugerido, pero no publiques nada.
