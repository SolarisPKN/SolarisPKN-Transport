const PROVIDERS = new Set(['transporteya-bridge', 'cuando-subo-bridge']);
const MODES = new Set(['bus', 'train']);
const POSITION_KINDS = new Set(['reported', 'estimated', 'none']);
const DATA_STATUSES = new Set(['fresh', 'stale']);
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{1,119}$/i;

function dateTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function text(value, maximum = 160) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function coordinate(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function validateEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, errors: ['Envelope must be an object'] };
  }
  const expected = ['schemaVersion', 'provider', 'generatedAt', 'expiresAt', 'vehicles', 'arrivals'];
  const keys = Object.keys(envelope).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) errors.push('Envelope keys are not exact');
  if (envelope.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!PROVIDERS.has(envelope.provider)) errors.push('provider is not allowed');
  if (!dateTime(envelope.generatedAt) || !dateTime(envelope.expiresAt)) errors.push('Envelope timestamps are invalid');
  if (dateTime(envelope.generatedAt) && dateTime(envelope.expiresAt)
      && Date.parse(envelope.expiresAt) <= Date.parse(envelope.generatedAt)) {
    errors.push('expiresAt must be after generatedAt');
  }
  if (!Array.isArray(envelope.vehicles) || envelope.vehicles.length > 100) {
    errors.push('vehicles must be an array with at most 100 items');
  } else {
    envelope.vehicles.forEach((vehicle, index) => {
      const prefix = `vehicles[${index}]`;
      if (!IDENTIFIER.test(vehicle?.id || '')) errors.push(`${prefix}.id is invalid`);
      if (!MODES.has(vehicle?.mode)) errors.push(`${prefix}.mode is invalid`);
      if (!text(vehicle?.routeId)) errors.push(`${prefix}.routeId is invalid`);
      if (!text(vehicle?.label)) errors.push(`${prefix}.label is invalid`);
      if (!POSITION_KINDS.has(vehicle?.positionKind)) errors.push(`${prefix}.positionKind is invalid`);
      if (!DATA_STATUSES.has(vehicle?.dataStatus)) errors.push(`${prefix}.dataStatus is invalid`);
      if (!dateTime(vehicle?.receivedAt)) errors.push(`${prefix}.receivedAt is invalid`);
      if (vehicle?.positionKind === 'none') {
        if (vehicle.position !== null) errors.push(`${prefix}.position must be null`);
      } else if (!vehicle?.position || !coordinate(vehicle.position.lat, -90, 90)
          || !coordinate(vehicle.position.lon, -180, 180)) {
        errors.push(`${prefix}.position is invalid`);
      }
      if (vehicle?.positionKind === 'reported' && !dateTime(vehicle?.observedAt)) {
        errors.push(`${prefix}.observedAt is required for reported positions`);
      }
      if (vehicle?.provider !== envelope.provider || vehicle?.source?.id !== envelope.provider) {
        errors.push(`${prefix} provenance must match envelope.provider`);
      }
      if (vehicle?.source?.recordId !== null && !text(vehicle?.source?.recordId)) {
        errors.push(`${prefix}.source.recordId is invalid`);
      }
    });
  }
  if (!Array.isArray(envelope.arrivals) || envelope.arrivals.length > 250) {
    errors.push('arrivals must be an array with at most 250 items');
  } else {
    envelope.arrivals.forEach((arrival, index) => {
      const prefix = `arrivals[${index}]`;
      if (!text(arrival?.routeId) || !text(arrival?.tripId) || !text(arrival?.stopId)) {
        errors.push(`${prefix} identifiers are invalid`);
      }
      if (!text(arrival?.stopName) || !text(arrival?.destination)) errors.push(`${prefix} labels are invalid`);
      if (!Number.isInteger(arrival?.etaMinutes) || arrival.etaMinutes < 0 || arrival.etaMinutes > 300) {
        errors.push(`${prefix}.etaMinutes is invalid`);
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(arrival?.scheduledTime || '')) {
        errors.push(`${prefix}.scheduledTime is invalid`);
      }
      if (!dateTime(arrival?.observedAt)) errors.push(`${prefix}.observedAt is invalid`);
    });
  }
  return { ok: errors.length === 0, errors };
}

export function assertEnvelope(envelope) {
  const result = validateEnvelope(envelope);
  if (!result.ok) throw new TypeError(`Invalid bridge envelope:\n- ${result.errors.join('\n- ')}`);
  return envelope;
}

export function createEnvelope(provider, { vehicles = [], arrivals = [], now = new Date(), ttlMs = 120_000 } = {}) {
  return assertEnvelope({
    schemaVersion: 1,
    provider,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    vehicles,
    arrivals,
  });
}
