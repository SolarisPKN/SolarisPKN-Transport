const EARTH_RADIUS_METERS = 6_371_000;

export function decodePolyline(encoded, precision = 6) {
  const coordinates = [];
  const factor = 10 ** precision;
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < encoded.length) {
    const decodeValue = () => {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      return result & 1 ? ~(result >> 1) : result >> 1;
    };
    latitude += decodeValue();
    longitude += decodeValue();
    coordinates.push([longitude / factor, latitude / factor]);
  }
  return coordinates;
}

function orientedSegment(config, segmentId, reverse = false) {
  const coordinates = decodePolyline(config.segments[segmentId].polyline6);
  return reverse ? coordinates.reverse() : coordinates;
}

export function pathCoordinates(config, path) {
  const coordinates = [];
  for (const [segmentId, reverse] of path) {
    const segment = orientedSegment(config, segmentId, reverse);
    if (coordinates.length && segment.length) segment.shift();
    coordinates.push(...segment);
  }
  return coordinates;
}

export function route136MapFeatures(config) {
  const route = {
    type: 'Feature',
    properties: {
      id: config.network.id,
      name: config.network.name,
      mode: 'bus',
      routeId: config.network.id,
      lineKey: '136-villars',
    },
    geometry: {
      type: 'MultiLineString',
      coordinates: config.network.segments.map((segmentId) => orientedSegment(config, segmentId)),
    },
  };
  const stops = Object.entries(config.points).map(([id, point]) => ({
    type: 'Feature',
    properties: {
      id: `136-${id}`,
      name: point.name,
      mode: 'bus',
      routeId: config.network.id,
      lineKey: '136-villars',
    },
    geometry: { type: 'Point', coordinates: point.coordinates },
  }));
  return { route, stops };
}

function radians(value) {
  return value * Math.PI / 180;
}

function distanceMeters(left, right) {
  const lat1 = radians(left[1]);
  const lat2 = radians(right[1]);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(right[0] - left[0]);
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function pointAlongPath(coordinates, progress) {
  if (!coordinates.length) return null;
  if (coordinates.length === 1) return coordinates[0];
  const lengths = [];
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const length = distanceMeters(coordinates[index - 1], coordinates[index]);
    lengths.push(length);
    total += length;
  }
  let remaining = Math.min(1, Math.max(0, progress)) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining > length) {
      remaining -= length;
      continue;
    }
    const ratio = length > 0 ? remaining / length : 0;
    const from = coordinates[index];
    const to = coordinates[index + 1];
    return [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio];
  }
  return coordinates.at(-1);
}

function argentinaClock(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return {
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function normalizedLabel(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const previousWeekday = {
  Mon: 'sunday', Tue: 'weekday', Wed: 'weekday', Thu: 'weekday',
  Fri: 'weekday', Sat: 'weekday', Sun: 'saturday',
};

function dayKeyForClock(weekday) {
  if (weekday === 'Sat') return 'saturday';
  if (weekday === 'Sun') return 'sunday';
  return 'weekday';
}

export function estimateTimetableVehicles(route, stopFeatures, date = new Date()) {
  if (!route?.lineKey || !Array.isArray(route.schedules)) return [];
  const aliases = new Map([
    ['a ferrari', 'agustin ferrari'],
    ['maquinista r cal', 'maquinista ricardo cal'],
    ['hornos', 'general hornos'],
    ['las heras', 'general las heras'],
  ]);
  const coordinates = new Map((stopFeatures || []).map((feature) => {
    const key = normalizedLabel(feature?.properties?.name);
    return [aliases.get(key) || key, feature?.geometry?.coordinates];
  }));
  const coordinateFor = (name) => {
    const key = normalizedLabel(name);
    return coordinates.get(key) || coordinates.get(aliases.get(key));
  };
  const clock = argentinaClock(date);
  const contexts = [
    { dayKey: dayKeyForClock(clock.weekday), minutes: clock.minutes },
    { dayKey: previousWeekday[clock.weekday], minutes: clock.minutes + 1440 },
  ];
  const vehicles = [];
  for (const context of contexts) {
    for (const grid of route.schedules.filter(({ day }) => day?.key === context.dayKey)) {
      for (const service of grid.services || []) {
        const stops = (service.stops || [])
          .map((stop) => ({ ...stop, coordinates: coordinateFor(stop.station) }))
          .filter(({ coordinates, minutes }) => Array.isArray(coordinates) && coordinates.length === 2 && Number.isFinite(minutes))
          .sort((left, right) => left.minutes - right.minutes);
        if (stops.length < 2 || context.minutes < stops[0].minutes || context.minutes > stops.at(-1).minutes) continue;
        const index = stops.findIndex((stop, stopIndex) => stopIndex > 0 && context.minutes <= stop.minutes);
        if (index < 1) continue;
        const from = stops[index - 1];
        const to = stops[index];
        const duration = Math.max(1, to.minutes - from.minutes);
        const progress = Math.min(1, Math.max(0, (context.minutes - from.minutes) / duration));
        const coordinate = [
          from.coordinates[0] + (to.coordinates[0] - from.coordinates[0]) * progress,
          from.coordinates[1] + (to.coordinates[1] - from.coordinates[1]) * progress,
        ];
        vehicles.push({
          provider: 'published-schedule',
          mode: route.type || 'bus',
          routeId: `schedule-${route.lineKey}`,
          lineKey: route.lineKey,
          tripId: `${route.id}:${grid.id}:${service.id}`,
          vehicleId: `${route.type === 'train' ? 'train' : 'bus'}-estimated:${route.lineKey}:${grid.id}:${service.id}`,
          label: `${route.lineLabel || route.branch || route.name} · ${service.name}`,
          lat: coordinate[1],
          lon: coordinate[0],
          bearing: null,
          updatedAt: date.toISOString(),
          positionKind: 'predicted',
          fromStop: from.station,
          toStop: to.station,
          scheduledArrivalAt: new Date(date.getTime() + (to.minutes - context.minutes) * 60_000).toISOString(),
          stale: false,
        });
      }
    }
  }
  return vehicles;
}

export function estimateScheduled136(config, date = new Date()) {
  const clock = argentinaClock(date);
  const isWeekend = clock.weekday === 'Sat' || clock.weekday === 'Sun';
  const vehicles = [];
  for (const pattern of config.patterns) {
    const departures = isWeekend ? pattern.weekendDepartures : pattern.weekdayDepartures;
    for (const departure of departures) {
      const elapsed = clock.minutes - departure;
      if (elapsed < 0 || elapsed > pattern.durationMinutes) continue;
      const coordinate = pointAlongPath(pathCoordinates(config, pattern.path), elapsed / pattern.durationMinutes);
      if (!coordinate) continue;
      vehicles.push({
        provider: 'published-schedule',
        mode: 'bus',
        routeId: pattern.id,
        tripId: `${pattern.id}:${departure}`,
        vehicleId: `bus-estimated:${pattern.id}:${departure}`,
        label: pattern.label,
        lat: coordinate[1],
        lon: coordinate[0],
        bearing: null,
        updatedAt: date.toISOString(),
        positionKind: 'predicted',
        fromStop: config.points[pattern.from].name,
        toStop: config.points[pattern.to].name,
        scheduledArrivalAt: new Date(date.getTime() + (pattern.durationMinutes - elapsed) * 60_000).toISOString(),
        stale: false,
      });
    }
  }
  return vehicles;
}
