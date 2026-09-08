import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeBusSnapshot,
  normalizeTrainServiceStatuses,
  normalizeTrainSnapshots,
  refreshTransport,
} from '../workers/transport-live/src/index.js';
import route136Config from '../src/data/transport-136-villars.json' with { type: 'json' };
import transportMap from '../src/data/transport-map.json' with { type: 'json' };
import transportSchedules from '../src/data/transport-schedules.json' with { type: 'json' };
import { estimateScheduled136, estimateTimetableVehicles, route136MapFeatures } from '../src/utils/transport-route-model.js';

const workerConfig = JSON.parse(await readFile(new URL('../workers/transport-live/wrangler.jsonc', import.meta.url), 'utf8'));
const spanishReadme = await readFile(new URL('../README.es.md', import.meta.url), 'utf8');

const providerBody = {
  data: {
    references: {
      trips: [
        { id: 'trip-villars', routeId: '135_1623' },
        { id: 'trip-canuelas', routeId: '135_1625' },
        { id: 'trip-rapido', routeId: '739_670' },
        { id: 'trip-other', routeId: '135_9999' },
      ],
    },
    list: [
      {
        id: 'vehicle-entry', vehicleId: 'bus-322', tripId: 'trip-villars',
        location: { lat: -34.8285, lon: -58.9387 }, lastLocationUpdateTime: 1_787_666_340_000,
        tripStatus: { position: { lat: -34.8, lon: -58.9 }, orientation: 120 },
      },
      {
        id: 'vehicle-canuelas', vehicleId: 'bus-322-canuelas', tripId: 'trip-canuelas',
        location: { lat: -34.95, lon: -58.88 }, lastLocationUpdateTime: 1_787_666_340_000,
        tripStatus: { orientation: 160 },
      },
      {
        id: 'vehicle-rapido', vehicleId: 'bus-136-rapido', tripId: 'trip-rapido',
        location: { lat: -34.79, lon: -58.84 }, lastLocationUpdateTime: 1_787_666_340_000,
        tripStatus: { orientation: 210 },
      },
      { id: 'ignored', tripId: 'trip-other', location: { lat: -34, lon: -58 } },
    ],
  },
};

test('la 136 local conserva la T y sólo publica posiciones estimadas por horario', () => {
  const features = route136MapFeatures(route136Config);
  assert.equal(features.route.geometry.type, 'MultiLineString');
  assert.equal(features.route.geometry.coordinates.length, 4);
  assert.deepEqual(features.stops.map(({ properties }) => properties.name), [
    'Estación Marcos Paz', 'Zamudio · RP 40 y RP 6', 'Estación Villars',
    'Estación Plomer', 'General Hornos', 'Terminal Las Heras',
  ]);

  const vehicles = estimateScheduled136(route136Config, new Date('2026-08-31T16:30:00.000Z'));
  assert.ok(vehicles.some(({ routeId }) => routeId === '136-g-marcos-paz-las-heras'));
  assert.ok(vehicles.every(({ provider, positionKind, lat, lon }) => (
    provider === 'published-schedule'
    && positionKind === 'predicted'
    && Number.isFinite(lat)
    && Number.isFinite(lon)
  )));
});

test('la 136 Rápido estima unidades activas desde la grilla completa sin presentarlas como GPS', () => {
  const route = transportSchedules.routes.find(({ lineKey }) => lineKey === '136-rapido');
  const stops = transportMap.stops.features.filter(({ properties }) => properties?.lineKey === '136-rapido');
  const weekdayGrid = route.schedules.find(({ day, direction }) => day.key === 'weekday' && direction === 'Navarro');
  const service = weekdayGrid.services[0];
  const start = service.stops[0].minutes;
  const end = service.stops.at(-1).minutes;
  const minute = Math.floor((start + end) / 2);
  const localDate = new Date(Date.UTC(2026, 7, 31, Math.floor(minute / 60) + 3, minute % 60));
  const vehicles = estimateTimetableVehicles(route, stops, localDate);
  const vehicle = vehicles.find(({ tripId }) => tripId.endsWith(`:${service.id}`));
  assert.ok(vehicle);
  assert.equal(vehicle.routeId, 'schedule-136-rapido');
  assert.equal(vehicle.lineKey, '136-rapido');
  assert.equal(vehicle.positionKind, 'predicted');
  assert.equal(vehicle.provider, 'published-schedule');
  assert.ok(Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lon));
});

