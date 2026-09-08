import transportData from '../data/transport-schedules.json';
import { directionsFor, formatMinutes, normalizeStationName, scheduleServiceKey, stationScheduleGrid, upcomingServicesForDirection, weekdayNames } from '../utils/transport-services.js';
import { operationalStatusForService } from '../utils/transport-operational-status.js';

const scheduleDays = [
  { key: 'weekday', label: 'Lunes a viernes' },
  { key: 'saturday', label: 'Sábados' },
  { key: 'sunday', label: 'Domingos' },
];
let controller;
let refreshTimer;
let liveSnapshot;
const transportRoutes = transportData.routes
  .filter((route) => route.schedules.length > 0)
  .sort((left, right) => (left.type === right.type ? (left.lineLabel || left.branch).localeCompare(right.lineLabel || right.branch, 'es') : left.type === 'train' ? -1 : 1));

function formattedTime(minutes) {
  const formatted = formatMinutes(minutes);
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(formatted.value));
  if (formatted.nextDay) {
    const note = document.createElement('small');
    note.textContent = '+1 día';
    fragment.append(note);
  }
  return fragment;
}

function waitLabel(minutes) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  return `${days ? `${days} d ` : ''}${hours ? `${hours} h ` : ''}${remainingMinutes} min`;
}

function statusBadge(status) {
  if (!status) return null;
  const badge = document.createElement('span');
  badge.className = `service-status service-status-${status.state}`;
  badge.textContent = status.label;
  if (status.record?.message) badge.title = status.record.message;
  return badge;
}

function createMobileSchedule(route, grid, day, direction, highlights) {
  const mobile = document.createElement('div');
  mobile.className = 'mobile-schedule';
  mobile.dataset.mobileSchedule = '';
  mobile.setAttribute('role', 'region');
  mobile.setAttribute('aria-label', `Formaciones de ${day.label}, hacia ${direction}`);

  if (grid.services.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'mobile-no-services';
    empty.textContent = 'No hay servicios informados para este día y sentido.';
    mobile.append(empty);
    return mobile;
  }

  const controls = document.createElement('div');
  controls.className = 'mobile-schedule-controls';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.dataset.mobilePrevious = '';
  previous.innerHTML = '← <span>Anterior</span>';
  const position = document.createElement('p');
  const serviceName = document.createElement('strong');
  const counter = document.createElement('span');
  position.append(serviceName, counter);
  const next = document.createElement('button');
  next.type = 'button';
  next.dataset.mobileNext = '';
  next.innerHTML = '<span>Siguiente</span> →';
  controls.append(previous, position, next);

  const card = document.createElement('article');
  const safeId = `mobile-service-${route.id}-${day.key}-${direction}`.replace(/[^a-z0-9_-]+/gi, '-');
  card.id = safeId;
  card.setAttribute('aria-live', 'polite');
  card.setAttribute('aria-atomic', 'true');
  previous.setAttribute('aria-controls', safeId);
  next.setAttribute('aria-controls', safeId);

  const highlightedIndex = grid.services.findIndex((service) => highlights.get(scheduleServiceKey(day.key, direction, service)) === 0);
  let currentIndex = highlightedIndex >= 0 ? highlightedIndex : 0;

  const renderService = () => {
    const service = grid.services[currentIndex];
    const rank = highlights.get(scheduleServiceKey(day.key, direction, service));
    const status = operationalStatusForService(liveSnapshot, route, day.key, service, transportData.timezone, new Date(), rank);
    serviceName.textContent = `Formación ${service.name}`;
    counter.textContent = `${currentIndex + 1} de ${grid.services.length}`;
    previous.disabled = currentIndex === 0;
    next.disabled = currentIndex === grid.services.length - 1;
    previous.setAttribute('aria-label', previous.disabled ? 'No hay una formación anterior' : `Ver formación ${grid.services[currentIndex - 1].name}`);
    next.setAttribute('aria-label', next.disabled ? 'No hay una formación siguiente' : `Ver formación ${grid.services[currentIndex + 1].name}`);

    card.className = 'mobile-service-card';
    if (rank === 0) card.classList.add('next-service-card');
    if (rank === 1) card.classList.add('following-service-card');
    if (status) card.classList.add(`service-${status.state}-card`);

    const header = document.createElement('header');
    const identity = document.createElement('div');
    const number = document.createElement('span');
    number.textContent = `Formación ${service.name}`;
    const destination = document.createElement('small');
    destination.textContent = `hasta ${service.destination}`;
    identity.append(number, destination);
    header.append(identity);
    if (status) {
      header.append(statusBadge(status));
    } else if (rank === 0 || rank === 1) {
      const badge = document.createElement('span');
      badge.className = 'service-rank';
      badge.textContent = rank === 0 ? 'Próxima' : 'Después';
      header.append(badge);
    }

    const stops = document.createElement('dl');
    grid.stations.forEach((station) => {
      const row = document.createElement('div');
      if (station.normalizedName === 'villars') row.classList.add('villars-stop');
      const stationName = document.createElement('dt');
      stationName.append(document.createTextNode(station.name));
      if (station.normalizedName === 'villars') {
        const here = document.createElement('small');
        here.textContent = 'Estás acá';
        stationName.append(here);
      }
      if (station.outsidePublishedService) {
        const suspended = document.createElement('small');
        suspended.textContent = 'Sin servicio publicado';
        stationName.append(suspended);
      }
      const time = document.createElement('dd');
      const stop = station.stops[currentIndex];
      if (stop) {
        time.append(formattedTime(stop.minutes));
        time.title = `${station.name}: ${formatMinutes(stop.minutes).value}`;
      } else {
        time.className = 'empty-time';
        time.textContent = '—';
        time.title = 'Esta formación no pasa por la estación';
      }
      row.append(stationName, time);
      stops.append(row);
    });
    card.replaceChildren(header, stops);
  };

  previous.addEventListener('click', () => {
    if (currentIndex === 0) return;
    currentIndex -= 1;
    renderService();
  });
  next.addEventListener('click', () => {
    if (currentIndex >= grid.services.length - 1) return;
    currentIndex += 1;
    renderService();
  });

  renderService();
  mobile.append(controls, card);
  return mobile;
}

