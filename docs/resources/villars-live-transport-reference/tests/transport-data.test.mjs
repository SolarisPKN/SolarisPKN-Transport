import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { bytesToHeader } from 'pmtiles';
import { departuresFor, destinationsFrom, directionsFor, nextService, nextServiceForRoute, scheduleServiceKey, stationScheduleGrid, upcomingServicesForDirection } from '../src/utils/transport-services.js';
import { estimateTimetableVehicles } from '../src/utils/transport-route-model.js';

const data = JSON.parse(await readFile(new URL('../src/data/transport-schedules.json', import.meta.url), 'utf8'));
const mapData = JSON.parse(await readFile(new URL('../src/data/transport-map.json', import.meta.url), 'utf8'));
const villarsRoutes = data.routes.filter((route) => route.schedules.some((schedule) => schedule.stations.some((station) => station.normalizedName === 'villars')));

test('el snapshot tiene procedencia verificable y estructura estable', () => {
  assert.equal(data.schemaVersion, 2); assert.equal(data.timezone, 'America/Argentina/Buenos_Aires');
  assert.match(data.source.databaseSha256, /^[a-f0-9]{64}$/); assert.equal(data.stats.routes, data.routes.length);
  assert.ok(data.stats.schedules > 0); assert.ok(data.stats.times > 0);
});
test('Villars cuenta con recorridos reales de colectivo y tren', () => {
  assert.ok(villarsRoutes.some((route) => route.type === 'bus')); assert.ok(villarsRoutes.some((route) => route.type === 'train'));
});
test('Merlo–Lobos y 136 Rápido conservan estaciones, sentidos y alcance completo', async () => {
  const sarmiento = data.routes.find(({ lineKey }) => lineKey === 'sarmiento-merlo-lobos');
  const rapid136 = data.routes.find(({ lineKey }) => lineKey === '136-rapido');
  assert.ok(sarmiento); assert.ok(rapid136);
  assert.equal(sarmiento.stationContract.length, 13);
  assert.deepEqual(sarmiento.stationContract.slice(-4), ['Speratti', 'Zapiola', 'Empalme Lobos', 'Lobos']);
  assert.deepEqual(directionsFor(sarmiento).map(({ key }) => key), ['Las Heras', 'Merlo']);
  assert.equal(stationScheduleGrid(sarmiento, 'weekday', 'Las Heras').stations.length, 13);
  assert.equal(stationScheduleGrid(sarmiento, 'weekday', 'Las Heras').stations.filter(({ outsidePublishedService }) => outsidePublishedService).length, 4);
  assert.deepEqual(directionsFor(rapid136).map(({ key }) => key), ['Navarro', 'Primera Junta']);
  assert.equal(stationScheduleGrid(rapid136, 'weekday', 'Navarro').stations.length, 23);

  const bytes = await readFile(new URL('../public/maps/villars-region.pmtiles', import.meta.url));
  const header = bytesToHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(header.minLon <= -59.32 && header.minLat <= -35.22);
  assert.ok(header.maxLon >= -58.38 && header.maxLat >= -34.48);
  assert.equal(header.maxZoom, 14);
});
test('días, paradas y minutos de cada grilla son válidos', () => {
  const dayKeys = new Set(['weekday', 'saturday', 'sunday']);
  for (const route of data.routes) for (const schedule of route.schedules) {
    assert.ok(dayKeys.has(schedule.day.key)); assert.ok(schedule.direction);
    for (const station of schedule.stations) { assert.ok(station.name); assert.ok(station.times.every((minutes) => Number.isInteger(minutes) && minutes >= 0)); assert.equal(new Set(station.times).size, station.times.length); }
    for (const service of schedule.services) {
      assert.ok(service.name); assert.ok(service.stops.length > 0);
      assert.equal(service.origin, service.stops[0].station); assert.equal(service.destination, service.stops.at(-1).station);
      assert.ok(service.stops.every((stop) => Number.isInteger(stop.minutes) && stop.minutes >= 0));
    }
  }
});
test('el formato conserva servicios posteriores a medianoche', () => {
  assert.ok(data.routes.some((route) => route.schedules.some((schedule) => schedule.stations.some((station) => station.times.some((minutes) => minutes >= 1440)))));
});
test('Lozano no se ofrece en días hábiles y el próximo tren real es el sábado', () => {
  const train = villarsRoutes.find((route) => route.type === 'train' && destinationsFrom(route).includes('Lozano'));
  assert.ok(train);
  assert.deepEqual(departuresFor(train, 'weekday', 'Lozano'), []);
  assert.deepEqual(departuresFor(train, 'saturday', 'Lozano').map(({ minutes }) => minutes), [628, 985]);
  assert.deepEqual(departuresFor(train, 'sunday', 'Lozano').map(({ minutes }) => minutes), [633, 994]);
  const next = nextService(train, 'Lozano', data.timezone, new Date('2026-08-25T15:00:00Z'));
  assert.equal(next.weekday, 6); assert.equal(next.date, '29/8'); assert.equal(next.minutes, 628);
});

