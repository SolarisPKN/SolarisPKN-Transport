import route136Config from '../../../src/data/transport-136-villars.json' with { type: 'json' };
import transportMap from '../../../src/data/transport-map.json' with { type: 'json' };
import transportSchedules from '../../../src/data/transport-schedules.json' with { type: 'json' };
import { estimateScheduled136, estimateTimetableVehicles } from '../../../src/utils/transport-route-model.js';
import { handleBridgeIngest, readBridgeProviders } from './bridge-ingest.js';

const CUANDO_SUBO_BASE_URL = 'https://cuandosubo.sube.gob.ar/onebusaway-api-webapp/api/where';
const CUANDO_SUBO_AGENCIES = ['135', '739'];
const SOFSE_BASE_URL = 'https://api-servicios.sofse.gob.ar/v1';
const VILLARS_BUS_ROUTES = new Map([
  ['135_1623', { lineKey: '322-lujan', label: 'Colectivo 322 · hacia Luján' }],
  ['135_1624', { lineKey: '322-lujan', label: 'Colectivo 322 · hacia Marcos Paz' }],
  ['135_1625', { lineKey: '322-canuelas', label: 'Colectivo 322 · hacia Cañuelas' }],
  ['135_1626', { lineKey: '322-canuelas', label: 'Colectivo 322 · hacia Marcos Paz' }],
  ['739_670', { lineKey: '136-rapido', label: 'Colectivo 136 Rápido · hacia Navarro' }],
  ['739_671', { lineKey: '136-rapido', label: 'Colectivo 136 Rápido · hacia Primera Junta' }],
]);
const TRAIN_BRANCHES = new Set([67, 53]);
const SOFSE_POSITION_STATIONS = [
  154, 526, 3700, 4226, 6000,
  269, 464, 137, 257, 4601, 254, 432, 173, 225,
];
const TRAIN_STATIONS = new Map([
  [154, { name: 'González Catán', lat: -34.771634, lon: -58.6467472 }],
  [526, { name: '20 de Junio', lat: -34.7803617, lon: -58.7380117 }],
  [3700, { name: 'Marcos Paz (Belgrano)', lat: -34.7865089, lon: -58.8296815 }],
  [4226, { name: 'Villars', lat: -34.8289569, lon: -58.9384773 }],
  [6000, { name: 'Lozano', lat: -34.850067, lon: -59.0536908 }],
  [269, { name: 'Merlo', lat: -34.6644017, lon: -58.7281142 }],
  [464, { name: 'Km 34,5', lat: -34.6801742, lon: -58.7602409 }],
  [137, { name: 'A. Ferrari', lat: -34.706078, lon: -58.7794327 }],
  [257, { name: 'Mariano Acosta', lat: -34.7244791, lon: -58.7930682 }],
  [4601, { name: 'Maquinista R. Cal', lat: -34.744777, lon: -58.8081306 }],
  [254, { name: 'Marcos Paz', lat: -34.7832092, lon: -58.8366592 }],
  [432, { name: 'Zamudio', lat: -34.8578991, lon: -58.8921946 }],
  [173, { name: 'Hornos', lat: -34.8923029, lon: -58.917861 }],
  [225, { name: 'Las Heras', lat: -34.9280932, lon: -58.9445443 }],
]);
const FETCH_TIMEOUT_MS = 10_000;
const STALE_AFTER_MS = 120_000;
const UNAVAILABLE_AFTER_MS = 600_000;

function timestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return new Date(milliseconds).toISOString();
}

function argentinaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function replaceLowercase(value, replacements) {
  return [...value].map((character) => replacements[character] ?? character).join('');
}

function buildSofseCredentials(date = new Date()) {
  const compactDate = argentinaDate(date).replaceAll('-', '');
  const username = btoa(`${compactDate}sofse`);
  const firstPass = replaceLowercase(btoa(username), {
    a: '#t', e: '#x', i: '#f', o: '#l', u: '#7', '=': '#g',
  });
  const secondPass = replaceLowercase(btoa([...firstPass].reverse().join('')), {
    a: '#j', e: '#p', i: '#w', o: '#8', u: '#0', '=': '#v',
  });
  return {
    username,
    password: encodeURIComponent([...secondPass].reverse().join('')),
  };
}