test('el despliegue conserva cron y binding, no declara secretos y documenta procedencia', () => {
  assert.deepEqual(workerConfig.triggers?.crons, ['* * * * *']);
  assert.deepEqual(workerConfig.r2_buckets, [{
    binding: 'TRANSPORT_LIVE',
    bucket_name: 'villars-transport-live',
  }]);
  assert.doesNotMatch(JSON.stringify(workerConfig), /CUANDO_SUBO_API_KEY|secret/i);
  assert.match(spanishReadme, /© OpenStreetMap contributors/);
  assert.match(spanishReadme, /transcripción manual/);
  assert.match(spanishReadme, /No se usa una API privada de Moovit ni scraping automatizado/);
});

test('el Worker limita Cuándo SUBO a 322 Luján, 322 Cañuelas y 136 Rápido', () => {
  const vehicles = normalizeBusSnapshot(providerBody, new Date('2026-08-25T12:00:00Z'));
  assert.equal(vehicles.length, 3);
  assert.deepEqual(new Set(vehicles.map(({ lineKey }) => lineKey)), new Set(['322-lujan', '322-canuelas', '136-rapido']));
  assert.equal(new Set(vehicles.map(({ vehicleId }) => vehicleId)).size, 3);
  assert.ok(vehicles.every(({ vehicleId }) => /^bus:(135_162[35]|739_670):/.test(vehicleId)));
  assert.ok(vehicles.every(({ positionKind, stale }) => positionKind === 'observed' && stale === false));
});

test('el Worker limita SOFSE a Belgrano Sur y Sarmiento Merlo–Lobos', () => {
  const responses = [{
    timestamp: 1_787_666_400,
    results: [
      {
        servicio: {
          id: 'train-villars', numero: 9001, sentido: 1,
          ramal: { id: 67 }, hasta: { estacion: { nombre: 'Villars' } },
          location: { lat: -34.827, long: -58.94 },
        },
      },
      {
        servicio: {
          id: 'train-other', numero: 3146, sentido: 2,
          ramal: { id: 25 }, location: { lat: -34.6, long: -58.4 },
        },
      },
    ],
  }];

  const vehicles = normalizeTrainSnapshots(responses, new Date('2026-08-25T12:00:00Z'));
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].vehicleId, 'train:train-villars');
  assert.equal(vehicles[0].routeId, 'sofse-67');
  assert.match(vehicles[0].label, /Villars/);
});

test('SOFSE conserva un tren activo de 20 de Junio a Catán aunque no informe GPS', () => {
  const responses = [{
    results: [{
      servicio: {
        id: null,
        numero: 5010,
        sentido: 2,
        ramal: { id: 67 },
        hasta: { estacion: { nombre: 'González Catán' } },
        location: null,
        estaciones: [
          {
            idElemento: 526,
            nombre: '20 de Junio',
            llegada: { programada: '2026-08-27T21:32:00.000Z' },
            salida: { real: '2026-08-27T21:33:00.000Z' },
          },
          {
            idElemento: 154,
            nombre: 'González Catán',
            llegada: { estimada: '2026-08-27T21:53:00.000Z' },
            salida: { programada: '2026-08-27T21:55:00.000Z' },
          },
        ],
      },
    }],
  }];

  const vehicles = normalizeTrainSnapshots(responses, new Date('2026-08-27T21:50:00.000Z'));
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].vehicleId, 'train:67:5010:2:2026-08-27');
  assert.equal(vehicles[0].positionKind, 'predicted');
  assert.equal(vehicles[0].fromStop, '20 de Junio');
  assert.equal(vehicles[0].toStop, 'González Catán');
  assert.equal(vehicles[0].scheduledArrivalAt, '2026-08-27T21:53:00.000Z');
  assert.ok(vehicles[0].lat > -34.781 && vehicles[0].lat < -34.771);
  assert.ok(vehicles[0].lon > -58.739 && vehicles[0].lon < -58.646);

  const finished = normalizeTrainSnapshots(responses, new Date('2026-08-27T22:10:00.000Z'));
  assert.equal(finished.length, 0);
});

