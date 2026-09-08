# ADR 0003: observadores web locales para proveedores sin API publica reutilizable

- Estado: Aceptada parcialmente; Transporte YA bloqueado por prohibicion expresa
- Fecha: 2026-09-02
- Responsables: mantenedores de SolarisPKN-Transport y Villars-Informa

## Contexto

Villars necesita posiciones o estimaciones de colectivos 136 y 322. Transporte YA muestra coordenadas en su cliente
publico, pero no se comprobo una API abierta y documentada para reutilizacion. Cuando SUBO ofrece paginas publicas de
paradas con arribos, pero una ETA no es una coordenada. Extraer o reproducir credenciales tecnicas de las aplicaciones
acoplaria el proyecto a detalles internos y ampliaria innecesariamente el riesgo.

## Decision

SolarisPKN-Transport aloja un adaptador local no desplegable por si solo y conserva un contrato reservado para una
futura fuente autorizada de Transporte YA:

1. un lector rate-limited recorre paginas HTML publicas de paradas de Cuando SUBO;
2. elimina cuerpos crudos, aplica allowlist de ruta y emite un sobre normalizado corto;
3. Villars-Informa conserva el agregador, el almacenamiento R2, la salida publica `current.json` y la interfaz;
4. la ingestion usa una firma de SolarisPKN y no entrega al bridge credenciales de cuenta Cloudflare.

El browser observer de Transporte YA fue descartado despues de verificar el flujo real: su App Web publica muestra
`Prohibido Scrapping`. No se conserva codigo operativo de ese colector. Su endpoint de ingestion queda inerte y solo
podra recibir datos de una integracion futura autorizada por el proveedor.

Transportes YA puede aportar posiciones informadas. Cuando SUBO aporta ETA para futura recalibracion; no crea un
marcador GPS por si mismo. Los cronogramas siguen siendo propiedad del flujo XLSX/SQLite y no se mezclan con la
telemetria.

## Alternativas

- Reproducir secretos o HMAC de terceros: descartado.
- Consultar proveedores desde cada navegador visitante: descartado por carga, CORS y exposicion de detalles.
- Ejecutar navegadores en GitHub Actions: descartado por sesiones cortas, frecuencia y operacion fragil.
- Ejecutar el observador dentro de Cloudflare Worker: descartado; no es el runtime adecuado para una sesion web
  persistente y trasladaria la autenticacion del tercero al servidor.
- Mantener un proceso local de bajo volumen: elegido como fallback revocable.

## Consecuencias

- La maquina local debe permanecer encendida para que haya observaciones nuevas de Cuando SUBO.
- El estado publico puede degradarse a cronograma si el observador se apaga o el proveedor cambia.
- Transporte YA no aporta posiciones hasta obtener autorizacion o una API publica documentada.
- Un cambio de terminos, CAPTCHA o bloqueo activa el kill switch operativo: se detiene la fuente sin intentar evadirlo.
- El endpoint de ingestion y el secreto propio requieren un cambio Cloudflare separado, auditado y autorizado.

## Referencias

- `bridges/live-observers/README.md`
- `docs/adr/0002-posiciones-vivas-separadas-de-cronogramas.md`
- `docs/contracts/live-positions.schema.json`