async function fetchJson(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Villars-Informa-Live/1.0 (+https://villars.solarispkn.com.ar)',
      ...options.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function normalizeBusSnapshot(body, generatedAt = new Date()) {
  const trips = new Map((body?.data?.references?.trips || []).map((trip) => [trip.id, trip]));
  const vehicles = [];
  for (const entry of body?.data?.list || []) {
    const trip = trips.get(entry.tripId);
    const route = trip ? VILLARS_BUS_ROUTES.get(trip.routeId) : null;
    if (!route) continue;
    const observed = entry.location;
    const predicted = entry.tripStatus?.position;
    const position = Number.isFinite(observed?.lat) && Number.isFinite(observed?.lon) ? observed : predicted;
    if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lon)) continue;
    const updatedAt = timestamp(entry.lastLocationUpdateTime) || timestamp(entry.lastUpdateTime);
    const ageMs = updatedAt ? generatedAt.getTime() - new Date(updatedAt).getTime() : null;
    vehicles.push({
      provider: 'cuando-subo',
      mode: 'bus',
      routeId: trip.routeId,
      lineKey: route.lineKey,
      tripId: entry.tripId,
      vehicleId: `bus:${trip.routeId}:${entry.vehicleId || entry.id}`,
      label: route.label,
      lat: position.lat,
      lon: position.lon,
      bearing: Number.isFinite(entry.tripStatus?.orientation) ? entry.tripStatus.orientation : null,
      updatedAt,
      positionKind: position === observed ? 'observed' : 'predicted',
      stale: ageMs === null || ageMs > STALE_AFTER_MS,
    });
  }
  return vehicles;
}

function stationId(station) {
  return Number(station?.idElemento ?? station?.idEstacion ?? station?.estacion?.idElemento ?? station?.estacion?.id ?? station?.id);
}

function stationName(station) {
  return station?.nombre ?? station?.estacion?.nombre ?? station?.descripcion ?? null;
}

function dateValue(value) {
  const milliseconds = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function eventTime(event, order) {
  for (const field of order) {
    const value = dateValue(event?.[field]);
    if (value !== null) return value;
  }
  return null;
}

function finiteCoordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stationPosition(station) {
  const fallback = TRAIN_STATIONS.get(stationId(station));
  const lat = finiteCoordinate(station?.latitud ?? station?.estacion?.latitud ?? fallback?.lat);
  const lon = finiteCoordinate(station?.longitud ?? station?.estacion?.longitud ?? fallback?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, name: stationName(station) || fallback?.name || null };
}

function estimateTrainPosition(service, generatedAt) {
  const stops = (service?.estaciones || [])
    .map((station) => ({
      position: stationPosition(station),
      arrival: eventTime(station?.llegada, ['real', 'estimada', 'programada']),
      departure: eventTime(station?.salida, ['real', 'estimada', 'programada']),
    }))
    .filter(({ position }) => position)
    .sort((left, right) => (left.arrival ?? left.departure ?? Infinity) - (right.arrival ?? right.departure ?? Infinity));
  const now = generatedAt.getTime();

  for (const stop of stops) {
    if (stop.arrival !== null && stop.departure !== null && now >= stop.arrival && now <= stop.departure) {
      return {
        ...stop.position,
        fromStop: stop.position.name,
        toStop: stop.position.name,
        scheduledArrivalAt: new Date(stop.arrival).toISOString(),
      };
    }
  }

  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    const start = from.departure ?? from.arrival;
    const end = to.arrival ?? to.departure;
    if (start === null || end === null || end <= start || now < start || now > end) continue;
    const progress = Math.min(1, Math.max(0, (now - start) / (end - start)));
    return {
      lat: from.position.lat + (to.position.lat - from.position.lat) * progress,
      lon: from.position.lon + (to.position.lon - from.position.lon) * progress,
      fromStop: from.position.name,
      toStop: to.position.name,
      scheduledArrivalAt: new Date(end).toISOString(),
    };
  }
  return null;
}

