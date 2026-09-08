const MAX_BODY_BYTES = 128 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_ENVELOPE_TTL_MS = 20 * 60 * 1000;
const DISCARD_AFTER_MS = 10 * 60 * 1000;
const REGIONAL_BOUNDS = { minLat: -35.35, maxLat: -34.30, minLon: -59.75, maxLon: -58.20 };
const ALLOWED_ROUTES = new Set([
  '136-villars', '136-rapido', '322',
  '322-lujan', '322-canuelas',
  '739_670', '739_671', '135_1623', '135_1624', '135_1625', '135_1626',
]);
const PROVIDERS = {
  transporteya: { id: 'transporteya-bridge', objectKey: 'bridge/transporteya.json' },
  'cuando-subo': { id: 'cuando-subo-bridge', objectKey: 'bridge/cuando-subo.json' },
};
const encoder = new TextEncoder();
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{1,119}$/i;

function finiteDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function safeText(value, maximum = 160) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function hexBytes(value) {
  if (!/^[a-f0-9]{64}$/i.test(value || '')) return null;
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

async function verifySignature(body, headers, secret, nowMs) {
  if (!secret) throw new Response('Bridge ingest is not configured', { status: 503 });
  const timestamp = headers.get('X-Solaris-Timestamp');
  const nonce = headers.get('X-Solaris-Nonce');
  const signatureHeader = headers.get('X-Solaris-Signature');
  const timestampMs = Number(timestamp);
  const signature = hexBytes(signatureHeader?.replace(/^sha256=/i, ''));
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_CLOCK_SKEW_MS) {
    throw new Response('Expired bridge request', { status: 401 });
  }
  if (!/^[a-z0-9-]{8,80}$/i.test(nonce || '') || !signature) {
    throw new Response('Invalid bridge signature headers', { status: 401 });
  }
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, signature, encoder.encode(`${timestamp}.${nonce}.${body}`),
  );
  if (!valid) throw new Response('Invalid bridge signature', { status: 401 });
}

function sanitizeVehicle(vehicle, providerId) {
  if (!vehicle || vehicle.provider !== providerId || vehicle.source?.id !== providerId) return null;
  if (!IDENTIFIER.test(vehicle.id || '') || vehicle.mode !== 'bus' || !ALLOWED_ROUTES.has(vehicle.routeId)) return null;
  if (!safeText(vehicle.label) || !['reported', 'estimated', 'none'].includes(vehicle.positionKind)) return null;
  if (!['fresh', 'stale'].includes(vehicle.dataStatus) || !finiteDate(vehicle.receivedAt)) return null;
  if (vehicle.positionKind === 'none') return null;
  const lat = Number(vehicle.position?.lat);
  const lon = Number(vehicle.position?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || lat < REGIONAL_BOUNDS.minLat || lat > REGIONAL_BOUNDS.maxLat
      || lon < REGIONAL_BOUNDS.minLon || lon > REGIONAL_BOUNDS.maxLon) return null;
  if (vehicle.positionKind === 'reported' && !finiteDate(vehicle.observedAt)) return null;
  if (finiteDate(vehicle.observedAt) && Date.parse(vehicle.observedAt) > Date.parse(vehicle.receivedAt)) return null;
  const position = { lat, lon };
  const bearing = Number(vehicle.position?.bearing);
  if (Number.isFinite(bearing) && bearing >= 0 && bearing < 360) position.bearing = bearing;
  const speedKmh = Number(vehicle.position?.speedKmh);
  if (Number.isFinite(speedKmh) && speedKmh >= 0 && speedKmh <= 180) position.speedKmh = speedKmh;
  return {
    id: vehicle.id,
    provider: providerId,
    mode: 'bus',
    routeId: vehicle.routeId,
    label: vehicle.label,
    status: 'active',
    positionKind: vehicle.positionKind,
    dataStatus: vehicle.dataStatus,
    position,
    observedAt: finiteDate(vehicle.observedAt) ? vehicle.observedAt : null,
    receivedAt: vehicle.receivedAt,
    source: {
      id: providerId,
      recordId: safeText(vehicle.source?.recordId, 120) ? vehicle.source.recordId : null,
    },
  };
}

function sanitizeArrival(arrival) {
  if (!arrival || !ALLOWED_ROUTES.has(arrival.routeId)) return null;
  if (!safeText(arrival.tripId, 120) || !safeText(arrival.stopId, 120)
      || !safeText(arrival.stopName) || !safeText(arrival.destination)) return null;
  if (!Number.isInteger(arrival.etaMinutes) || arrival.etaMinutes < 0 || arrival.etaMinutes > 300) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(arrival.scheduledTime || '') || !finiteDate(arrival.observedAt)) return null;
  return {
    routeId: arrival.routeId,
    tripId: arrival.tripId,
    stopId: arrival.stopId,
    stopName: arrival.stopName,
    destination: arrival.destination,
    scheduledTime: arrival.scheduledTime,
    etaMinutes: arrival.etaMinutes,
    observedAt: arrival.observedAt,
  };
}