test('SOFSE distingue programado, confirmado, en curso, demorado y cancelado sin inferir cancelación por ausencia', () => {
  const baseService = {
    numero: 5010,
    sentido: 2,
    ramal: { id: 67 },
    hasta: { estacion: { nombre: 'González Catán' } },
    tipo: { nombre: 'Normal' },
    estaciones: [
      { idElemento: 3700, nombre: 'Marcos Paz', salida: { programada: '2026-09-01T21:10:00.000Z' } },
      { idElemento: 526, nombre: '20 de Junio', llegada: { programada: '2026-09-01T21:33:00.000Z' }, salida: { programada: '2026-09-01T21:34:00.000Z' } },
      { idElemento: 154, nombre: 'González Catán', llegada: { programada: '2026-09-01T21:53:00.000Z' } },
    ],
  };
  const at = new Date('2026-09-01T21:43:00.000Z');
  const scheduled = normalizeTrainServiceStatuses([{ results: [{ servicio: baseService }] }], at)[0];
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.evidence, 'published-schedule');

  const confirmedService = structuredClone(baseService);
  confirmedService.estaciones[2].llegada.estimada = '2026-09-01T21:55:00.000Z';
  const inProgress = normalizeTrainServiceStatuses([{ results: [{ servicio: confirmedService }] }], at)[0];
  assert.equal(inProgress.status, 'in_progress');
  assert.equal(inProgress.evidence, 'estimated-time');

  const beforeDeparture = normalizeTrainServiceStatuses([{ results: [{ servicio: confirmedService }] }], new Date('2026-09-01T21:00:00.000Z'))[0];
  assert.equal(beforeDeparture.status, 'confirmed');

  const delayedService = structuredClone(baseService);
  delayedService.estaciones[2].llegada.estimada = '2026-09-01T22:00:00.000Z';
  const delayed = normalizeTrainServiceStatuses([{ results: [{ servicio: delayedService }] }], at)[0];
  assert.equal(delayed.status, 'delayed');
  assert.equal(delayed.delayMinutes, 7);
  assert.equal(delayed.message, 'Demora informada de 7 minutos');

  const cancelledService = structuredClone(baseService);
  cancelledService.leyenda = 'Servicio cancelado';
  const cancelled = normalizeTrainServiceStatuses([{ results: [{ servicio: cancelledService }] }], at)[0];
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.message, /cancelado/i);
});

