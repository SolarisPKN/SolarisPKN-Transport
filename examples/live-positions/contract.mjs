const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'generatedAt',
  'expiresAt',
  'discardAfter',
  'status',
  'sources',
  'vehicles',
  'fallback',
];
const SOURCE_KEYS = [
  'id',
  'status',
  'lastAttemptAt',
  'lastSuccessfulAt',
  'vehicleCount',
  'errorCode',
];
const VEHICLE_KEYS = [
  'id',
  'mode',
  'provider',
  'operator',
  'routeId',
  'tripId',
  'direction',
  'label',
  'status',
  'positionKind',
  'position',
  'observedAt',
  'receivedAt',
  'dataStatus',
  'source',
];
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VEHICLE_ID = /^[a-z0-9][a-z0-9:._-]{2,199}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const allowed = new Set(expected);
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
  return true;
}

function isDateTime(value) {
  return typeof value === 'string' && DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
}

function nullableText(value) {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 200);
}

function validateSource(source, index, errors) {
  const path = `sources[${index}]`;
  if (!exactKeys(source, SOURCE_KEYS, path, errors)) return;
  if (!IDENTIFIER.test(source.id || '')) errors.push(`${path}.id is invalid`);
  if (!['ok', 'degraded', 'unavailable', 'disabled'].includes(source.status)) {
    errors.push(`${path}.status is invalid`);
  }
  if (source.lastAttemptAt !== null && !isDateTime(source.lastAttemptAt)) {
    errors.push(`${path}.lastAttemptAt must be a date-time or null`);
  }
  if (source.lastSuccessfulAt !== null && !isDateTime(source.lastSuccessfulAt)) {
    errors.push(`${path}.lastSuccessfulAt must be a date-time or null`);
  }
  if (!Number.isInteger(source.vehicleCount) || source.vehicleCount < 0) {
    errors.push(`${path}.vehicleCount must be a non-negative integer`);
  }
  if (source.errorCode !== null && !IDENTIFIER.test(source.errorCode || '')) {
    errors.push(`${path}.errorCode is invalid`);
  }
  if (source.status === 'ok' && source.errorCode !== null) {
    errors.push(`${path}.errorCode must be null when the source is ok`);
  }
  if (source.status === 'unavailable' && source.errorCode === null) {
    errors.push(`${path}.errorCode is required when the source is unavailable`);
  }
  if (source.status === 'disabled' && (source.lastAttemptAt !== null || source.errorCode !== null)) {
    errors.push(`${path} must not report an attempt or error when disabled`);
  }
}

