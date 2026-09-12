export const LIVE_SCHEMA_VERSION = 2;

export const SERVICE_STATUSES = new Set([
  'scheduled', 'confirmed', 'in_progress', 'delayed', 'early', 'completed',
  'cancelled', 'skipped_stop', 'unknown',
]);
export const POSITION_SOURCES = new Set(['gps', 'provider-estimated', 'schedule-estimated']);
export const SPEED_SOURCES = new Set(['provider', 'calculated']);
export const PHASES = new Set(['incoming', 'stopped', 'in_transit', 'unknown']);

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : undefined;
const text = (value) => value === null || value === undefined || value === '' ? undefined : String(value).slice(0, 500);
const time = (value) => {
  if (value === null || value === undefined || value === '') return undefined;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

function optional(target, key, value) {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

export function vehicleIdentity(vehicle) {
  return [vehicle.provider, vehicle.routeId, vehicle.tripId || '', vehicle.vehicleId || '', vehicle.serviceNumber || '', vehicle.directionId ?? ''].join(':');
}

export function normalizeVehicle(candidate, defaults = {}) {
  const provider = text(candidate?.provider ?? defaults.provider);
  const mode = candidate?.mode ?? defaults.mode;
  const routeId = text(candidate?.routeId ?? defaults.routeId);
  if (!provider || !['train', 'bus'].includes(mode) || !routeId) throw new Error('Vehículo live sin provider, mode o routeId válido.');
  const result = { provider, mode, routeId };
  for (const key of ['branchId', 'branchName', 'tripId', 'vehicleId', 'serviceNumber', 'destination', 'previousStop', 'currentStop', 'nextStop']) {
    optional(result, key, text(candidate?.[key]));
  }
  if (candidate?.directionId !== undefined && candidate?.directionId !== null) result.directionId = candidate.directionId;
  const lat = finite(candidate?.lat);
  const lon = finite(candidate?.lon);
  if (lat !== undefined && lon !== undefined && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
    result.lat = lat;
    result.lon = lon;
  }
  for (const key of ['bearing', 'speedKmh', 'distanceAlongRoute', 'stopSequence', 'delaySeconds', 'scheduleDeviation']) {
    optional(result, key, finite(candidate?.[key]));
  }
  for (const key of ['observedAt', 'scheduledArrival', 'estimatedArrival', 'realArrival', 'scheduledDeparture', 'estimatedDeparture', 'realDeparture', 'checkedAt', 'sourceTimestamp', 'changedAt', 'confirmedAt']) {
    optional(result, key, time(candidate?.[key]));
  }
  if (SPEED_SOURCES.has(candidate?.speedSource)) result.speedSource = candidate.speedSource;
  if (POSITION_SOURCES.has(candidate?.positionSource)) result.positionSource = candidate.positionSource;
  result.phase = PHASES.has(candidate?.phase) ? candidate.phase : 'unknown';
  result.status = SERVICE_STATUSES.has(candidate?.status) ? candidate.status : 'unknown';
  result.realtimeAvailable = candidate?.realtimeAvailable === true;
  result.stale = candidate?.stale === true;
  return result;
}

export function normalizeAlert(candidate, defaults = {}) {
  const alertId = text(candidate?.alertId);
  const message = text(candidate?.message);
  if (!alertId || !message) return null;
  const result = { alertId, message };
  for (const key of ['provider', 'routeId', 'tripId', 'effect', 'severity']) optional(result, key, text(candidate?.[key] ?? defaults[key]));
  optional(result, 'validFrom', time(candidate?.validFrom));
  optional(result, 'validUntil', time(candidate?.validUntil));
  return result;
}

export function emptyCurrent(at = new Date().toISOString()) {
  return {
    schemaVersion: LIVE_SCHEMA_VERSION,
    updatedAt: at,
    trains: { checkedAt: null, sourceTimestamp: null, status: 'unavailable', vehicles: [], alerts: [] },
    buses: { checkedAt: null, sourceTimestamp: null, status: 'unavailable', vehicles: [], alerts: [] },
  };
}

export function validCurrent(candidate) {
  return candidate?.schemaVersion === LIVE_SCHEMA_VERSION
    && candidate?.trains && Array.isArray(candidate.trains.vehicles)
    && candidate?.buses && Array.isArray(candidate.buses.vehicles);
}