test('un 200 vacío de SOFSE conserva el 5010 como estimación de grilla entre 20 de Junio y Catán', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/auth/authorize')) return Response.json({ token: 'test-sofse-token' });
    if (target.includes('/arribos/estacion/')) return Response.json({ timestamp: 1_788_287_380, results: [] });
    throw new Error(`URL inesperada: ${target}`);
  };
  let snapshot;
  try {
    snapshot = await refreshTransport({
      TRANSPORT_LIVE: {
        get: async () => null,
        put: async (_key, value) => { snapshot = JSON.parse(value); },
      },
    }, new Date('2026-09-01T21:43:00.000Z'), { bridgeCollector: async () => [] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const train = snapshot.vehicles.find(({ provider, label }) => provider === 'published-schedule' && /5010/.test(label));
  assert.ok(train);
  assert.equal(train.mode, 'train');
  assert.equal(train.lineKey, 'belgrano-sur');
  assert.equal(train.positionKind, 'predicted');
  assert.equal(train.fromStop, '20 de Junio');
  assert.equal(train.toStop, 'González Catán');
  assert.match(train.vehicleId, /^train-estimated:/);
});

test('el GPS de SOFSE reemplaza sólo la estimación de la misma formación', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/auth/authorize')) return Response.json({ token: 'test-sofse-token' });
    if (target.endsWith('/arribos/estacion/154')) {
      return Response.json({
        results: [{
          servicio: {
            id: 'sofse-5010', numero: 5010, sentido: 2,
            ramal: { id: 67 }, hasta: { estacion: { nombre: 'González Catán' } },
            location: { lat: -34.776, long: -58.704 },
          },
        }],
      });
    }
    if (target.includes('/arribos/estacion/')) return Response.json({ results: [] });
    throw new Error(`URL inesperada: ${target}`);
  };
  let snapshot;
  try {
    snapshot = await refreshTransport({
      TRANSPORT_LIVE: {
        get: async () => null,
        put: async (_key, value) => { snapshot = JSON.parse(value); },
      },
    }, new Date('2026-09-01T21:43:00.000Z'), { bridgeCollector: async () => [] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const matching = snapshot.vehicles.filter(({ label }) => /5010/.test(label));
  assert.equal(matching.length, 1);
  assert.equal(matching[0].provider, 'sofse');
  assert.equal(matching[0].positionKind, 'observed');
});

test('el Worker consulta por endpoint simple todas las estaciones operativas de ambos ramales', async () => {
  const queried = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/auth/authorize')) return Response.json({ token: 'test-sofse-token' });
    if (target.includes('/arribos/estacion/')) {
      queried.push(target);
      return Response.json({ results: [] });
    }
    throw new Error('URL inesperada: ' + target);
  };
  try {
    await refreshTransport({
      TRANSPORT_LIVE: { get: async () => null, put: async () => {} },
    }, new Date('2026-08-27T21:50:00.000Z'));

    assert.equal(queried.length, 14);
    const bareStations = queried
      .map((value) => new URL(value))
      .filter(({ search }) => search === '')
      .map(({ pathname }) => Number(pathname.split('/').at(-1)))
      .sort((left, right) => left - right);
    assert.deepEqual(bareStations, [137, 154, 173, 225, 254, 257, 269, 432, 464, 526, 3700, 4226, 4601, 6000]);
    assert.ok(queried.every((value) => new URL(value).search === ''));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('el snapshot R2 consolida colectivo y tren sin persistir credenciales', async () => {
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('vehicles-for-agency')) {
      assert.equal(options.headers.Authorization, 'Bearer test-cuando-subo-key');
      return Response.json(providerBody);
    }
    if (target.endsWith('/auth/authorize')) return Response.json({ token: 'test-sofse-token' });
    if (target.includes('/arribos/estacion/154')) {
      assert.equal(options.headers.Authorization, 'test-sofse-token');
      return Response.json({
        timestamp: 1_787_666_400,
        results: [{
          servicio: {
            id: 'train-villars', numero: 9001, sentido: 1,
            ramal: { id: 67 }, hasta: { estacion: { nombre: 'Villars' } },
            location: { lat: -34.827, long: -58.94 },
          },
        }],
      });
    }
    if (target.includes('/arribos/estacion/')) return Response.json({ timestamp: 1_787_666_400, results: [] });
    throw new Error(`URL inesperada: ${target}`);
  };
  try {
    const snapshot = await refreshTransport({
      CUANDO_SUBO_API_KEY: 'test-cuando-subo-key',
      TRANSPORT_LIVE: {
        get: async () => null,
        put: async (...args) => writes.push(args),
      },
    }, new Date('2026-08-25T12:00:00Z'));
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.providers['cuando-subo'].status, 'ok');
    assert.equal(snapshot.providers['cuando-subo'].failedAgencies, 0);
    assert.equal(snapshot.providers.sofse.status, 'ok');
    assert.equal(snapshot.providers['cuando-subo'].lastSuccessfulAt, snapshot.generatedAt);
    assert.equal(snapshot.providers.sofse.lastSuccessfulAt, snapshot.generatedAt);
    assert.equal(snapshot.discardAfter, '2026-08-25T12:10:00.000Z');
    assert.equal(snapshot.providers['published-schedule'].status, 'estimated');
    assert.ok(snapshot.vehicles.length >= 2);
    assert.ok(snapshot.vehicles.some(({ provider }) => provider === 'published-schedule'));
    assert.ok(snapshot.vehicles.some(({ lineKey }) => lineKey === '322-canuelas'));
    assert.doesNotMatch(JSON.stringify(snapshot), /test-cuando-subo-key|test-sofse-token/);
    assert.equal(writes.length, 1); assert.equal(writes[0][0], 'current.json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un fallo de una agencia de Cuándo SUBO no borra la otra', async () => {
  const originalFetch = globalThis.fetch;
  const agency135Body = structuredClone(providerBody);
  agency135Body.data.references.trips = agency135Body.data.references.trips
    .filter(({ routeId }) => routeId.startsWith('135_'));
  const allowedTrips = new Set(agency135Body.data.references.trips.map(({ id }) => id));
  agency135Body.data.list = agency135Body.data.list.filter(({ tripId }) => allowedTrips.has(tripId));
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/vehicles-for-agency/135.json')) return Response.json(agency135Body);
    if (target.includes('/vehicles-for-agency/739.json')) return new Response('unavailable', { status: 503 });
    if (target.endsWith('/auth/authorize')) return Response.json({ token: 'test-sofse-token' });
    if (target.includes('/arribos/estacion/')) return Response.json({ timestamp: 1_787_666_400, results: [] });
    throw new Error(`URL inesperada: ${target}`);
  };
  try {
    const snapshot = await refreshTransport({
      CUANDO_SUBO_API_KEY: 'test-cuando-subo-key',
      TRANSPORT_LIVE: { get: async () => null, put: async () => {} },
    }, new Date('2026-08-25T12:00:00Z'));
    const observedBuses = snapshot.vehicles.filter(({ provider }) => provider === 'cuando-subo');
    assert.equal(snapshot.status, 'degraded');
    assert.equal(snapshot.providers['cuando-subo'].status, 'degraded');
    assert.equal(snapshot.providers['cuando-subo'].failedAgencies, 1);
    assert.deepEqual(new Set(observedBuses.map(({ lineKey }) => lineKey)), new Set(['322-lujan', '322-canuelas']));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SOFSE conserva dos formaciones Catán–Lozano y cuatro Merlo–Lobos simultáneas', () => {
  const services = [
    { id: 'belgrano-5009', numero: 5009, sentido: 2, ramal: { id: 67 }, hasta: { estacion: { nombre: 'González Catán' } }, location: { lat: -34.77, long: -58.65 } },
    { id: 'belgrano-5011', numero: 5011, sentido: 1, ramal: { id: 67 }, hasta: { estacion: { nombre: 'Marcos Paz' } }, location: { lat: -34.78, long: -58.75 } },
    { id: 'sarmiento-2110', numero: 2110, sentido: 1, ramal: { id: 53 }, hasta: { estacion: { nombre: 'Las Heras' } }, location: { lat: -34.80, long: -58.85 } },
    { id: 'sarmiento-2111', numero: 2111, sentido: 2, ramal: { id: 53 }, hasta: { estacion: { nombre: 'Merlo' } }, location: { lat: -34.87, long: -58.90 } },
    { id: 'sarmiento-2112', numero: 2112, sentido: 1, ramal: { id: 53 }, hasta: { estacion: { nombre: 'Lobos' } }, location: { lat: -34.91, long: -58.95 } },
    { id: 'sarmiento-2113', numero: 2113, sentido: 2, ramal: { id: 53 }, hasta: { estacion: { nombre: 'Merlo' } }, location: { lat: -34.73, long: -58.79 } },
  ];
  const vehicles = normalizeTrainSnapshots([{ timestamp: 1_788_287_380, results: services.map((servicio) => ({ servicio })) }], new Date('2026-09-02T20:04:00.000Z'));
  assert.equal(vehicles.length, 6);
  assert.deepEqual(new Set(vehicles.map(({ routeId }) => routeId)), new Set(['sofse-67', 'sofse-53']));
  assert.equal(vehicles.filter(({ routeId }) => routeId === 'sofse-67').length, 2);
  assert.equal(vehicles.filter(({ routeId }) => routeId === 'sofse-53').length, 4);
  assert.equal(new Set(vehicles.map(({ vehicleId }) => vehicleId)).size, 6);
});

test('una respuesta detallada sin GPS no pisa la posición observada del mismo servicio', () => {
  const observed = {
    id: 'sarmiento-2110', numero: 2110, sentido: 1, ramal: { id: 53 },
    hasta: { estacion: { nombre: 'Las Heras' } },
    location: { lat: -34.80, long: -58.85 },
  };
  const detailed = {
    ...observed,
    location: null,
    estaciones: [
      { idElemento: 254, nombre: 'Marcos Paz', salida: { programada: '2026-09-02T20:00:00.000Z' } },
      { idElemento: 225, nombre: 'Las Heras', llegada: { programada: '2026-09-02T20:30:00.000Z' } },
    ],
  };
  const vehicles = normalizeTrainSnapshots([
    { timestamp: 1_788_287_380, results: [{ servicio: observed }] },
    { timestamp: 1_788_287_381, results: [{ servicio: detailed }] },
  ], new Date('2026-09-02T20:10:00.000Z'));
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].positionKind, 'observed');
  assert.equal(vehicles[0].lat, -34.80);
  assert.equal(vehicles[0].lon, -58.85);
});

test('SOFSE publica una formación activa de Sarmiento con su routeId propio', () => {
  const responses = [{
    timestamp: 1_787_666_400,
    results: [{
      servicio: {
        id: 'sarmiento-1001', numero: 1001, sentido: 1,
        ramal: { id: 53 }, hasta: { estacion: { nombre: 'Las Heras' } },
        location: { lat: -34.80, long: -58.85 },
      },
    }],
  }];
  const vehicles = normalizeTrainSnapshots(responses, new Date('2026-08-25T12:00:00Z'));
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].routeId, 'sofse-53');
  assert.equal(vehicles[0].vehicleId, 'train:sarmiento-1001');
  assert.match(vehicles[0].label, /Las Heras/);
});