function createScheduleSection(route, day, direction, highlights) {
  const grid = stationScheduleGrid(route, day.key, direction);
  const section = document.createElement('section');
  section.className = 'schedule-block';
  section.dataset.scheduleDay = day.key;

  const header = document.createElement('div');
  header.className = 'schedule-block-heading';
  const heading = document.createElement('h3');
  heading.textContent = day.label;
  const summary = document.createElement('span');
  summary.textContent = grid.services.length ? `${grid.services.length} formaciones` : 'Sin servicios';
  header.append(heading, summary);

  const scroll = document.createElement('div');
  scroll.className = 'schedule-table-scroll';
  const table = document.createElement('table');
  table.className = 'schedule-table';
  const caption = document.createElement('caption');
  caption.textContent = `${route.branch || route.name} · ${day.label} · Hacia ${direction}`;
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  const formationHeading = document.createElement('th');
  formationHeading.scope = 'col';
  formationHeading.className = 'formation-column';
  formationHeading.textContent = 'Formación';
  headRow.append(formationHeading);

  for (const station of grid.stations) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    if (station.normalizedName === 'villars') cell.classList.add('villars-column');
    const name = document.createElement('span');
    name.textContent = station.name;
    cell.append(name);
    if (station.outsidePublishedService) {
      cell.classList.add('outside-service-column');
      const suspended = document.createElement('small');
      suspended.textContent = 'Sin servicio publicado';
      cell.append(suspended);
    }
    if (station.normalizedName === 'villars') {
      const here = document.createElement('small');
      here.textContent = 'Estás acá';
      cell.append(here);
    }
    headRow.append(cell);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  grid.services.forEach((service, serviceIndex) => {
    const row = document.createElement('tr');
    const serviceKey = scheduleServiceKey(day.key, direction, service);
    row.dataset.serviceKey = serviceKey;
    const rank = highlights.get(serviceKey);
    const status = operationalStatusForService(liveSnapshot, route, day.key, service, transportData.timezone, new Date(), rank);
    if (rank === 0) row.classList.add('next-service-row');
    if (rank === 1) row.classList.add('following-service-row');
    if (status) row.classList.add(`service-${status.state}-row`);

    const serviceCell = document.createElement('th');
    serviceCell.scope = 'row';
    serviceCell.className = 'formation-column';
    const number = document.createElement('span');
    number.textContent = service.name;
    const destination = document.createElement('small');
    destination.textContent = `hasta ${service.destination}`;
    serviceCell.append(number, destination);
    if (status) {
      serviceCell.append(statusBadge(status));
    } else if (rank === 0 || rank === 1) {
      const badge = document.createElement('span');
      badge.className = 'service-rank';
      badge.textContent = rank === 0 ? 'Próxima' : 'Después';
      serviceCell.append(badge);
    }
    row.append(serviceCell);

    grid.stations.forEach((station) => {
      const stop = station.stops[serviceIndex];
      const cell = document.createElement('td');
      if (station.normalizedName === 'villars') cell.classList.add('villars-column');
      if (stop) {
        cell.append(formattedTime(stop.minutes));
        cell.title = `Formación ${service.name}: ${station.name} ${formatMinutes(stop.minutes).value}, hasta ${service.destination}`;
      } else {
        cell.classList.add('empty-time');
        cell.textContent = '—';
        cell.title = 'Esta formación no pasa por la estación';
      }
      row.append(cell);
    });
    body.append(row);
  });

  if (grid.services.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'no-services';
    cell.colSpan = Math.max(1, grid.stations.length + 1);
    cell.textContent = 'No hay servicios informados para este día y sentido.';
    row.append(cell);
    body.append(row);
  }

  table.append(caption, head, body);
  scroll.append(table);
  section.append(header, scroll, createMobileSchedule(route, grid, day, direction, highlights));
  return section;
}

