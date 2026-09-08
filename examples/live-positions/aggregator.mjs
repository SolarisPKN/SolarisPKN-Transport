import { assertSnapshot, validateVehicle } from './contract.mjs';

export class ProviderResponseError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ProviderResponseError';
    this.code = code;
  }
}

function safeErrorCode(error) {
  const candidate = String(error?.code || 'request-failed').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate) ? candidate : 'request-failed';
}

export function acceptProviderResponse({ httpStatus, body, normalize }) {
  if (httpStatus !== 200) throw new ProviderResponseError('http-error');
  let result;
  try {
    result = normalize(body);
  } catch {
    throw new ProviderResponseError('semantic-invalid-response');
  }
  if (!result || !['ok', 'degraded'].includes(result.status) || !Array.isArray(result.vehicles)) {
    throw new ProviderResponseError('semantic-invalid-response');
  }
  for (const [index, vehicle] of result.vehicles.entries()) {
    if (!validateVehicle(vehicle, `provider.vehicles[${index}]`).ok) {
      throw new ProviderResponseError('semantic-invalid-response');
    }
  }
  return result;
}

function previousSource(previous, sourceId) {
  return previous?.sources?.find(({ id }) => id === sourceId) || null;
}

function retainedVehicles(previous, sourceId, nowMs, retainForMs) {
  return (previous?.vehicles || [])
    .filter(({ provider, receivedAt }) => (
      provider === sourceId
      && Number.isFinite(Date.parse(receivedAt))
      && nowMs - Date.parse(receivedAt) <= retainForMs
    ))
    .map((vehicle) => ({ ...vehicle, dataStatus: 'stale' }));
}

export async function refreshSnapshot({
  collectors,
  previous = null,
  now = new Date(),
  freshForMs = 120_000,
  retainForMs = 600_000,
  timetableRef = 'horarios.db',
}) {
  if (!collectors || typeof collectors !== 'object' || Object.keys(collectors).length === 0) {
    throw new TypeError('At least one named collector is required');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  if (!(freshForMs > 0) || !(retainForMs > freshForMs)) {
    throw new RangeError('retainForMs must be greater than freshForMs');
  }
  if (previous) assertSnapshot(previous);

  const generatedAt = now.toISOString();
  const nowMs = now.getTime();
  const sourceEntries = Object.entries(collectors);
  const settled = await Promise.allSettled(sourceEntries.map(([, collector]) => (
    typeof collector === 'function' ? collector() : null
  )));
  const sources = [];
  const vehicles = [];

  for (let index = 0; index < sourceEntries.length; index += 1) {
    const [sourceId, collector] = sourceEntries[index];
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(sourceId)) throw new TypeError(`Invalid source id: ${sourceId}`);
    if (typeof collector !== 'function') {
      sources.push({
        id: sourceId,
        status: 'disabled',
        lastAttemptAt: null,
        lastSuccessfulAt: previousSource(previous, sourceId)?.lastSuccessfulAt || null,
        vehicleCount: 0,
        errorCode: null,
      });
      continue;
    }

    const result = settled[index];
    const valueIsValid = result.status === 'fulfilled'
      && result.value
      && ['ok', 'degraded'].includes(result.value.status)
      && Array.isArray(result.value.vehicles)
      && result.value.vehicles.every((vehicle) => (
        vehicle.provider === sourceId && validateVehicle(vehicle).ok
      ));

    if (valueIsValid) {
      const currentVehicles = result.value.vehicles.map((vehicle) => ({ ...vehicle }));
      vehicles.push(...currentVehicles);
      sources.push({
        id: sourceId,
        status: result.value.status,
        lastAttemptAt: generatedAt,
        lastSuccessfulAt: generatedAt,
        vehicleCount: currentVehicles.length,
        errorCode: result.value.status === 'degraded' ? (result.value.errorCode || 'partial-response') : null,
      });
      continue;
    }

    const retained = retainedVehicles(previous, sourceId, nowMs, retainForMs);
    vehicles.push(...retained);
    const errorCode = result.status === 'rejected'
      ? safeErrorCode(result.reason)
      : 'semantic-invalid-response';
    sources.push({
      id: sourceId,
      status: 'unavailable',
      lastAttemptAt: generatedAt,
      lastSuccessfulAt: previousSource(previous, sourceId)?.lastSuccessfulAt || null,
      vehicleCount: retained.length,
      errorCode,
    });
  }

  const hasCurrentSource = sources.some(({ status }) => ['ok', 'degraded'].includes(status));
  const hasStaleVehicle = vehicles.some(({ dataStatus }) => dataStatus === 'stale');
  const unavailable = !hasCurrentSource && !hasStaleVehicle;
  const degraded = !unavailable && (
    sources.some(({ status }) => ['degraded', 'unavailable'].includes(status))
    || hasStaleVehicle
  );
  const unavailableSources = sources.filter(({ status }) => status === 'unavailable');
  const semanticFailureOnly = unavailableSources.length > 0
    && unavailableSources.every(({ errorCode }) => errorCode === 'semantic-invalid-response');

  const snapshot = {
    schemaVersion: 1,
    generatedAt,
    expiresAt: new Date(nowMs + freshForMs).toISOString(),
    discardAfter: new Date(nowMs + retainForMs).toISOString(),
    status: unavailable ? 'unavailable' : (degraded ? 'degraded' : 'ok'),
    sources,
    vehicles: unavailable ? [] : vehicles,
    fallback: unavailable
      ? {
          mode: 'timetable-only',
          reason: semanticFailureOnly ? 'semantic-invalid-response' : 'live-unavailable',
          timetableRef,
        }
      : { mode: 'none', reason: null, timetableRef: null },
  };
  return assertSnapshot(snapshot);
}
