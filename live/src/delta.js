import { vehicleIdentity } from './schema.js';

const EARTH_RADIUS_METERS = 6_371_000;
const radians = (degrees) => degrees * Math.PI / 180;

export function distanceMeters(a, b) {
  if (![a?.lat, a?.lon, b?.lat, b?.lon].every((value) => Number.isFinite(Number(value)))) return Infinity;
  const lat1 = radians(Number(a.lat));
  const lat2 = radians(Number(b.lat));
  const dLat = lat2 - lat1;
  const dLon = radians(Number(b.lon) - Number(a.lon));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const progress = (v) => ({ previousStop: v.previousStop, currentStop: v.currentStop, nextStop: v.nextStop, stopSequence: v.stopSequence, phase: v.phase });
const timing = (v) => ({ scheduledArrival: v.scheduledArrival, estimatedArrival: v.estimatedArrival, realArrival: v.realArrival, scheduledDeparture: v.scheduledDeparture, estimatedDeparture: v.estimatedDeparture, realDeparture: v.realDeparture });

export function vehicleDelta(previous, next, toleranceMeters, at) {
  const identity = vehicleIdentity(next);
  if (!previous) return { type: 'change', identity, changedAt: at, value: next };
  const changes = {};
  const moved = distanceMeters(previous, next) > toleranceMeters
    || (Number.isFinite(next.lat) !== Number.isFinite(previous.lat));
  if (moved) changes.position = { lat: next.lat, lon: next.lon, observedAt: next.observedAt, positionSource: next.positionSource };
  for (const [key, value] of Object.entries({
    status: next.status,
    delay: { delaySeconds: next.delaySeconds, scheduleDeviation: next.scheduleDeviation },
    progress: progress(next),
    timing: timing(next),
    motion: { speedKmh: next.speedKmh, speedSource: next.speedSource, bearing: next.bearing },
    stale: next.stale,
  })) {
    const oldValue = key === 'delay' ? { delaySeconds: previous.delaySeconds, scheduleDeviation: previous.scheduleDeviation }
      : key === 'progress' ? progress(previous)
      : key === 'timing' ? timing(previous)
      : key === 'motion' ? { speedKmh: previous.speedKmh, speedSource: previous.speedSource, bearing: previous.bearing }
      : previous[key];
    if (!same(oldValue, value)) changes[key] = value;
  }
  return Object.keys(changes).length
    ? { type: 'change', identity, changedAt: at, changes }
    : { type: 'confirmation', identity, confirmedAt: at, changeRef: previous.changedAt || null };
}

export function buildDeltas(previousVehicles, nextVehicles, { mode, toleranceMeters, at }) {
  const previous = new Map(previousVehicles.map((vehicle) => [vehicleIdentity(vehicle), vehicle]));
  const nextIds = new Set();
  const events = nextVehicles.map((vehicle) => {
    const identity = vehicleIdentity(vehicle);
    nextIds.add(identity);
    return vehicleDelta(previous.get(identity), vehicle, toleranceMeters, at);
  });
  for (const [identity, vehicle] of previous) {
    if (!nextIds.has(identity)) events.push({ type: 'not_observed', identity, confirmedAt: at, changeRef: vehicle.changedAt || null });
  }
  return { schemaVersion: 2, mode, generatedAt: at, events };
}

export function buildAlertDeltas(previousAlerts, nextAlerts, at) {
  const previous = new Map(previousAlerts.map((alert) => [alert.alertId, alert]));
  const next = new Map(nextAlerts.map((alert) => [alert.alertId, alert]));
  const events = [];
  for (const [alertId, alert] of next) {
    const old = previous.get(alertId);
    if (!old) events.push({ type: 'added', alertId, changedAt: at, value: alert });
    else if (!same(old, alert)) events.push({ type: 'changed', alertId, changedAt: at, value: alert });
  }
  for (const alertId of previous.keys()) {
    if (!next.has(alertId)) events.push({ type: 'cleared', alertId, changedAt: at });
  }
  return events;
}

export function applyObservationTimes(previousVehicles, nextVehicles, toleranceMeters, at) {
  const previous = new Map(previousVehicles.map((vehicle) => [vehicleIdentity(vehicle), vehicle]));
  return nextVehicles.map((vehicle) => {
    const old = previous.get(vehicleIdentity(vehicle));
    const event = vehicleDelta(old, vehicle, toleranceMeters, at);
    return {
      ...vehicle,
      changedAt: event.type === 'change' ? at : old?.changedAt || at,
      confirmedAt: at,
    };
  });
}