export function sanitizeBridgeEnvelope(candidate, providerSlug, now = new Date()) {
  const provider = PROVIDERS[providerSlug];
  if (!provider || !exactKeys(candidate, ['schemaVersion', 'provider', 'generatedAt', 'expiresAt', 'vehicles', 'arrivals'])) {
    throw new TypeError('Invalid bridge envelope');
  }
  if (candidate.schemaVersion !== 1 || candidate.provider !== provider.id
      || !finiteDate(candidate.generatedAt) || !finiteDate(candidate.expiresAt)
      || Date.parse(candidate.expiresAt) <= Date.parse(candidate.generatedAt)
      || Date.parse(candidate.expiresAt) - Date.parse(candidate.generatedAt) > MAX_ENVELOPE_TTL_MS
      || Math.abs(now.getTime() - Date.parse(candidate.generatedAt)) > MAX_CLOCK_SKEW_MS) {
    throw new TypeError('Invalid bridge envelope metadata');
  }
  if (!Array.isArray(candidate.vehicles) || candidate.vehicles.length > 100
      || !Array.isArray(candidate.arrivals) || candidate.arrivals.length > 250) {
    throw new TypeError('Bridge envelope exceeds collection limits');
  }
  const vehicles = candidate.vehicles.map((vehicle) => sanitizeVehicle(vehicle, provider.id));
  const arrivals = candidate.arrivals.map(sanitizeArrival);
  if (vehicles.some((vehicle) => vehicle === null) || arrivals.some((arrival) => arrival === null)) {
    throw new TypeError('Bridge envelope contains invalid records');
  }
  return {
    schemaVersion: 1,
    provider: provider.id,
    generatedAt: candidate.generatedAt,
    expiresAt: candidate.expiresAt,
    vehicles,
    arrivals,
  };
}

export async function handleBridgeIngest(request, env, providerSlug, now = new Date()) {
  const provider = PROVIDERS[providerSlug];
  if (!provider) return new Response('Not found', { status: 404 });
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) {
    return new Response('Content-Type must be application/json', { status: 415 });
  }
  if (declaredLength > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 });
  const body = await request.text();
  if (encoder.encode(body).byteLength > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 });
  try {
    await verifySignature(body, request.headers, env.BRIDGE_INGEST_SECRET, now.getTime());
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  let candidate;
  try { candidate = JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400 }); }
  let envelope;
  try { envelope = sanitizeBridgeEnvelope(candidate, providerSlug, now); } catch {
    return new Response('Invalid bridge envelope', { status: 422 });
  }
  const previous = await env.TRANSPORT_LIVE.get(provider.objectKey, { type: 'json' });
  if (finiteDate(previous?.generatedAt) && Date.parse(previous.generatedAt) > Date.parse(envelope.generatedAt)) {
    return new Response('Older observation rejected', { status: 409 });
  }
  if (previous?.generatedAt === envelope.generatedAt) {
    return Response.json({ accepted: true, idempotent: true, provider: provider.id, vehicles: envelope.vehicles.length, arrivals: envelope.arrivals.length });
  }
  await env.TRANSPORT_LIVE.put(provider.objectKey, JSON.stringify(envelope), {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    customMetadata: { schemaVersion: '1', provider: provider.id, generatedAt: envelope.generatedAt },
  });
  return Response.json({ accepted: true, provider: provider.id, vehicles: envelope.vehicles.length, arrivals: envelope.arrivals.length });
}

export function bridgeVehiclesForCurrent(envelope, now = new Date()) {
  if (!envelope || Date.parse(envelope.generatedAt) + DISCARD_AFTER_MS < now.getTime()) return [];
  const envelopeStale = Date.parse(envelope.expiresAt) < now.getTime();
  return envelope.vehicles.map((vehicle) => ({
    provider: vehicle.provider,
    mode: vehicle.mode,
    routeId: vehicle.routeId,
    tripId: null,
    vehicleId: vehicle.id,
    label: vehicle.label,
    lat: vehicle.position.lat,
    lon: vehicle.position.lon,
    bearing: vehicle.position.bearing ?? null,
    speedKmh: vehicle.position.speedKmh ?? null,
    updatedAt: vehicle.observedAt || vehicle.receivedAt,
    positionKind: vehicle.positionKind === 'reported' ? 'observed' : 'predicted',
    stale: envelopeStale || vehicle.dataStatus === 'stale',
  }));
}

export async function readBridgeProviders(env, now = new Date()) {
  return Promise.all(Object.entries(PROVIDERS).map(async ([slug, provider]) => {
    let candidate = null;
    try { candidate = await env.TRANSPORT_LIVE.get(provider.objectKey, { type: 'json' }); } catch { /* unavailable */ }
    if (!candidate) return { slug, id: provider.id, status: 'disabled', vehicles: [], arrivals: [], lastSuccessfulAt: null };
    let envelope;
    try { envelope = sanitizeBridgeEnvelope(candidate, slug, new Date(candidate.generatedAt)); } catch {
      return { slug, id: provider.id, status: 'unavailable', vehicles: [], arrivals: [], lastSuccessfulAt: null };
    }
    const age = now.getTime() - Date.parse(envelope.generatedAt);
    if (age > DISCARD_AFTER_MS) {
      return { slug, id: provider.id, status: 'unavailable', vehicles: [], arrivals: [], lastSuccessfulAt: envelope.generatedAt };
    }
    return {
      slug,
      id: provider.id,
      status: Date.parse(envelope.expiresAt) < now.getTime() ? 'degraded' : 'ok',
      vehicles: bridgeVehiclesForCurrent(envelope, now),
      arrivals: envelope.arrivals,
      lastSuccessfulAt: envelope.generatedAt,
    };
  }));
}

export { MAX_BODY_BYTES, PROVIDERS };