test('las grillas ordenan todas las estaciones por sentido y cada formación ocupa una fila', () => {
  const bus = villarsRoutes.find((route) => route.type === 'bus' && destinationsFrom(route).includes('Luján'));
  const train = villarsRoutes.find((route) => route.type === 'train' && destinationsFrom(route).includes('Lozano'));
  assert.ok(bus); assert.ok(train);
  assert.deepEqual(directionsFor(bus).map(({ key }) => key), ['Luján', 'Marcos Paz']);
  assert.deepEqual(directionsFor(train).map(({ key }) => key), ['González Catán', 'Lozano']);

  const busWeekday = stationScheduleGrid(bus, 'weekday', 'Luján');
  assert.deepEqual(busWeekday.stations.map(({ name }) => name), ['Marcos Paz', 'Las Heras', 'Villars', 'Plomer', 'Luján']);
  assert.equal(busWeekday.services.length, 3);
  assert.equal(busWeekday.stations.find(({ normalizedName }) => normalizedName === 'villars').stops[0].minutes, 360);

  const trainWeekday = stationScheduleGrid(train, 'weekday', 'Lozano');
  assert.deepEqual(trainWeekday.stations.map(({ name }) => name), ['González Catán', '20 de Junio', 'Marcos Paz', 'Villars', 'Lozano']);
  assert.equal(trainWeekday.services.length, 6);
  assert.ok(trainWeekday.services.every(({ destination }) => destination !== 'Lozano'));
  assert.ok(trainWeekday.stations.find(({ normalizedName }) => normalizedName === 'lozano').stops.every((stop) => stop === null));
  assert.equal(stationScheduleGrid(train, 'saturday', 'Lozano').stations.find(({ normalizedName }) => normalizedName === 'lozano').stops.filter(Boolean).length, 2);

  for (const day of ['weekday', 'saturday', 'sunday']) {
    for (const { key } of directionsFor(bus)) assert.ok(stationScheduleGrid(bus, day, key).stations.length > 0);
    for (const { key } of directionsFor(train)) assert.ok(stationScheduleGrid(train, day, key).stations.length > 0);
  }

  const next = nextServiceForRoute(bus, data.timezone, new Date('2026-08-25T08:00:00Z'));
  assert.equal(next.destination, 'Luján');
  assert.equal(next.minutes, 360);
});
test('se identifican de forma estable las dos próximas formaciones por Villars', () => {
  const bus = villarsRoutes.find((route) => route.type === 'bus' && destinationsFrom(route).includes('Luján'));
  assert.ok(bus);
  const upcoming = upcomingServicesForDirection(bus, 'Luján', data.timezone, new Date('2026-08-25T08:00:00Z'));
  assert.equal(upcoming.length, 2);
  assert.deepEqual(upcoming.map(({ stop }) => stop.minutes), [360, 600]);
  assert.deepEqual(upcoming.map(({ difference }) => difference), [60, 300]);
  assert.equal(upcoming[0].key, scheduleServiceKey('weekday', 'Luján', upcoming[0].service));
  assert.notEqual(upcoming[0].key, upcoming[1].key);
});
test('el mapa ofrece filtros separados y presenta la 136 como corredor local estimado', async () => {
  const [page, script, scheduleScript] = await Promise.all([
    readFile(new URL('../src/pages/transporte.astro', import.meta.url), 'utf8'),
    readFile(new URL('../src/scripts/transport-map.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/scripts/transport.js', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /data-direction-select/);
  assert.match(page, /grid\.services\.map/);
  assert.match(page, /formation-column/);
  assert.match(page, /data-map-mode="train"/);
  assert.match(page, /data-map-layer="positions"/);
  assert.match(page, /data-map-layer="routes"/);
  assert.match(page, /data-map-layer="stops"/);
  assert.match(page, /data-map-route="sarmiento-merlo-lobos" checked/);
  assert.match(page, /data-map-route="136-rapido" checked/);
  assert.match(page, /data-map-route="136-villars" checked/);
  assert.match(page, /no entrega coordenadas autorizadas/);
  assert.match(page, /data-map-route="322-lujan" checked/);
  assert.match(page, /data-map-route="322-canuelas" checked/);
  assert.match(script, /route136MapFeatures/);
  assert.match(script, /function vehicleMarkerIcon/);
  assert.match(script, /is-estimated/);
  assert.match(page, /transport-vehicle-pin/);
  assert.match(scheduleScript, /upcomingServicesForDirection/);
  assert.match(scheduleScript, /next-service-row/);
  assert.match(scheduleScript, /following-service-row/);
  assert.match(script, /function renderFilteredLayers/);
  assert.match(script, /currentLiveFeatures\.filter/);
});

test('el mapa y el estimador cubren por separado 322 Luján y 322 Cañuelas', () => {
  for (const lineKey of ['322-lujan', '322-canuelas']) {
    const route = data.routes.find((candidate) => candidate.lineKey === lineKey);
    assert.ok(route, `falta el cronograma ${lineKey}`);
    const mapRoutes = mapData.routes.features.filter(({ properties }) => properties?.lineKey === lineKey);
    const mapStops = mapData.stops.features.filter(({ properties }) => properties?.lineKey === lineKey);
    assert.equal(mapRoutes.length, 2);
    assert.ok(mapStops.length >= (lineKey === '322-lujan' ? 5 : 3));
    const grid = route.schedules.find(({ day }) => day.key === 'weekday');
    const service = grid.services[0];
    const first = service.stops[0].minutes;
    const last = service.stops.at(-1).minutes;
    const minute = Math.floor((first + last) / 2);
    const localDate = new Date(Date.UTC(2026, 7, 25, Math.floor(minute / 60) + 3, minute % 60));
    const estimates = estimateTimetableVehicles(route, mapStops, localDate);
    assert.ok(estimates.some(({ lineKey: family }) => family === lineKey));
  }
});
test('el corredor 136 Villars expone E, F, G, H e I y distingue horarios estimados', async () => {
  const local136 = data.routes.filter(({ lineKey }) => lineKey === '136-villars');
  assert.deepEqual(
    local136.map(({ lineLabel }) => lineLabel).sort((left, right) => left.localeCompare(right, 'es')),
    [
      '136 E · Marcos Paz–Villars',
      '136 F · Marcos Paz–Plomer',
      '136 G · Plomer - Villars - Las Heras - Marcos Paz',
      '136 H · Villars–Las Heras',
      '136 I · Plomer–Las Heras',
    ].sort((left, right) => left.localeCompare(right, 'es')),
  );
  for (const route of local136.filter(({ lineLabel }) => !lineLabel.startsWith('136 G'))) {
    assert.equal(directionsFor(route).length, 2);
    assert.ok(route.schedules.every(({ updateMethod }) => updateMethod === 'Estimado'));
    assert.ok(route.schedules.every(({ stations }) => stations.length >= 20));
    assert.deepEqual(new Set(route.schedules.map(({ day }) => day.key)), new Set(['weekday', 'saturday', 'sunday']));
  }
  const reverseF = local136.find(({ name }) => name.startsWith('136 F'));
  assert.ok(reverseF.schedules.some(({ direction }) => direction === 'Estación Marcos Paz'));

  const config = JSON.parse(await readFile(new URL('../src/data/transport-136-villars.json', import.meta.url), 'utf8'));
  const reversePattern = config.patterns.find(({ id }) => id === '136-f-marcos-paz');
  assert.deepEqual(reversePattern.weekdayDepartures, [1220, 1375]);
  assert.deepEqual(reversePattern.weekendDepartures, [755, 1190]);
});
test('el modo móvil pagina formaciones y conserva todas las estaciones en filas', async () => {
  const [page, scheduleScript] = await Promise.all([
    readFile(new URL('../src/pages/transporte.astro', import.meta.url), 'utf8'),
    readFile(new URL('../src/scripts/transport.js', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /data-mobile-schedule/);
  assert.match(page, /data-mobile-previous/);
  assert.match(page, /data-mobile-next/);
  assert.match(page, /mobile-service-card/);
  assert.match(page, /mobile-no-services/);
  assert.match(page, /\.schedule-table-scroll\) \{ display: none; \}/);
  assert.match(page, /\.mobile-schedule\) \{ display: block; \}/);
  assert.match(scheduleScript, /function createMobileSchedule/);
  assert.match(scheduleScript, /currentIndex \+ 1/);
  assert.match(scheduleScript, /grid\.stations\.forEach/);
  assert.match(scheduleScript, /villars-stop/);
  assert.match(scheduleScript, /aria-controls/);
  assert.match(scheduleScript, /next-service-card/);
  assert.match(scheduleScript, /following-service-card/);
});