export function validateVehicle(vehicle, path = 'vehicle') {
  const errors = [];
  if (!exactKeys(vehicle, VEHICLE_KEYS, path, errors)) return { ok: false, errors };
  if (!VEHICLE_ID.test(vehicle.id || '')) errors.push(`${path}.id is invalid`);
  if (!['train', 'bus'].includes(vehicle.mode)) errors.push(`${path}.mode is invalid`);
  if (!IDENTIFIER.test(vehicle.provider || '')) errors.push(`${path}.provider is invalid`);
  if (!nullableText(vehicle.operator)) errors.push(`${path}.operator is invalid`);
  if (typeof vehicle.routeId !== 'string' || vehicle.routeId.length < 1 || vehicle.routeId.length > 200) {
    errors.push(`${path}.routeId is invalid`);
  }
  if (!nullableText(vehicle.tripId)) errors.push(`${path}.tripId is invalid`);
  if (!nullableText(vehicle.direction)) errors.push(`${path}.direction is invalid`);
  if (typeof vehicle.label !== 'string' || vehicle.label.length < 1 || vehicle.label.length > 200) {
    errors.push(`${path}.label is invalid`);
  }
  if (!['active', 'inactive', 'unknown'].includes(vehicle.status)) errors.push(`${path}.status is invalid`);
  if (!['reported', 'estimated', 'none'].includes(vehicle.positionKind)) {
    errors.push(`${path}.positionKind is invalid`);
  }
  if (!['fresh', 'stale'].includes(vehicle.dataStatus)) errors.push(`${path}.dataStatus is invalid`);
  if (!isDateTime(vehicle.receivedAt)) errors.push(`${path}.receivedAt must be a date-time`);
  if (vehicle.observedAt !== null && !isDateTime(vehicle.observedAt)) {
    errors.push(`${path}.observedAt must be a date-time or null`);
  }

  if (vehicle.positionKind === 'none') {
    if (vehicle.position !== null) errors.push(`${path}.position must be null when positionKind is none`);
  } else {
    if (!isObject(vehicle.position)) {
      errors.push(`${path}.position is required for ${vehicle.positionKind} positions`);
    } else {
      const positionKeys = new Set(['lat', 'lon', 'bearing', 'accuracyMeters']);
      for (const key of Object.keys(vehicle.position)) {
        if (!positionKeys.has(key)) errors.push(`${path}.position.${key} is not allowed`);
      }
      if (!Number.isFinite(vehicle.position.lat) || vehicle.position.lat < -90 || vehicle.position.lat > 90) {
        errors.push(`${path}.position.lat is outside its valid range`);
      }
      if (!Number.isFinite(vehicle.position.lon) || vehicle.position.lon < -180 || vehicle.position.lon > 180) {
        errors.push(`${path}.position.lon is outside its valid range`);
      }
      if (Object.hasOwn(vehicle.position, 'bearing')
          && (!Number.isFinite(vehicle.position.bearing) || vehicle.position.bearing < 0 || vehicle.position.bearing >= 360)) {
        errors.push(`${path}.position.bearing is outside its valid range`);
      }
      if (Object.hasOwn(vehicle.position, 'accuracyMeters')
          && (!Number.isFinite(vehicle.position.accuracyMeters) || vehicle.position.accuracyMeters < 0)) {
        errors.push(`${path}.position.accuracyMeters is invalid`);
      }
    }
  }
  if (vehicle.positionKind === 'reported' && !isDateTime(vehicle.observedAt)) {
    errors.push(`${path}.observedAt is required for a reported position`);
  }
  if (isDateTime(vehicle.observedAt) && isDateTime(vehicle.receivedAt)
      && Date.parse(vehicle.observedAt) > Date.parse(vehicle.receivedAt)) {
    errors.push(`${path}.observedAt cannot be after receivedAt`);
  }

  if (!exactKeys(vehicle.source, ['id', 'recordId'], `${path}.source`, errors)) {
    return { ok: errors.length === 0, errors };
  }
  if (!IDENTIFIER.test(vehicle.source.id || '')) errors.push(`${path}.source.id is invalid`);
  if (!nullableText(vehicle.source.recordId)) errors.push(`${path}.source.recordId is invalid`);
  if (vehicle.provider !== vehicle.source.id) errors.push(`${path}.provider must equal source.id`);
  return { ok: errors.length === 0, errors };
}

