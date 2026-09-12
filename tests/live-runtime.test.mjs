import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryForScheduledTime, collectCategory, historyKey, refreshLive } from '../live/src/runtime.js';
import { buildAlertDeltas, buildDeltas, distanceMeters } from '../live/src/delta.js';
import { normalizeSofseResponses } from '../live/src/connectors/sofse.js';
import { normalizeGtfsRealtimeFeed } from '../live/src/connectors/gtfs-realtime.js';
import { normalizeOneBusAway } from '../live/src/connectors/cuando-subo.js';

const baseConfig = {
  schemaVersion: 1,
  deployment: { cron: '*/2 * * * *', currentKey: 'current.json', allowedOrigins: [] },
  quality: { staleAfterSeconds: 600, positionToleranceMeters: { train: 8, bus: 12 } },
  providers: [
    { id: 'primary', module: 'primary', enabled: true },
    { id: 'fallback', module: 'fallback', enabled: true },
    { id: 'disabled', module: 'disabled', enabled: false },
  ],
  lines: [{ id: 'line', name: 'Line', mode: 'train', enabled: true, connectors: [
    { provider: 'primary', priority: 1 }, { provider: 'disabled', priority: 2 }, { provider: 'fallback', priority: 3 },
  ] }],
};

test('cron alterna train y bus usando scheduledTime UTC', () => {
  assert.equal(categoryForScheduledTime(Date.UTC(2026, 8, 11, 20, 0)), 'train');
  assert.equal(categoryForScheduledTime(Date.UTC(2026, 8, 11, 20, 2)), 'bus');
  assert.equal(categoryForScheduledTime(Date.UTC(2026, 8, 11, 20, 4)), 'train');
});

test('disabled no hace fetch y fallback sólo corre si primary no sirve', async () => {
  const calls = [];
  const registry = new Map([
    ['primary', { collect: async () => { calls.push('primary'); return { vehicles: [], alerts: [] }; } }],
    ['disabled', { collect: async () => { calls.push('disabled'); throw new Error('no'); } }],
    ['fallback', { collect: async ({ checkedAt }) => { calls.push('fallback'); return { vehicles: [{ provider: 'x', mode: 'train', routeId: 'line', status: 'confirmed' }], alerts: [], sourceTimestamp: checkedAt.toISOString() }; } }],
  ]);
  const result = await collectCategory(baseConfig, 'train', {}, new Date('2026-09-11T20:00:00Z'), registry);
  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.vehicles.length, 1);
});

test('fallback no se consulta cuando primary funciona', async () => {
  const calls = [];
  const registry = new Map([
    ['primary', { collect: async ({ checkedAt }) => { calls.push('primary'); return { vehicles: [{ provider: 'x', mode: 'train', routeId: 'line' }], alerts: [], sourceTimestamp: checkedAt.toISOString() }; } }],
    ['fallback', { collect: async () => { calls.push('fallback'); return { vehicles: [], alerts: [] }; } }],
  ]);
  await collectCategory(baseConfig, 'train', {}, new Date('2026-09-11T20:00:00Z'), registry);
  assert.deepEqual(calls, ['primary']);
});

test('deltas respetan tolerancia y detectan status/delay sin movimiento', () => {
  const previous = [{ provider: 'p', mode: 'train', routeId: 'r', vehicleId: '1', lat: -34.8, lon: -58.9, status: 'confirmed', delaySeconds: 0, changedAt: 'old' }];
  const near = [{ ...previous[0], lat: -34.80001 }];
  assert.ok(distanceMeters(previous[0], near[0]) < 8);
  assert.equal(buildDeltas(previous, near, { mode: 'train', toleranceMeters: 8, at: 'now' }).events[0].type, 'confirmation');
  const far = [{ ...previous[0], lat: -34.801 }];
  assert.ok(buildDeltas(previous, far, { mode: 'train', toleranceMeters: 8, at: 'now' }).events[0].changes.position);
  assert.ok(buildDeltas(previous, [{ ...previous[0], status: 'delayed' }], { mode: 'train', toleranceMeters: 8, at: 'now' }).events[0].changes.status);
  assert.ok(buildDeltas(previous, [{ ...previous[0], delaySeconds: 480 }], { mode: 'train', toleranceMeters: 8, at: 'now' }).events[0].changes.delay);
});

test('alertas sólo generan delta al aparecer, cambiar o desaparecer', () => {
  const alert = { alertId: 'a', message: 'Demora', routeId: 'line' };
  assert.equal(buildAlertDeltas([alert], [alert], 'now').length, 0);
  assert.equal(buildAlertDeltas([], [alert], 'now')[0].type, 'added');
  assert.equal(buildAlertDeltas([alert], [{ ...alert, message: 'Cancelado' }], 'now')[0].type, 'changed');
  assert.equal(buildAlertDeltas([alert], [], 'now')[0].type, 'cleared');
});

test('SOFSE sólo cancela con evidencia explícita y no inventa GPS', () => {
  const line = { id: 'r', mode: 'train', name: 'R', external: { branchId: 67 } };
  const service = { ramal: { id: 67 }, numero: '1', estaciones: [], leyenda: '' };
  const normal = normalizeSofseResponses([{ results: [{ servicio: service }] }], line, new Date('2026-09-11T20:00:00Z')).vehicles[0];
  assert.equal(normal.status, 'unknown');
  assert.equal(normal.lat, undefined);
  const cancelled = normalizeSofseResponses([{ results: [{ servicio: { ...service, leyenda: 'Servicio cancelado' } }] }], line, new Date('2026-09-11T20:00:00Z')).vehicles[0];
  assert.equal(cancelled.status, 'cancelled');
});

