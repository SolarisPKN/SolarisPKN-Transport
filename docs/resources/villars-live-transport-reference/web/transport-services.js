export const serviceDays = ['sunday', 'weekday', 'weekday', 'weekday', 'weekday', 'weekday', 'saturday'];
export const weekdayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function formatMinutes(minutes) {
  const clock = minutes % 1440;
  return {
    value: `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`,
    nextDay: minutes >= 1440,
  };
}

export function normalizeStationName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function argentinaNow(timezone, date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  const indices = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: indices[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function villarsDeparture(service, destination, stationName = 'villars') {
  if (service.destination !== destination) return undefined;
  const index = service.stops.findIndex((stop) => stop.normalizedStation === stationName);
  if (index < 0 || index >= service.stops.length - 1) return undefined;
  return service.stops[index];
}

export function destinationsFrom(route, stationName = 'villars') {
  const destinations = new Set();
  for (const schedule of route.schedules) {
    for (const service of schedule.services || []) {
      if (villarsDeparture(service, service.destination, stationName)) destinations.add(service.destination);
    }
  }
  return [...destinations].sort((left, right) => left.localeCompare(right, 'es'));
}

export function departuresFor(route, dayKey, destination, stationName = 'villars') {
  const departures = [];
  for (const schedule of route.schedules.filter((item) => item.day.key === dayKey)) {
    for (const service of schedule.services || []) {
      const stop = villarsDeparture(service, destination, stationName);
      if (stop) departures.push({ minutes: stop.minutes, schedule, service });
    }
  }
  return departures.sort((left, right) => left.minutes - right.minutes);
}

export function directionsFor(route) {
  const directions = new Map();
  for (const schedule of route.schedules || []) {
    if (!directions.has(schedule.direction)) {
      directions.set(schedule.direction, {
        key: schedule.direction,
        label: `Hacia ${schedule.direction}`,
      });
    }
  }
  return [...directions.values()];
}

export function stationScheduleGrid(route, dayKey, direction) {
  const schedules = (route.schedules || []).filter((schedule) => (
    schedule.day.key === dayKey && schedule.direction === direction
  ));
  const servicesById = new Map();
  const stationsByName = new Map();

  for (const schedule of schedules) {
    for (const station of schedule.stations || []) {
      const current = stationsByName.get(station.normalizedName);
      if (!current || station.order < current.order) stationsByName.set(station.normalizedName, station);
    }
    for (const service of schedule.services || []) {
      const key = service.id ?? `${service.name}:${service.origin}:${service.destination}`;
      if (!servicesById.has(key)) servicesById.set(key, service);
    }
  }

  const services = [...servicesById.values()].sort((left, right) => (
    (left.order ?? 0) - (right.order ?? 0)
    || (left.stops?.[0]?.minutes ?? 0) - (right.stops?.[0]?.minutes ?? 0)
  ));
  const observedStations = [...stationsByName.values()]
    .sort((left, right) => left.order - right.order)
    .map((station) => ({
      ...station,
      stops: services.map((service) => (
        service.stops.find((stop) => stop.normalizedStation === station.normalizedName) || null
      )),
    }));

  const contract = Array.isArray(route.stationContract) ? route.stationContract : [];
  const contractOrder = normalizeStationName(direction) === normalizeStationName(contract[0])
    ? [...contract].reverse()
    : contract;
  const observedByName = new Map(observedStations.map((station) => [normalizeStationName(station.name), station]));
  const stations = contractOrder.length
    ? contractOrder.map((name, order) => {
      const observed = observedByName.get(normalizeStationName(name));
      return observed
        ? { ...observed, order, outsidePublishedService: false }
        : {
          name,
          normalizedName: normalizeStationName(name),
          order,
          times: [],
          stops: services.map(() => null),
          outsidePublishedService: true,
        };
    })
    : observedStations;

  return { direction, services, stations };
}


export function scheduleServiceKey(dayKey, direction, service) {
  return `${dayKey}:${direction}:${service.id ?? `${service.name}:${service.origin}:${service.destination}`}`;
}

export function upcomingServicesForDirection(route, direction, timezone, date = new Date(), stationName = 'villars', limit = 2) {
  const now = argentinaNow(timezone, date);
  const occurrences = [];

  for (let offset = -1; offset <= 7; offset += 1) {
    const serviceWeekday = (now.weekday + offset + 7) % 7;
    const dayKey = serviceDays[serviceWeekday];
    const grid = stationScheduleGrid(route, dayKey, direction);
    for (const service of grid.services) {
      const stop = service.stops.find((item) => item.normalizedStation === stationName);
      if (!stop) continue;
      const difference = offset * 1440 + stop.minutes - now.minutes;
      if (difference < 0) continue;
      const nextDayOffset = Math.floor(stop.minutes / 1440);
      const calendarDate = new Date(`${now.date}T12:00:00Z`);
      calendarDate.setUTCDate(calendarDate.getUTCDate() + offset + nextDayOffset);
      occurrences.push({
        key: scheduleServiceKey(dayKey, direction, service),
        dayKey,
        service,
        stop,
        difference,
        weekday: (serviceWeekday + nextDayOffset) % 7,
        date: calendarDate.toLocaleDateString('es-AR', { day: 'numeric', month: 'numeric', timeZone: 'UTC' }),
      });
    }
  }

  const selected = [];
  const selectedKeys = new Set();
  for (const occurrence of occurrences.sort((left, right) => left.difference - right.difference)) {
    if (selectedKeys.has(occurrence.key)) continue;
    selected.push(occurrence);
    selectedKeys.add(occurrence.key);
    if (selected.length >= limit) break;
  }
  return selected;
}
export function nextService(route, destination, timezone, date = new Date(), stationName = 'villars') {
  const now = argentinaNow(timezone, date);
  let closest;
  for (let offset = -1; offset <= 7; offset += 1) {
    const serviceWeekday = (now.weekday + offset + 7) % 7;
    const dayKey = serviceDays[serviceWeekday];
    for (const departure of departuresFor(route, dayKey, destination, stationName)) {
      const difference = offset * 1440 + departure.minutes - now.minutes;
      if (difference < 0 || (closest && difference >= closest.difference)) continue;
      const nextDayOffset = Math.floor(departure.minutes / 1440);
      const calendarDate = new Date(`${now.date}T12:00:00Z`);
      calendarDate.setUTCDate(calendarDate.getUTCDate() + offset + nextDayOffset);
      closest = {
        ...departure,
        difference,
        weekday: (serviceWeekday + nextDayOffset) % 7,
        date: calendarDate.toLocaleDateString('es-AR', { day: 'numeric', month: 'numeric', timeZone: 'UTC' }),
      };
    }
  }
  return closest;
}

export function nextServiceForRoute(route, timezone, date = new Date(), stationName = 'villars') {
  return destinationsFrom(route, stationName)
    .map((destination) => {
      const service = nextService(route, destination, timezone, date, stationName);
      return service ? { ...service, destination } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.difference - right.difference)[0] || null;
}