function trainBranch(service) {
  const declaredBranch = Number(service?.ramal?.id);
  if (TRAIN_BRANCHES.has(declaredBranch)) return declaredBranch;
  const stationIds = new Set((service?.estaciones || []).map(stationId).filter(Number.isFinite));
  if (stationIds.has(154) && (stationIds.has(4226) || stationIds.has(6000))) return 67;
  if (stationIds.has(269) && (stationIds.has(254) || stationIds.has(225))) return 53;
  return null;
}

const TRAIN_CANCELLATION_PATTERN = /\b(cancelad[oa]|suspendid[oa]|suprimid[oa]|no\s+circula|servicio\s+cancelado)\b/i;
const TRAIN_DELAY_THRESHOLD_MINUTES = 3;

function serviceEventTimes(service, field) {
  return (service?.estaciones || []).flatMap((station) => [
    dateValue(station?.llegada?.[field]),
    dateValue(station?.salida?.[field]),
  ]).filter((value) => value !== null);
}

function serviceBounds(service) {
  const stationTimes = (service?.estaciones || []).flatMap((station) => [
    eventTime(station?.llegada, ['real', 'estimada', 'programada']),
    eventTime(station?.salida, ['real', 'estimada', 'programada']),
  ]).filter((value) => value !== null);
  return stationTimes.length
    ? { start: Math.min(...stationTimes), end: Math.max(...stationTimes) }
    : { start: null, end: null };
}

function serviceDelayMinutes(service) {
  const delays = (service?.estaciones || []).flatMap((station) => (
    ['llegada', 'salida'].map((eventName) => {
      const event = station?.[eventName];
      const planned = dateValue(event?.programada);
      const observed = dateValue(event?.real) ?? dateValue(event?.estimada);
      return planned === null || observed === null ? null : Math.round((observed - planned) / 60_000);
    })
  )).filter(Number.isFinite);
  return delays.length ? Math.max(0, ...delays) : 0;
}

export function normalizeTrainServiceStatuses(responses, generatedAt = new Date()) {
  const statuses = new Map();
  const statusPriority = { scheduled: 1, completed: 2, confirmed: 3, in_progress: 4, delayed: 5, cancelled: 6 };
  for (const body of responses) {
    const receivedAt = timestamp(body?.timestamp) || generatedAt.toISOString();
    for (const item of body?.results || []) {
      const service = item?.servicio ?? item;
      const branchId = trainBranch(service);
      if (branchId === null || !service?.numero) continue;
      const bounds = serviceBounds(service);
      if (bounds.start === null || bounds.end === null) continue;
      const realTimes = serviceEventTimes(service, 'real');
      const estimatedTimes = serviceEventTimes(service, 'estimada');
      const location = service?.location;
      const hasLocation = Number.isFinite(finiteCoordinate(location?.lat)) && Number.isFinite(finiteCoordinate(location?.long));
      const dynamicEvidence = hasLocation || realTimes.length > 0 || estimatedTimes.length > 0;
      const now = generatedAt.getTime();
      const activeWindow = now >= bounds.start && now <= bounds.end;
      const description = [service?.leyenda, service?.tipo?.nombre].filter(Boolean).join(' · ');
      const cancelled = TRAIN_CANCELLATION_PATTERN.test(description);
      const delayMinutes = serviceDelayMinutes(service);
      let status = 'scheduled';
      if (cancelled) status = 'cancelled';
      else if (dynamicEvidence && now > bounds.end) status = 'completed';
      else if (dynamicEvidence && delayMinutes >= TRAIN_DELAY_THRESHOLD_MINUTES) status = 'delayed';
      else if (dynamicEvidence && activeWindow) status = 'in_progress';
      else if (dynamicEvidence) status = 'confirmed';
      const destination = service?.hasta?.estacion ?? service?.hasta;
      const operationalDate = argentinaDate(new Date(bounds.start));
      const record = {
        provider: 'sofse',
        lineKey: branchId === 67 ? 'belgrano-sur' : 'sarmiento-merlo-lobos',
        routeId: `sofse-${branchId}`,
        serviceNumber: String(service.numero),
        directionId: Number(service?.sentido) || null,
        destination: stationName(destination),
        operationalDate,
        status,
        delayMinutes: status === 'delayed' ? delayMinutes : null,
        evidence: hasLocation ? 'location' : realTimes.length ? 'real-time' : estimatedTimes.length ? 'estimated-time' : 'published-schedule',
        message: cancelled ? description : status === 'delayed' ? `Demora informada de ${delayMinutes} minutos` : null,
        scheduledStartAt: new Date(bounds.start).toISOString(),
        scheduledEndAt: new Date(bounds.end).toISOString(),
        updatedAt: receivedAt,
      };
      const key = `${record.routeId}:${record.serviceNumber}:${record.directionId}:${record.operationalDate}`;
      const previous = statuses.get(key);
      if (!previous || statusPriority[record.status] > statusPriority[previous.status]) statuses.set(key, record);
    }
  }
  return [...statuses.values()];
}