test('GTFS-Realtime normaliza GPS, demora y cancelación', () => {
  const line = { id: 'bus', mode: 'bus', name: 'Bus', external: { routeIds: ['R'] } };
  const feed = { header: { timestamp: 1789156800 }, entity: [
    { id: 'v', vehicle: { trip: { tripId: 't', routeId: 'R', directionId: 0 }, vehicle: { id: '7' }, position: { latitude: -34.8, longitude: -58.9, speed: 10 }, timestamp: 1789156800 } },
    { id: 'u', tripUpdate: { trip: { tripId: 'cancel', routeId: 'R', scheduleRelationship: 'CANCELED' }, stopTimeUpdate: [] } },
  ] };
  const result = normalizeGtfsRealtimeFeed(feed, line, new Date('2026-09-11T20:00:00Z'));
  assert.equal(result.vehicles[0].positionSource, 'gps');
  assert.equal(result.vehicles[0].speedKmh, 36);
  assert.equal(result.vehicles.find((v) => v.tripId === 'cancel').status, 'cancelled');
});

test('Cuándo SUBO no inventa GPS ni sourceTimestamp cuando faltan', () => {
  const line = { id: 'bus', mode: 'bus', external: { routeIds: ['R'] } };
  const body = { data: { references: { trips: [{ id: 't', routeId: 'R' }] }, list: [{ id: 'v', tripId: 't', tripStatus: {} }] } };
  const vehicle = normalizeOneBusAway(body, line, new Date('2026-09-11T20:00:00Z')).vehicles[0];
  assert.equal(vehicle.positionSource, undefined);
  assert.equal(vehicle.sourceTimestamp, undefined);
  assert.equal(vehicle.realtimeAvailable, false);
  assert.notEqual(vehicle.status, 'cancelled');
});

test('current conserva el grupo no actualizado y crea un history', async () => {
  const objects = new Map([['current.json', { schemaVersion: 2, updatedAt: 'old', trains: { checkedAt: null, sourceTimestamp: null, status: 'unavailable', vehicles: [], alerts: [] }, buses: { checkedAt: 'old', sourceTimestamp: 'old', status: 'ok', vehicles: [{ provider: 'b', mode: 'bus', routeId: 'b' }], alerts: [] } }]]);
  const puts = [];
  const env = { TRANSPORT_LIVE: { get: async (key) => objects.get(key), put: async (key, value) => { puts.push(key); objects.set(key, JSON.parse(value)); } } };
  const registry = new Map([['primary', { collect: async ({ checkedAt }) => ({ vehicles: [{ provider: 'p', mode: 'train', routeId: 'line', status: 'confirmed' }], alerts: [], sourceTimestamp: checkedAt.toISOString() }) }]]);
  const at = Date.UTC(2026, 8, 11, 20, 0);
  const result = await refreshLive(env, at, baseConfig, registry);
  assert.equal(result.current.buses.vehicles.length, 1);
  assert.deepEqual(puts, [historyKey(at, 'train'), 'current.json']);
});

test('una línea fallida conserva sólo su último estado como stale', async () => {
  const config = { ...baseConfig, lines: [
    baseConfig.lines[0],
    { id: 'line-2', name: 'Line 2', mode: 'train', enabled: true, connectors: [{ provider: 'primary', priority: 1 }] },
  ] };
  const old = {
    schemaVersion: 2,
    updatedAt: '2026-09-11T19:56:00Z',
    trains: { checkedAt: '2026-09-11T19:56:00Z', sourceTimestamp: null, status: 'ok', vehicles: [
      { provider: 'p', mode: 'train', routeId: 'line', vehicleId: 'old-1', status: 'confirmed' },
      { provider: 'p', mode: 'train', routeId: 'line-2', vehicleId: 'old-2', status: 'confirmed' },
    ], alerts: [{ alertId: 'old-alert', message: 'Aviso', routeId: 'line-2' }] },
    buses: { checkedAt: null, sourceTimestamp: null, status: 'unavailable', vehicles: [], alerts: [] },
  };
  const objects = new Map([['current.json', old]]);
  const env = { TRANSPORT_LIVE: { get: async (key) => objects.get(key), put: async (key, value) => objects.set(key, JSON.parse(value)) } };
  const registry = new Map([['primary', { collect: async ({ line, checkedAt }) => {
    if (line.id === 'line-2') throw new Error('provider down');
    return { vehicles: [{ provider: 'p', mode: 'train', routeId: 'line', vehicleId: 'new-1', status: 'confirmed' }], alerts: [], sourceTimestamp: checkedAt.toISOString() };
  } }]]);
  const result = await refreshLive(env, Date.UTC(2026, 8, 11, 20, 0), config, registry);
  assert.equal(result.current.trains.status, 'degraded');
  assert.equal(result.current.trains.vehicles.find((v) => v.routeId === 'line-2').stale, true);
  assert.equal(result.current.trains.vehicles.some((v) => v.vehicleId === 'old-1'), false);
  assert.equal(result.current.trains.alerts[0].alertId, 'old-alert');
});