export function validateSnapshot(snapshot) {
  const errors = [];
  if (!exactKeys(snapshot, TOP_LEVEL_KEYS, 'snapshot', errors)) return { ok: false, errors };
  if (snapshot.schemaVersion !== 1) errors.push('snapshot.schemaVersion must equal 1');
  for (const key of ['generatedAt', 'expiresAt', 'discardAfter']) {
    if (!isDateTime(snapshot[key])) errors.push(`snapshot.${key} must be a date-time`);
  }
  if (isDateTime(snapshot.generatedAt) && isDateTime(snapshot.expiresAt)
      && Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.generatedAt)) {
    errors.push('snapshot.expiresAt must be after generatedAt');
  }
  if (isDateTime(snapshot.expiresAt) && isDateTime(snapshot.discardAfter)
      && Date.parse(snapshot.discardAfter) <= Date.parse(snapshot.expiresAt)) {
    errors.push('snapshot.discardAfter must be after expiresAt');
  }
  if (!['ok', 'degraded', 'unavailable'].includes(snapshot.status)) errors.push('snapshot.status is invalid');
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length === 0) {
    errors.push('snapshot.sources must be a non-empty array');
  } else {
    snapshot.sources.forEach((source, index) => validateSource(source, index, errors));
  }
  if (!Array.isArray(snapshot.vehicles)) {
    errors.push('snapshot.vehicles must be an array');
  } else {
    snapshot.vehicles.forEach((vehicle, index) => {
      errors.push(...validateVehicle(vehicle, `vehicles[${index}]`).errors);
    });
  }

  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const vehicles = Array.isArray(snapshot.vehicles) ? snapshot.vehicles : [];
  const sourceIds = sources.map(({ id }) => id);
  const vehicleIds = vehicles.map(({ id }) => id);
  if (new Set(sourceIds).size !== sourceIds.length) errors.push('snapshot.sources contains duplicate ids');
  if (new Set(vehicleIds).size !== vehicleIds.length) errors.push('snapshot.vehicles contains duplicate ids');
  for (const vehicle of vehicles) {
    if (!sourceIds.includes(vehicle.provider)) errors.push(`vehicle ${vehicle.id} references an unknown provider`);
    if (isDateTime(vehicle.receivedAt) && isDateTime(snapshot.generatedAt)
        && Date.parse(vehicle.receivedAt) > Date.parse(snapshot.generatedAt)) {
      errors.push(`vehicle ${vehicle.id} was received after snapshot.generatedAt`);
    }
  }
  for (const source of sources) {
    const count = vehicles.filter(({ provider }) => provider === source.id).length;
    if (source.vehicleCount !== count) errors.push(`source ${source.id} vehicleCount does not match vehicles`);
    if (isDateTime(source.lastAttemptAt) && isDateTime(snapshot.generatedAt)
        && Date.parse(source.lastAttemptAt) > Date.parse(snapshot.generatedAt)) {
      errors.push(`source ${source.id} lastAttemptAt is after snapshot.generatedAt`);
    }
    if (isDateTime(source.lastSuccessfulAt) && isDateTime(snapshot.generatedAt)
        && Date.parse(source.lastSuccessfulAt) > Date.parse(snapshot.generatedAt)) {
      errors.push(`source ${source.id} lastSuccessfulAt is after snapshot.generatedAt`);
    }
  }

  if (!exactKeys(snapshot.fallback, ['mode', 'reason', 'timetableRef'], 'snapshot.fallback', errors)) {
    return { ok: errors.length === 0, errors };
  }
  if (!['none', 'timetable-only'].includes(snapshot.fallback.mode)) errors.push('snapshot.fallback.mode is invalid');
  if (snapshot.fallback.mode === 'none'
      && (snapshot.fallback.reason !== null || snapshot.fallback.timetableRef !== null)) {
    errors.push('snapshot.fallback must not reference a timetable when mode is none');
  }
  if (snapshot.fallback.mode === 'timetable-only') {
    if (!['live-unavailable', 'live-expired', 'semantic-invalid-response'].includes(snapshot.fallback.reason)) {
      errors.push('snapshot.fallback.reason is invalid');
    }
    if (!nullableText(snapshot.fallback.timetableRef) || snapshot.fallback.timetableRef === null) {
      errors.push('snapshot.fallback.timetableRef is required');
    }
  }
  if (snapshot.status === 'unavailable') {
    if (vehicles.length !== 0) errors.push('an unavailable snapshot must not expose vehicle positions');
    if (snapshot.fallback.mode !== 'timetable-only') errors.push('an unavailable snapshot must use timetable-only fallback');
  } else if (snapshot.fallback.mode !== 'none') {
    errors.push('only an unavailable snapshot may select timetable-only fallback');
  }
  if (snapshot.status === 'ok') {
    if (sources.some(({ status }) => !['ok', 'disabled'].includes(status))) {
      errors.push('an ok snapshot cannot contain a degraded or unavailable source');
    }
    if (vehicles.some(({ dataStatus }) => dataStatus !== 'fresh')) {
      errors.push('an ok snapshot cannot contain stale vehicles');
    }
  }
  if (snapshot.status === 'degraded'
      && !sources.some(({ status }) => ['degraded', 'unavailable'].includes(status))
      && !vehicles.some(({ dataStatus }) => dataStatus === 'stale')) {
    errors.push('a degraded snapshot must explain its degradation');
  }
  return { ok: errors.length === 0, errors };
}

export function assertSnapshot(snapshot) {
  const result = validateSnapshot(snapshot);
  if (!result.ok) throw new TypeError(`Invalid live positions snapshot:\n- ${result.errors.join('\n- ')}`);
  return snapshot;
}