export function normalizeTrainSnapshots(responses, generatedAt = new Date()) {
  const vehicles = new Map();
  for (const body of responses) {
    const receivedAt = timestamp(body?.timestamp) || generatedAt.toISOString();
    for (const item of body?.results || []) {
      const service = item?.servicio ?? item;
      const location = service?.location;
      const branchId = trainBranch(service);
      if (branchId === null) continue;
      const observed = {
        lat: finiteCoordinate(location?.lat),
        lon: finiteCoordinate(location?.long),
      };
      const hasObservedPosition = Number.isFinite(observed.lat) && Number.isFinite(observed.lon);
      const position = hasObservedPosition ? observed : estimateTrainPosition(service, generatedAt);
      if (!position) continue;
      const destination = service?.hasta?.estacion ?? service?.hasta;
      const firstServiceTime = (service?.estaciones || [])
        .map((station) => eventTime(station?.salida, ['programada', 'estimada', 'real']) ?? eventTime(station?.llegada, ['programada', 'estimada', 'real']))
        .find((value) => value !== null);
      const serviceDate = firstServiceTime ? new Date(firstServiceTime).toISOString().slice(0, 10) : argentinaDate(generatedAt);
      const identity = service?.id || [branchId, service?.numero || 'sin-numero', service?.sentido || 'sin-sentido', serviceDate].join(':');
      const candidate = {
        provider: 'sofse',
        mode: 'train',
        routeId: `sofse-${branchId}`,
        tripId: service?.id ?? null,
        vehicleId: `train:${identity}`,
        label: `Tren ${service?.numero || ''}${stationName(destination) ? ` · ${stationName(destination)}` : ''}`.trim(),
        lat: position.lat,
        lon: position.lon,
        bearing: null,
        updatedAt: receivedAt,
        positionKind: hasObservedPosition ? 'observed' : 'predicted',
        fromStop: position.fromStop ?? null,
        toStop: position.toStop ?? null,
        scheduledArrivalAt: position.scheduledArrivalAt ?? null,
        stale: generatedAt.getTime() - new Date(receivedAt).getTime() > STALE_AFTER_MS,
      };
      const previous = vehicles.get(identity);
      if (!previous || previous.positionKind !== 'observed' || candidate.positionKind === 'observed') {
        vehicles.set(identity, candidate);
      }
    }
  }
  return [...vehicles.values()];
}

async function collectBus(env, generatedAt) {
  if (!env.CUANDO_SUBO_API_KEY) throw new Error('Falta el secreto CUANDO_SUBO_API_KEY');
  const requests = await Promise.allSettled(CUANDO_SUBO_AGENCIES.map(async (agency) => {
    const body = await fetchJson(`${CUANDO_SUBO_BASE_URL}/vehicles-for-agency/${agency}.json`, {
      headers: { Authorization: `Bearer ${env.CUANDO_SUBO_API_KEY}` },
    });
    if (!Array.isArray(body?.data?.list) || !Array.isArray(body?.data?.references?.trips)) {
      throw new Error(`Cuándo SUBO devolvió una respuesta inválida para la agencia ${agency}`);
    }
    return normalizeBusSnapshot(body, generatedAt);
  }));
  const successful = requests.filter(({ status }) => status === 'fulfilled').flatMap(({ value }) => value);
  if (!requests.some(({ status }) => status === 'fulfilled')) {
    throw new Error('Cuándo SUBO no respondió para ninguna agencia configurada');
  }
  return {
    vehicles: [...new Map(successful.map((vehicle) => [vehicle.vehicleId, vehicle])).values()],
    partialFailures: requests.filter(({ status }) => status === 'rejected').length,
  };
}

