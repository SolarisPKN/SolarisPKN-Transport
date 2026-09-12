import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { fetchWithTimeout } from './http.js';
import { normalizeAlert, normalizeVehicle } from '../schema.js';

const timestamp = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString();
};

function relationship(value) {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

function statusFrom(entity, update) {
  const relation = relationship(entity?.trip?.scheduleRelationship ?? update?.trip?.scheduleRelationship);
  if (relation === 'CANCELED' || relation === 3) return 'cancelled';
  const stopRelation = relationship(update?.stopTimeUpdate?.find((stop) => relationship(stop?.scheduleRelationship) === 'SKIPPED' || stop?.scheduleRelationship === 1)?.scheduleRelationship);
  if (stopRelation === 'SKIPPED' || stopRelation === 1) return 'skipped_stop';
  const delay = Number(update?.delay ?? update?.stopTimeUpdate?.find((stop) => Number.isFinite(Number(stop?.arrival?.delay ?? stop?.departure?.delay)))?.arrival?.delay);
  if (Number.isFinite(delay) && delay >= 180) return 'delayed';
  if (Number.isFinite(delay) && delay <= -180) return 'early';
  return entity?.position ? 'in_progress' : update ? 'confirmed' : 'unknown';
}

function phaseFrom(value) {
  const current = typeof value === 'string' ? value.toUpperCase() : value;
  if (current === 'STOPPED_AT' || current === 1) return 'stopped';
  if (current === 'IN_TRANSIT_TO' || current === 2) return 'in_transit';
  if (current === 'INCOMING_AT' || current === 0) return 'incoming';
  return 'unknown';
}

function translatedText(value) {
  return value?.translation?.find((entry) => entry?.text)?.text;
}

export function normalizeGtfsRealtimeFeed(feed, line, checkedAt = new Date(), providerId = 'gtfs-realtime') {
  const entities = feed?.entity || [];
  const updates = new Map(entities.filter((entity) => entity.tripUpdate?.trip?.tripId).map((entity) => [entity.tripUpdate.trip.tripId, entity.tripUpdate]));
  const allowedRouteIds = new Set((line.external.routeIds || []).map(String));
  const allowed = (trip) => allowedRouteIds.size === 0 || allowedRouteIds.has(String(trip?.routeId));
  const sourceTimestamp = timestamp(feed?.header?.timestamp);
  const vehicles = [];
  for (const entity of entities) {
    const vehicle = entity.vehicle;
    const trip = vehicle?.trip;
    if (!vehicle || !allowed(trip)) continue;
    const update = updates.get(trip?.tripId);
    const next = update?.stopTimeUpdate?.find((stop) => String(stop.stopSequence) === String(vehicle.currentStopSequence))
      || update?.stopTimeUpdate?.[0];
    const delaySeconds = Number(next?.arrival?.delay ?? next?.departure?.delay ?? update?.delay);
    vehicles.push(normalizeVehicle({
      provider: providerId, mode: line.mode, routeId: line.id, branchId: line.branchId, branchName: line.name,
      tripId: trip?.tripId, vehicleId: vehicle.vehicle?.id || entity.id, serviceNumber: trip?.tripId,
      directionId: trip?.directionId, destination: vehicle.vehicle?.label,
      lat: vehicle.position?.latitude, lon: vehicle.position?.longitude, bearing: vehicle.position?.bearing,
      speedKmh: Number.isFinite(Number(vehicle.position?.speed)) ? Number(vehicle.position.speed) * 3.6 : undefined,
      speedSource: vehicle.position?.speed !== undefined ? 'provider' : undefined,
      observedAt: timestamp(vehicle.timestamp) || sourceTimestamp, positionSource: vehicle.position ? 'gps' : undefined,
      nextStop: vehicle.stopId || next?.stopId, stopSequence: vehicle.currentStopSequence,
      phase: phaseFrom(vehicle.currentStatus), status: statusFrom(vehicle, update),
      estimatedArrival: timestamp(next?.arrival?.time), estimatedDeparture: timestamp(next?.departure?.time),
      delaySeconds: Number.isFinite(delaySeconds) ? delaySeconds : undefined,
      checkedAt: checkedAt.toISOString(), sourceTimestamp, realtimeAvailable: true,
    }));
  }
  for (const entity of entities) {
    const update = entity.tripUpdate;
    if (!update || !allowed(update.trip)) continue;
    if (vehicles.some((vehicle) => vehicle.tripId === update.trip?.tripId)) continue;
    const next = update.stopTimeUpdate?.[0];
    const delaySeconds = Number(next?.arrival?.delay ?? next?.departure?.delay ?? update.delay);
    vehicles.push(normalizeVehicle({
      provider: providerId, mode: line.mode, routeId: line.id, branchId: line.branchId, branchName: line.name,
      tripId: update.trip?.tripId, serviceNumber: update.trip?.tripId, directionId: update.trip?.directionId,
      nextStop: next?.stopId, stopSequence: next?.stopSequence, phase: 'unknown', status: statusFrom(null, update),
      estimatedArrival: timestamp(next?.arrival?.time), estimatedDeparture: timestamp(next?.departure?.time),
      delaySeconds: Number.isFinite(delaySeconds) ? delaySeconds : undefined,
      checkedAt: checkedAt.toISOString(), sourceTimestamp, realtimeAvailable: true,
    }));
  }
  const alerts = entities.flatMap((entity) => {
    if (!entity.alert) return [];
    const informed = entity.alert.informedEntity || [];
    if (allowedRouteIds.size && !informed.some((item) => allowedRouteIds.has(String(item.routeId)))) return [];
    const alert = normalizeAlert({
      alertId: entity.id, provider: providerId, routeId: line.id,
      message: translatedText(entity.alert.headerText) || translatedText(entity.alert.descriptionText),
      effect: entity.alert.effect, severity: entity.alert.severityLevel,
      validFrom: timestamp(entity.alert.activePeriod?.[0]?.start), validUntil: timestamp(entity.alert.activePeriod?.[0]?.end),
    });
    return alert ? [alert] : [];
  });
  return { vehicles, alerts, sourceTimestamp };
}

export async function collect({ provider, line, checkedAt, env }) {
  const feedId = line.external.feedId;
  const feed = (provider.feeds || []).find((candidate) => candidate.id === feedId && candidate.enabled !== false);
  if (!feed?.url) throw new Error(`La línea ${line.id} no tiene un feed GTFS-Realtime habilitado.`);
  const headers = {};
  if (feed.authHeader && feed.authEnv) {
    const value = env?.[feed.authEnv];
    if (!value) throw new Error(`Falta ${feed.authEnv} para ${feed.id}.`);
    headers[feed.authHeader] = value;
  }
  const bytes = new Uint8Array(await (await fetchWithTimeout(feed.url, { headers })).arrayBuffer());
  const decoded = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  return normalizeGtfsRealtimeFeed(decoded, line, checkedAt, provider.id);
}
