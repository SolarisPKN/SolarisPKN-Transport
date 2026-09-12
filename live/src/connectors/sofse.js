import { fetchJson } from './http.js';
import { normalizeAlert, normalizeVehicle } from '../schema.js';

const CANCELLATION = /\b(cancelad[oa]|suspendid[oa]|suprimid[oa]|no\s+circula|servicio\s+cancelado)\b/i;
const EARLY_THRESHOLD_SECONDS = -180;
const DELAY_THRESHOLD_SECONDS = 180;

const finite = (value) => value === null || value === undefined || value === '' ? undefined : Number.isFinite(Number(value)) ? Number(value) : undefined;
const stationId = (station) => Number(station?.idElemento ?? station?.idEstacion ?? station?.estacion?.idElemento ?? station?.estacion?.id ?? station?.id);
const stationName = (station) => station?.nombre ?? station?.estacion?.nombre ?? station?.descripcion ?? undefined;
const dateMs = (value) => { const ms = value ? new Date(value).getTime() : NaN; return Number.isFinite(ms) ? ms : undefined; };
const iso = (value) => { const ms = dateMs(value); return ms === undefined ? undefined : new Date(ms).toISOString(); };
const eventMs = (event, fields = ['real', 'estimada']) => fields.map((field) => dateMs(event?.[field])).find((value) => value !== undefined);

function argentinaDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function replaceLowercase(value, replacements) {
  return [...value].map((character) => replacements[character] ?? character).join('');
}

export function buildSofseCredentials(date = new Date()) {
  const username = btoa(`${argentinaDate(date)}sofse`);
  const first = replaceLowercase(btoa(username), { a: '#t', e: '#x', i: '#f', o: '#l', u: '#7', '=': '#g' });
  const second = replaceLowercase(btoa([...first].reverse().join('')), { a: '#j', e: '#p', i: '#w', o: '#8', u: '#0', '=': '#v' });
  return { username, password: encodeURIComponent([...second].reverse().join('')) };
}

function branchFor(service) {
  return Number(service?.ramal?.id);
}

function bounds(service) {
  const values = (service?.estaciones || []).flatMap((station) => [eventMs(station?.llegada), eventMs(station?.salida)]).filter(Number.isFinite);
  return values.length ? { start: Math.min(...values), end: Math.max(...values) } : {};
}

function delaySeconds(service) {
  const values = (service?.estaciones || []).flatMap((station) => ['llegada', 'salida'].map((key) => {
    const planned = dateMs(station?.[key]?.programada);
    const actual = dateMs(station?.[key]?.real) ?? dateMs(station?.[key]?.estimada);
    return planned === undefined || actual === undefined ? undefined : Math.round((actual - planned) / 1000);
  })).filter(Number.isFinite);
  return values.length ? values.reduce((best, value) => Math.abs(value) > Math.abs(best) ? value : best, 0) : undefined;
}

function stopProgress(service, nowMs) {
  const stops = service?.estaciones || [];
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    const arrival = eventMs(stop?.llegada);
    const departure = eventMs(stop?.salida);
    if (arrival !== undefined && departure !== undefined && nowMs >= arrival && nowMs <= departure) {
      return { previousStop: stationName(stops[index - 1]), currentStop: stationName(stop), nextStop: stationName(stops[index + 1]), stopSequence: index, phase: 'stopped' };
    }
    if (departure !== undefined && index + 1 < stops.length) {
      const nextArrival = eventMs(stops[index + 1]?.llegada);
      if (nextArrival !== undefined && nowMs > departure && nowMs < nextArrival) {
        return { previousStop: stationName(stop), nextStop: stationName(stops[index + 1]), stopSequence: index + 1, phase: 'in_transit' };
      }
    }
  }
  return { phase: 'unknown' };
}