async function authenticateSofse(generatedAt) {
  const body = await fetchJson(`${SOFSE_BASE_URL}/auth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSofseCredentials(generatedAt)),
  });
  const token = typeof body === 'string' ? body : body?.token ?? body?.accessToken ?? body?.access_token;
  if (!token) throw new Error('SOFSE no devolvió un token reconocible');
  return token;
}

async function collectTrains(generatedAt) {
  const token = await authenticateSofse(generatedAt);
  const requests = await Promise.allSettled(SOFSE_POSITION_STATIONS.map(async (station) => {
    const body = await fetchJson(
      `${SOFSE_BASE_URL}/arribos/estacion/${station}`,
      { headers: { Authorization: token } },
    );
    if (!Array.isArray(body?.results)) throw new Error(`SOFSE devolvió una respuesta inválida para la estación ${station}`);
    return body;
  }));
  const successful = requests.filter(({ status }) => status === 'fulfilled').map(({ value }) => value);
  if (successful.length === 0) throw new Error('SOFSE no respondió en ninguna estación controlada');
  return {
    vehicles: normalizeTrainSnapshots(successful, generatedAt),
    services: normalizeTrainServiceStatuses(successful, generatedAt),
    partialFailures: requests.length - successful.length,
  };
}

function previousVehicles(snapshot, provider) {
  return (snapshot?.vehicles || [])
    .filter((vehicle) => vehicle?.provider === provider)
    .map((vehicle) => ({ ...vehicle, stale: true }));
}

function previousServices(snapshot, provider) {
  return (snapshot?.services || [])
    .filter((service) => service?.provider === provider)
    .map((service) => ({ ...service }));
}

function safeError(error) {
  const message = String(error?.message || error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 160);
}

function previousSuccessAt(snapshot, provider) {
  const value = snapshot?.providers?.[provider]?.lastSuccessfulAt;
  return value && Number.isFinite(new Date(value).getTime()) ? value : null;
}

function isUnavailable(lastSuccessfulAt, now) {
  if (!lastSuccessfulAt) return true;
  return now.getTime() - new Date(lastSuccessfulAt).getTime() > UNAVAILABLE_AFTER_MS;
}

async function readPreviousSnapshot(env) {
  try {
    return await env.TRANSPORT_LIVE.get('current.json', { type: 'json' });
  } catch {
    return null;
  }
}

function vehicleFamily(vehicle) {
  if (vehicle?.lineKey) return String(vehicle.lineKey);
  const routeId = String(vehicle?.routeId || '');
  if (routeId === 'sofse-67' || routeId === 'schedule-belgrano-sur') return 'belgrano-sur';
  if (routeId === 'sofse-53' || routeId === 'schedule-sarmiento-merlo-lobos') return 'sarmiento-merlo-lobos';
  if (routeId === '322-lujan' || routeId === 'schedule-322-lujan' || routeId === '135_1623' || routeId === '135_1624') return '322-lujan';
  if (routeId === '322-canuelas' || routeId === 'schedule-322-canuelas' || routeId === '135_1625' || routeId === '135_1626') return '322-canuelas';
  if (routeId === '136-rapido' || routeId.startsWith('739_') || routeId.includes('136-rapido')) return '136-rapido';
  if (routeId.includes('136')) return '136-villars';
  return routeId;
}

function vehicleRunKey(vehicle) {
  const serviceNumber = String(vehicle?.label || '').match(/\b\d{3,5}\b/)?.[0];
  return serviceNumber ? `${vehicleFamily(vehicle)}:${serviceNumber}` : null;
}

function bridgeProvider(bridgeProviders, id, failure = null) {
  if (failure) return { status: 'error', vehicles: 0, arrivals: 0, lastSuccessfulAt: null, message: safeError(failure) };
  const provider = bridgeProviders.find((entry) => entry.id === id);
  if (!provider) return { status: 'disabled', vehicles: 0, arrivals: 0, lastSuccessfulAt: null };
  return {
    status: provider.status,
    vehicles: provider.vehicles.length,
    arrivals: provider.arrivals.length,
    lastSuccessfulAt: provider.lastSuccessfulAt,
  };
}

export async function refreshTransport(env, now = new Date(), options = {}) {
  const previous = await readPreviousSnapshot(env);
  const busConfigured = Boolean(env.CUANDO_SUBO_API_KEY);
  const scheduleCollector = options.scheduleCollector
    || ((generatedAt) => {
      const timetableLines = new Set([
        '136-rapido', '322-lujan', '322-canuelas',
        'belgrano-sur', 'sarmiento-merlo-lobos',
      ]);
      const timetableVehicles = transportSchedules.routes
        .filter(({ lineKey }) => timetableLines.has(lineKey))
        .flatMap((route) => estimateTimetableVehicles(
          route,
          transportMap.stops.features.filter(({ properties }) => properties?.lineKey === route.lineKey),
          generatedAt,
        ));
      return [
        ...estimateScheduled136(route136Config, generatedAt),
        ...timetableVehicles,
      ];
    });
  const bridgeCollector = options.bridgeCollector || ((generatedAt) => readBridgeProviders(env, generatedAt));
  const [busResult, trainResult, scheduleResult, bridgeResult] = await Promise.allSettled([
    busConfigured ? collectBus(env, now) : Promise.resolve([]),
    collectTrains(now),
    Promise.resolve().then(() => scheduleCollector(now)),
    Promise.resolve().then(() => bridgeCollector(now)),
  ]);

  const bridgeProviders = bridgeResult.status === 'fulfilled' ? bridgeResult.value : [];
  const bridgeVehicles = bridgeProviders.flatMap(({ vehicles }) => vehicles);
  const bridgeArrivals = bridgeProviders.flatMap(({ arrivals }) => arrivals);
  const observedBridgeFamilies = new Set(bridgeVehicles
    .filter(({ positionKind, stale }) => positionKind === 'observed' && !stale)
    .map(vehicleFamily));
  const busVehicles = (busConfigured && busResult.status === 'fulfilled'
    ? busResult.value.vehicles
    : busConfigured ? previousVehicles(previous, 'cuando-subo') : [])
    .filter((vehicle) => !observedBridgeFamilies.has(vehicleFamily(vehicle)));
  const trainVehicles = trainResult.status === 'fulfilled'
    ? trainResult.value.vehicles
    : previousVehicles(previous, 'sofse');
  const trainServices = trainResult.status === 'fulfilled'
    ? trainResult.value.services
    : previousServices(previous, 'sofse');
  const reportedTrainRuns = new Set(trainVehicles.map(vehicleRunKey).filter(Boolean));
  const scheduledVehicles = (scheduleResult.status === 'fulfilled' ? scheduleResult.value : [])
    .filter((vehicle) => !observedBridgeFamilies.has(vehicleFamily(vehicle)))
    .filter((vehicle) => vehicle.mode !== 'train' || !reportedTrainRuns.has(vehicleRunKey(vehicle)));
  const trainPartial = trainResult.status === 'fulfilled'
    ? trainResult.value.partialFailures
    : SOFSE_POSITION_STATIONS.length;
  const busPartial = busConfigured && busResult.status === 'fulfilled'
    ? busResult.value.partialFailures
    : busConfigured ? CUANDO_SUBO_AGENCIES.length : 0;
  const generatedAt = now.toISOString();
  const busLastSuccessfulAt = busConfigured && busResult.status === 'fulfilled'
    ? generatedAt
    : busConfigured ? previousSuccessAt(previous, 'cuando-subo') : null;
  const trainLastSuccessfulAt = trainResult.status === 'fulfilled'
    ? generatedAt
    : previousSuccessAt(previous, 'sofse');
  const scheduleLastSuccessfulAt = scheduleResult.status === 'fulfilled'
    ? generatedAt
    : previousSuccessAt(previous, 'published-schedule');
  const busFailed = busConfigured && busResult.status === 'rejected';
  const scheduleFailed = scheduleResult.status === 'rejected';
  const bridgeFailed = bridgeResult.status === 'rejected';
  const bridgeDegraded = bridgeProviders.some(({ status }) => status === 'degraded' || status === 'unavailable');
  const degraded = busFailed || busPartial > 0 || scheduleFailed || trainResult.status === 'rejected' || trainPartial > 0
    || bridgeFailed || bridgeDegraded;
  const unavailable = scheduleFailed
    && trainResult.status === 'rejected'
    && (!busConfigured || (busFailed && isUnavailable(busLastSuccessfulAt, now)))
    && isUnavailable(trainLastSuccessfulAt, now);
  const snapshot = {
    schemaVersion: 1,
    generatedAt,
    expiresAt: new Date(now.getTime() + STALE_AFTER_MS).toISOString(),
    discardAfter: new Date(now.getTime() + UNAVAILABLE_AFTER_MS).toISOString(),
    status: unavailable ? 'unavailable' : degraded ? 'degraded' : 'ok',
    providers: {
      'published-schedule': scheduleResult.status === 'fulfilled'
        ? { status: 'estimated', vehicles: scheduledVehicles.length, lastSuccessfulAt: scheduleLastSuccessfulAt }
        : { status: 'error', vehicles: 0, lastSuccessfulAt: scheduleLastSuccessfulAt, message: safeError(scheduleResult.reason) },
      'cuando-subo': !busConfigured
        ? { status: 'disabled', vehicles: 0, lastSuccessfulAt: null }
        : busResult.status === 'fulfilled'
        ? { status: busPartial > 0 ? 'degraded' : 'ok', vehicles: busVehicles.length, failedAgencies: busPartial, lastSuccessfulAt: busLastSuccessfulAt }
        : { status: 'error', vehicles: busVehicles.length, lastSuccessfulAt: busLastSuccessfulAt, message: safeError(busResult.reason) },
      sofse: trainResult.status === 'fulfilled'
        ? { status: trainPartial > 0 ? 'degraded' : 'ok', vehicles: trainVehicles.length, services: trainServices.length, failedStations: trainPartial, lastSuccessfulAt: trainLastSuccessfulAt }
        : { status: 'error', vehicles: trainVehicles.length, services: trainServices.length, lastSuccessfulAt: trainLastSuccessfulAt, message: safeError(trainResult.reason) },
      'transporteya-bridge': bridgeProvider(
        bridgeProviders,
        'transporteya-bridge',
        bridgeResult.status === 'rejected' ? bridgeResult.reason : null,
      ),
      'cuando-subo-bridge': bridgeProvider(
        bridgeProviders,
        'cuando-subo-bridge',
        bridgeResult.status === 'rejected' ? bridgeResult.reason : null,
      ),
    },
    services: trainServices,
    arrivals: bridgeArrivals,
    vehicles: [...bridgeVehicles, ...busVehicles, ...trainVehicles, ...scheduledVehicles],
  };
  await env.TRANSPORT_LIVE.put('current.json', JSON.stringify(snapshot), {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'public, max-age=45, s-maxage=45, stale-while-revalidate=15',
    },
    customMetadata: { schemaVersion: '1', generatedAt },
  });
  return snapshot;
}

export default {
  async scheduled(_event, env, context) {
    context.waitUntil(refreshTransport(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        role: 'scheduled-writer-and-signed-bridge-ingest',
        snapshot: 'R2/current.json',
        bridgeIngestConfigured: Boolean(env.BRIDGE_INGEST_SECRET),
      });
    }
    const ingestMatch = /^\/ingest\/(transporteya|cuando-subo)$/.exec(url.pathname);
    if (ingestMatch) {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
      return handleBridgeIngest(request, env, ingestMatch[1]);
    }
    return new Response('Not found', { status: 404 });
  },
};
