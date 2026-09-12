# Minimal live-position examples

> **Archivo historico, no operativo.** Estos ejemplos describen el contrato v1 y se conservan
> unicamente como evidencia de la evolucion del proyecto. Para una instalacion nueva use
> [`docs/guides/self-hosted-live-worker.md`](../../docs/guides/self-hosted-live-worker.md), el
> contrato v2 y `live/`. Ningun runtime, build o deploy importa este directorio; la prueba offline
> `tests/live-positions-contract.test.mjs` se conserva unicamente como regresion de compatibilidad v1.

These dependency-free examples implement the provider-neutral contract in
[`docs/contracts/live-positions.schema.json`](../../docs/contracts/live-positions.schema.json).
They are intentionally not deployable configuration and contain no real provider URL, route ID,
account, bucket, origin, token, or secret.

## Files

- `contract.mjs` performs the safety-critical runtime and semantic checks used by the examples.
- `aggregator.mjs` runs independent collectors concurrently, rejects semantically invalid HTTP 200
  payloads, retains a failed source's last valid vehicles as stale for a bounded period, and selects
  timetable-only fallback only when no live result remains usable.
- `client.mjs` validates before replacing the last snapshot, uses ETag revalidation, pauses in hidden
  tabs, adds polling jitter, and never creates a marker for an active service without coordinates.
- `client.html` shows the minimum accessible states without prescribing a map library or framework.
- `.env.example` lists generic server-side configuration names with blank values.

## Run the offline example tests

From the repository root:

```bash
node --test tests/live-positions-contract.test.mjs
```

No provider, network, object store, Cloudflare account, or credential is contacted.

## Collector interface

Inject one async collector per source. Each collector must return normalized, contract-valid vehicles:

```js
import { acceptProviderResponse, refreshSnapshot } from './aggregator.mjs';

const snapshot = await refreshSnapshot({
  collectors: {
    'provider-a': async () => {
      const response = await serverSideProviderCall();
      return acceptProviderResponse({
        httpStatus: response.status,
        body: await response.json(),
        normalize: normalizeProviderA,
      });
    },
  },
  previous: await readPreviousSnapshot(),
});
```

The undefined functions above are explicit integration boundaries. Implement them in server-side code,
apply the provider's current authorization and redistribution terms, use timeouts and rate limits, and
write only a validated snapshot to the storage product you control.

An empty vehicle array is valid only when the provider's documented response structure is valid and it
really means that no matching unit is active. A malformed or unexpected HTTP 200 response must throw
`ProviderResponseError('semantic-invalid-response')`; it must not erase a previous valid source.

## Spanish summary / Resumen en español

El agregador recibe adaptadores inyectados y no conoce proveedores reales. El cliente conserva la última
instantánea válida, diferencia dato fresco y vencido, y cambia a cronograma local sin inventar una posición.
Una formación activa con `positionKind: "none"` puede mostrarse en una lista, pero nunca como marcador.