function initTransport() {
  controller?.abort();
  if (refreshTimer) window.clearInterval(refreshTimer);
  controller = new AbortController();
  const root = document.querySelector('[data-transport-app]');
  const sections = root?.querySelector('[data-schedule-sections]');
  const modeSelect = root?.querySelector('[data-mode-select]');
  const routeSelect = root?.querySelector('[data-route-select]');
  const directionSelect = root?.querySelector('[data-direction-select]');
  if (!(root instanceof HTMLElement) || !(sections instanceof HTMLElement) || !(modeSelect instanceof HTMLSelectElement) || !(routeSelect instanceof HTMLSelectElement) || !(directionSelect instanceof HTMLSelectElement) || transportRoutes.length === 0) return;

  const setText = (selector, value) => {
    const node = root.querySelector(selector);
    if (node) node.textContent = value;
  };

  const render = (routeId, requestedDirection) => {
    const route = transportRoutes.find((item) => item.id === routeId) || transportRoutes.find((item) => item.type === modeSelect.value) || transportRoutes[0];
    if (!route) return;
    const directions = directionsFor(route);
    const direction = directions.some(({ key }) => key === requestedDirection) ? requestedDirection : directions[0]?.key;
    if (!direction) return;

    modeSelect.value = route.type;
    if (![...routeSelect.options].some((option) => option.value === route.id)) {
      routeSelect.replaceChildren(...transportRoutes.filter((item) => item.type === route.type).map((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.lineLabel || item.branch || item.name;
        return option;
      }));
    }
    routeSelect.value = route.id;

    directionSelect.replaceChildren(...directions.map(({ key, label }) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = label;
      option.selected = key === direction;
      return option;
    }));

    const referenceStation = normalizeStationName(route.referenceStation || gridReferenceStation(route, direction));
    const upcoming = upcomingServicesForDirection(route, direction, transportData.timezone, new Date(), referenceStation);
    const highlights = new Map(upcoming.map(({ key }, index) => [key, index]));
    sections.setAttribute('aria-label', `Horarios de ${route.branch || route.name}, hacia ${direction}`);
    sections.replaceChildren(...scheduleDays.map((day) => createScheduleSection(route, day, direction, highlights)));

    const next = upcoming[0];
    const nextPanel = root.querySelector('.next-service');
    nextPanel?.classList.remove('service-cancelled', 'service-delayed', 'service-confirmed', 'service-in-progress', 'service-scheduled-active');
    if (next) {
      const nextStatus = operationalStatusForService(liveSnapshot, route, next.dayKey, next.service, transportData.timezone, new Date(), 0);
      const formatted = formatMinutes(next.stop.minutes);
      setText('[data-next-service]', `${weekdayNames[next.weekday]} ${next.date} · ${formatted.value}`);
      setText('[data-next-detail]', nextStatus?.state === 'cancelled'
        ? `Formación ${next.service.name} hacia ${next.service.destination} · cancelada por el operador`
        : `Formación ${next.service.name} hacia ${next.service.destination} · ${nextStatus?.label || 'Programado'} · en ${waitLabel(next.difference)}`);
      if (nextStatus) nextPanel?.classList.add(`service-${nextStatus.state}`);
    } else {
      setText('[data-next-service]', 'Sin servicio');
      setText('[data-next-detail]', 'No se encontraron formaciones en la estación de referencia durante los próximos siete días.');
    }

    setText('[data-reference-station]', route.referenceStation || gridReferenceStation(route, direction));
    setText('[data-route-type]', route.type === 'bus' ? 'Colectivo' : 'Tren');
    setText('[data-schedule-title]', `Todos los horarios de ${route.branch || route.name}`);
    setText('[data-company]', route.company || 'No informado');
    const updateMethod = route.schedules[0]?.updateMethod;
    setText('[data-update-method]', updateMethod === 'Estimado' ? 'Estimación por recorrido' : updateMethod || 'No informado');
    setText('[data-validity]', route.validFrom
      ? `Vigencia informada desde ${new Date(`${route.validFrom}T12:00:00`).toLocaleDateString('es-AR')}`
      : 'Sin vigencia informada');
    const operatorLink = root.querySelector('[data-operator-link]');
    if (operatorLink instanceof HTMLAnchorElement) operatorLink.href = route.websiteUrl || route.sourceUrl || transportData.source.repository;
    const notice = root.querySelector('[data-service-notice]');
    if (notice instanceof HTMLElement) {
      notice.textContent = route.serviceNotice || '';
      notice.hidden = !route.serviceNotice;
    }
  };

  modeSelect.addEventListener('change', () => {
    const options = transportRoutes.filter((route) => route.type === modeSelect.value);
    routeSelect.replaceChildren(...options.map((route) => {
      const option = document.createElement('option');
      option.value = route.id;
      option.textContent = route.lineLabel || route.branch || route.name;
      return option;
    }));
    render(options[0]?.id);
  }, { signal: controller.signal });
  routeSelect.addEventListener('change', () => render(routeSelect.value), { signal: controller.signal });
  directionSelect.addEventListener('change', () => {
    render(routeSelect.value, directionSelect.value);
  }, { signal: controller.signal });

  const renderCurrentSelection = () => {
    render(routeSelect.value, directionSelect.value);
  };
  document.addEventListener('transport-live-update', (event) => {
    liveSnapshot = event.detail;
    renderCurrentSelection();
  }, { signal: controller.signal });
  render(routeSelect.value);
  refreshTimer = window.setInterval(renderCurrentSelection, 60_000);
}

function gridReferenceStation(route, direction) {
  const grid = stationScheduleGrid(route, 'weekday', direction);
  return grid.stations.find((station) => !station.outsidePublishedService)?.name || grid.stations[0]?.name || '';
}

document.addEventListener('astro:page-load', initTransport);
document.addEventListener('astro:before-swap', () => {
  controller?.abort();
  if (refreshTimer) window.clearInterval(refreshTimer);
  liveSnapshot = undefined;
});
