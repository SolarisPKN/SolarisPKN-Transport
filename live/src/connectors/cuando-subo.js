import { fetchJson } from './http.js';
import { normalizeVehicle } from '../schema.js';

const timestamp = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString();
};

export function normalizeOneBusAway(body, line, checkedAt = new Date(), providerId = 'cuando-subo') {
  const trips = new Map((body?.data?.references?.trips || []).map((trip) => [trip.id, trip]));
  const routes = new Set((line.external.routeIds || []).map(String));
  const vehicles = [];
  for (const entry of body?.data?.list || []) {
    const trip = trips.get(entry.tripId);
    if (!trip || (routes.size && !routes.has(String(trip.routeId)))) continue;
    const gps = entry.location;
    const estimate = entry.tripStatus?.position;
    const position = Number.isFinite(gps?.lat) && Number.isFinite(gps?.lon) ? gps : estimate;
    const sourceTimestamp = timestamp(entry.lastLocationUpdateTime) || timestamp(entry.lastUpdateTime);
    vehicles.push(normalizeVehicle({
      provider: providerId, mode: line.mode, routeId: line.id, branchId: line.branchId, branchName: line.name,
      tripId: entry.tripId, vehicleId: entry.vehicleId || entry.id, directionId: trip.directionId,
      destination: trip.tripHeadsign, lat: position?.lat, lon: position?.lon,
      bearing: entry.tripStatus?.orientation, observedAt: sourceTimestamp,
      positionSource: position && position === gps ? 'gps' : position ? 'provider-estimated' : undefined,
      nextStop: entry.tripStatus?.nextStop, stopSequence: entry.tripStatus?.nextStopSequence,
      phase: entry.tripStatus?.phase === 'layover' ? 'stopped' : position ? 'in_transit' : 'unknown',
      status: entry.status === 'CANCELLED' ? 'cancelled' : position ? 'in_progress' : 'confirmed',
      checkedAt: checkedAt.toISOString(), sourceTimestamp, realtimeAvailable: Boolean(position),
    }));
  }
  return { vehicles, alerts: [], sourceTimestamp: vehicles.map((vehicle) => vehicle.sourceTimestamp).sort().at(-1) };
}

export async function collect({ provider, line, context, checkedAt, env }) {
  const secretName = provider.credentialEnv || 'CUANDO_SUBO_API_KEY';
  const apiKey = env?.[secretName];
  if (!apiKey) throw new Error(`Falta el secreto ${secretName}.`);
  const agencies = [...new Set((line.external.routeIds || []).map((routeId) => String(routeId).split('_')[0]))];
  const bodies = [];
  for (const agency of agencies) {
    const key = `cuando-subo:${agency}`;
    if (!context.cache[key]) context.cache[key] = fetchJson(`${provider.baseUrl}/vehicles-for-agency/${agency}.json`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const body = await context.cache[key];
    if (!Array.isArray(body?.data?.list)) throw new Error(`Respuesta Cuándo SUBO inválida para agencia ${agency}.`);
    bodies.push(body);
  }
  const normalized = bodies.map((body) => normalizeOneBusAway(body, line, checkedAt, provider.id));
  return {
    vehicles: normalized.flatMap((item) => item.vehicles),
    alerts: normalized.flatMap((item) => item.alerts),
    sourceTimestamp: normalized.map((item) => item.sourceTimestamp).filter(Boolean).sort().at(-1),
  };
}