export function normalizeSofseResponses(responses, line, checkedAt = new Date()) {
  const byIdentity = new Map();
  const alerts = new Map();
  let newestSourceTimestamp;
  for (const body of responses) {
    const sourceTimestamp = iso(body?.timestamp);
    if (sourceTimestamp && (!newestSourceTimestamp || sourceTimestamp > newestSourceTimestamp)) newestSourceTimestamp = sourceTimestamp;
    for (const wrapper of body?.results || []) {
      const service = wrapper?.servicio ?? wrapper;
      if (branchFor(service) !== Number(line.external.branchId)) continue;
      const description = [service?.leyenda, service?.tipo?.nombre].filter(Boolean).join(' · ');
      const cancelled = CANCELLATION.test(description);
      const location = service?.location;
      const lat = finite(location?.lat);
      const lon = finite(location?.long);
      const hasGps = lat !== undefined && lon !== undefined;
      const span = bounds(service);
      const delay = delaySeconds(service);
      const nowMs = checkedAt.getTime();
      const hasRealtimeTimes = (service?.estaciones || []).some((station) => station?.llegada?.real || station?.llegada?.estimada || station?.salida?.real || station?.salida?.estimada);
      let status = 'unknown';
      if (cancelled) status = 'cancelled';
      else if ((hasGps || hasRealtimeTimes) && span.end && nowMs > span.end) status = 'completed';
      else if (delay !== undefined && delay >= DELAY_THRESHOLD_SECONDS) status = 'delayed';
      else if (delay !== undefined && delay <= EARLY_THRESHOLD_SECONDS) status = 'early';
      else if ((hasGps || hasRealtimeTimes) && span.start && span.end && nowMs >= span.start && nowMs <= span.end) status = 'in_progress';
      else if (hasGps || hasRealtimeTimes) status = 'confirmed';
      const destination = service?.hasta?.estacion ?? service?.hasta;
      const identity = String(service?.id || `${line.id}:${service?.numero || 'unknown'}:${service?.sentido ?? 'unknown'}`);
      const vehicle = normalizeVehicle({
        provider: 'sofse', mode: 'train', routeId: line.id, branchId: String(line.external.branchId), branchName: line.name,
        tripId: service?.id, vehicleId: service?.formacion?.id || service?.formacion?.numero, serviceNumber: service?.numero,
        directionId: service?.sentido, destination: stationName(destination), lat, lon,
        observedAt: hasGps ? sourceTimestamp : undefined, positionSource: hasGps ? 'gps' : undefined,
        delaySeconds: delay, status, ...stopProgress(service, nowMs),
        checkedAt: checkedAt.toISOString(), sourceTimestamp, realtimeAvailable: hasGps || hasRealtimeTimes,
      });
      const previous = byIdentity.get(identity);
      if (!previous || (!Number.isFinite(previous.lat) && Number.isFinite(vehicle.lat))) byIdentity.set(identity, vehicle);
      if (cancelled && description) {
        const alert = normalizeAlert({ alertId: `sofse:${identity}:cancelled`, provider: 'sofse', routeId: line.id, tripId: service?.id, message: description, effect: 'NO_SERVICE', severity: 'severe' });
        if (alert) alerts.set(alert.alertId, alert);
      }
    }
  }
  return { vehicles: [...byIdentity.values()], alerts: [...alerts.values()], sourceTimestamp: newestSourceTimestamp };
}

async function token(provider, context, checkedAt) {
  if (!context.cache.sofseToken) {
    const body = await fetchJson(`${provider.baseUrl}/auth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildSofseCredentials(checkedAt)) });
    context.cache.sofseToken = typeof body === 'string' ? body : body?.token ?? body?.accessToken ?? body?.access_token;
    if (!context.cache.sofseToken) throw new Error('SOFSE no devolvió un token reconocible.');
  }
  return context.cache.sofseToken;
}

export async function collect({ provider, line, context, checkedAt }) {
  const authorization = await token(provider, context, checkedAt);
  const responses = [];
  for (const stationId of [...new Set(line.external.stationIds || [])]) {
    const cacheKey = `sofse:${stationId}`;
    if (!context.cache[cacheKey]) context.cache[cacheKey] = fetchJson(`${provider.baseUrl}/arribos/estacion/${stationId}`, { headers: { Authorization: authorization } });
    const body = await context.cache[cacheKey];
    if (!Array.isArray(body?.results)) throw new Error(`Respuesta SOFSE inválida para estación ${stationId}.`);
    responses.push(body);
  }
  return normalizeSofseResponses(responses, line, checkedAt);
}