test('una respuesta 200 con esquema inválido no se confunde con cero unidades', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('vehicles-for-agency')) return Response.json({ data: {} });
    if (target.endsWith('/auth/authorize')) return Response.json({ token: 'test-sofse-token' });
    if (target.includes('/arribos/estacion/')) return Response.json({ timestamp: 1_787_666_400, results: [] });
    throw new Error(`URL inesperada: ${target}`);
  };
  try {
    const snapshot = await refreshTransport({
      CUANDO_SUBO_API_KEY: 'test-cuando-subo-key',
      TRANSPORT_LIVE: {
        get: async () => ({
          providers: { 'cuando-subo': { lastSuccessfulAt: '2026-08-25T11:59:00.000Z' } },
          vehicles: [{ provider: 'cuando-subo', vehicleId: 'bus:anterior', lat: -34.8, lon: -58.9 }],
        }),
        put: async () => {},
      },
    }, new Date('2026-08-25T12:00:00Z'));
    assert.equal(snapshot.status, 'degraded');
    assert.equal(snapshot.providers['cuando-subo'].status, 'error');
    assert.equal(snapshot.providers['cuando-subo'].lastSuccessfulAt, '2026-08-25T11:59:00.000Z');
    assert.equal(snapshot.vehicles[0].stale, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SOFSE puede operar solo sin consultar Cuándo SUBO ni inventar un error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    assert.doesNotMatch(target, /vehicles-for-agency/);
    if (target.endsWith('/auth/authorize')) return Response.json({ token: 'test-sofse-token' });
    if (target.includes('/arribos/estacion/')) return Response.json({ timestamp: 1_787_666_400, results: [] });
    throw new Error(`URL inesperada: ${target}`);
  };
  try {
    const snapshot = await refreshTransport({
      TRANSPORT_LIVE: { get: async () => null, put: async () => {} },
    }, new Date('2026-08-25T12:00:00Z'));
    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.providers['cuando-subo'].status, 'disabled');
    assert.equal(snapshot.providers.sofse.status, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un fallo del estimador 136 queda aislado y no interrumpe SOFSE ni la escritura R2', async () => {
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/auth/authorize')) return Response.json({ token: 'test-sofse-token' });
    if (target.includes('/arribos/estacion/')) return Response.json({ timestamp: 1_788_195_600, results: [] });
    throw new Error(`URL inesperada: ${target}`);
  };
  try {
    const snapshot = await refreshTransport({
      TRANSPORT_LIVE: {
        get: async () => null,
        put: async (...args) => writes.push(args),
      },
    }, new Date('2026-08-31T18:00:00.000Z'), {
      scheduleCollector: () => { throw new Error('tabla 136 inválida'); },
    });
    assert.equal(snapshot.status, 'degraded');
    assert.equal(snapshot.providers.sofse.status, 'ok');
    assert.equal(snapshot.providers['published-schedule'].status, 'error');
    assert.match(snapshot.providers['published-schedule'].message, /tabla 136 inválida/);
    assert.equal(snapshot.vehicles.some(({ provider }) => provider === 'published-schedule'), false);
    assert.equal(writes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
