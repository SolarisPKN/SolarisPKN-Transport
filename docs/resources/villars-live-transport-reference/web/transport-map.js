import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { PMTiles } from 'pmtiles';
import baseMapData from '../data/transport-map.json';
import route136Config from '../data/transport-136-villars.json';
import { route136MapFeatures } from '../utils/transport-route-model.js';
import { featureIsVisible, routeFamily } from '../utils/transport-map-live.js';

const route136Features = route136MapFeatures(route136Config);
const mapData = {
  ...baseMapData,
  routes: {
    ...baseMapData.routes,
    features: [...baseMapData.routes.features, route136Features.route],
  },
  stops: {
    ...baseMapData.stops,
    features: [...baseMapData.stops.features, ...route136Features.stops],
  },
};

const liveSnapshotUrl = import.meta.env.PUBLIC_TRANSPORT_LIVE_URL || 'https://transport-data.solarispkn.com.ar/current.json';
const STALE_AFTER_MS = 120_000;
const UNAVAILABLE_AFTER_MS = 600_000;
let leafletRendererPromise;
let mapArchivePromise;
let map;
let liveLayer;
let routeLayer;
let stopLayer;
let filterController;
let currentLiveFeatures = [];
let pollTimer;
let pollingController;
let lastEtag;
let baseMapState = 'loading';
let liveStatus = { message: 'Conectando con el snapshot de posiciones…', state: 'loading' };
let hasAutoFocusedLive = false;

class MemoryPmtilesSource {
  constructor(key, data) {
    this.key = key;
    this.data = data;
  }

  getKey() {
    return this.key;
  }

  async getBytes(offset, length, signal) {
    if (signal?.aborted) throw new DOMException('La carga del mapa fue cancelada', 'AbortError');
    return { data: this.data.slice(offset, offset + length) };
  }
}

function loadLeafletRenderer() {
  if (!leafletRendererPromise) {
    window.L = L;
    leafletRendererPromise = import('protomaps-leaflet');
  }
  return leafletRendererPromise;
}

async function loadMapArchive(url) {
  if (!mapArchivePromise) {
    mapArchivePromise = fetch(url, { cache: 'force-cache' })
      .then(async (response) => {
        if (!response.ok) throw new Error('No se pudo descargar la cartografía: HTTP ' + response.status);
        return new PMTiles(new MemoryPmtilesSource(url, await response.arrayBuffer()));
      })
      .catch((error) => {
        mapArchivePromise = undefined;
        throw error;
      });
  }
  return mapArchivePromise;
}

function renderStatus() {
  const node = document.querySelector('[data-live-map-status]');
  if (!node) return;
  if (baseMapState === 'loading') {
    node.textContent = 'Cargando la cartografía local…';
    node.dataset.state = 'loading';
    return;
  }
  if (baseMapState === 'error') {
    node.textContent = 'No se pudo abrir la cartografía local. Los horarios siguen disponibles.';
    node.dataset.state = 'error';
    return;
  }
  node.textContent = liveStatus.message;
  node.dataset.state = liveStatus.state;
}

function setLiveStatus(message, state = 'static') {
  liveStatus = { message, state };
  renderStatus();
}

function liveFeatures(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.vehicles)) throw new Error('Formato de posiciones no reconocido');
  const now = Date.now();
  const snapshotAt = new Date(snapshot.generatedAt).getTime();
  const snapshotStale = !Number.isFinite(snapshotAt) || now - snapshotAt > STALE_AFTER_MS;
  return snapshot.vehicles
    .filter((vehicle) => {
      if (!Number.isFinite(vehicle.lon) || !Number.isFinite(vehicle.lat)) return false;
      const updatedAt = new Date(vehicle.updatedAt || snapshot.generatedAt).getTime();
      return Number.isFinite(updatedAt) && now - updatedAt <= UNAVAILABLE_AFTER_MS;
    })
    .map((vehicle) => ({
      type: 'Feature',
      properties: {
        id: vehicle.vehicleId,
        mode: vehicle.mode,
        routeId: vehicle.routeId || null,
        label: vehicle.label || vehicle.routeId || (vehicle.mode === 'train' ? 'Tren' : 'Colectivo'),
        positionKind: vehicle.positionKind || 'unknown',
        fromStop: vehicle.fromStop || null,
        toStop: vehicle.toStop || null,
        scheduledArrivalAt: vehicle.scheduledArrivalAt || null,
        stale: Boolean(vehicle.stale) || snapshotStale || now - new Date(vehicle.updatedAt || snapshot.generatedAt).getTime() > STALE_AFTER_MS,
        updatedAt: vehicle.updatedAt || snapshot.generatedAt,
      },
      geometry: { type: 'Point', coordinates: [vehicle.lon, vehicle.lat] },
    }));
}

function selectedFilters(selector, dataKey) {
  return new Set([...document.querySelectorAll(selector)]
    .filter((input) => input instanceof HTMLInputElement && input.checked && !input.disabled)
    .map((input) => input.dataset[dataKey]));
}

function currentFilterState() {
  return {
    modes: selectedFilters('[data-map-mode]', 'mapMode'),
    routes: selectedFilters('[data-map-route]', 'mapRoute'),
    layers: selectedFilters('[data-map-layer]', 'mapLayer'),
  };
}

function renderFilteredLayers() {
  const filters = currentFilterState();
  if (routeLayer) {
    routeLayer.clearLayers();
    if (filters.layers.has('routes')) {
      routeLayer.addData({
        type: 'FeatureCollection',
        features: mapData.routes.features.filter((feature) => featureIsVisible(feature, filters)),
      });
    }
  }
  if (stopLayer) {
    stopLayer.clearLayers();
    if (filters.layers.has('stops')) {
      stopLayer.addData({
        type: 'FeatureCollection',
        features: mapData.stops.features.filter((feature) => featureIsVisible(feature, filters)),
      });
    }
  }
  if (liveLayer) {
    liveLayer.clearLayers();
    if (filters.layers.has('positions')) {
      liveLayer.addData({
        type: 'FeatureCollection',
        features: currentLiveFeatures.filter((feature) => featureIsVisible(feature, filters)),
      });
    }
  }
  updateLiveFocusControl();
}

function visibleLiveFeatures() {
  const filters = currentFilterState();
  if (!filters.layers.has('positions')) return [];
  return currentLiveFeatures.filter((feature) => featureIsVisible(feature, filters));
}

function updateLiveFocusControl() {
  const button = document.querySelector('[data-map-focus-live]');
  const count = document.querySelector('[data-map-live-count]');
  const visible = visibleLiveFeatures();
  if (button instanceof HTMLButtonElement) button.disabled = visible.length === 0;
  if (count) count.textContent = String(visible.length);
}

function focusLivePositions() {
  if (!map) return;
  const visible = visibleLiveFeatures();
  if (visible.length === 0) return;
  const points = visible.map(({ geometry }) => L.latLng(geometry.coordinates[1], geometry.coordinates[0]));
  if (points.length === 1) {
    map.setView(points[0], Math.max(map.getZoom(), 11), { animate: true });
  } else {
    map.fitBounds(L.latLngBounds(points), { padding: [42, 42], maxZoom: 12, animate: true });
  }
}

function bindMapFilters() {
  filterController?.abort();
  filterController = new AbortController();
  document.querySelectorAll('[data-map-mode], [data-map-route], [data-map-layer]').forEach((input) => {
    if (input instanceof HTMLInputElement && !input.disabled) {
      input.addEventListener('change', renderFilteredLayers, { signal: filterController.signal });
    }
  });
  const focusButton = document.querySelector('[data-map-focus-live]');
  if (focusButton instanceof HTMLButtonElement) {
    focusButton.addEventListener('click', focusLivePositions, { signal: filterController.signal });
  }
}


function popupContent(properties, kind) {
  const content = document.createElement('div');
  const heading = document.createElement('strong');
  const description = document.createElement('span');
  heading.textContent = properties.name || properties.label || 'Transporte';
  if (kind === 'live') {
    const segment = properties.fromStop && properties.toStop
      ? ` entre ${properties.fromStop} y ${properties.toStop}`
      : '';
    const source = properties.positionKind === 'predicted'
      ? `Posición estimada por horario${segment}`
      : 'GPS informado';
    description.textContent = `${source}${properties.stale ? ' · dato demorado' : ''}`;
  } else {
    const family = routeFamily({ properties });
    description.textContent = properties.mode === 'train' ? 'Estación ferroviaria' : `Parada del colectivo ${family.startsWith('136') ? '136' : '322'}`;
  }
  content.append(heading, document.createElement('br'), description);
  return content;
}

function markerStyle(feature, live = false) {
  const isTrain = feature?.properties?.mode === 'train';
  const isPredicted = live && feature?.properties?.positionKind === 'predicted';
  return {
    radius: live ? 8 : 5,
    color: live ? '#ffffff' : '#2c2119',
    weight: live ? 2 : 1.5,
    fillColor: isPredicted ? '#ffb703' : (isTrain ? (live ? '#f4a261' : '#e9c46a') : (live ? '#219ebc' : '#8ecae6')),
    dashArray: isPredicted ? '3 3' : null,
    fillOpacity: live && feature?.properties?.stale ? 0.4 : 0.95,
  };
}

function vehicleMarkerIcon(feature) {
  const isTrain = feature?.properties?.mode === 'train';
  const isPredicted = feature?.properties?.positionKind === 'predicted';
  const family = routeFamily(feature);
  const color = isTrain ? '#d99a2b' : family.startsWith('136') ? '#e97832' : '#168aad';
  const glyph = isTrain
    ? '<path d="M7 3h10c2.2 0 4 1.8 4 4v8c0 2-1.5 3.7-3.4 4l2.1 2.1-1.4 1.4-2.2-2.2H7.9l-2.2 2.2-1.4-1.4L6.4 19A4 4 0 0 1 3 15V7c0-2.2 1.8-4 4-4Zm0 3a1 1 0 0 0-1 1v5h12V7a1 1 0 0 0-1-1H7Zm1 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>'
    : '<path d="M6 3h12c2.2 0 4 1.8 4 4v10c0 1.5-1 2.7-2.4 3L18 22h-2l-1-2H9l-1 2H6l-1.6-2A3.1 3.1 0 0 1 2 17V7c0-2.2 1.8-4 4-4Zm0 3a1 1 0 0 0-1 1v5h14V7a1 1 0 0 0-1-1H6Zm1 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm10 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>';
  const stateClass = [
    isPredicted ? 'is-estimated' : 'is-observed',
    feature?.properties?.stale ? 'is-stale' : '',
  ].filter(Boolean).join(' ');
  return L.divIcon({
    className: 'transport-vehicle-icon',
    html: `<span class="transport-vehicle-pin ${stateClass}" style="--vehicle-color:${color}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${glyph}</svg></span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18],
  });
}

function replaceLiveFeatures(features) {
  currentLiveFeatures = features;
  renderFilteredLayers();
  if (!hasAutoFocusedLive && map && features.length > 0) {
    const bounds = map.getBounds();
    const anyVisibleInViewport = visibleLiveFeatures().some(({ geometry }) => (
      bounds.contains(L.latLng(geometry.coordinates[1], geometry.coordinates[0]))
    ));
    if (!anyVisibleInViewport) focusLivePositions();
    hasAutoFocusedLive = true;
  }
}

async function updateLiveLayer() {
  if (!liveSnapshotUrl || !liveLayer || document.hidden) return;
  pollingController?.abort();
  pollingController = new AbortController();
  try {
    const headers = lastEtag ? { 'If-None-Match': lastEtag } : undefined;
    const response = await fetch(liveSnapshotUrl, { headers, signal: pollingController.signal });
    if (response.status === 304) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    lastEtag = response.headers.get('etag') || lastEtag;
    const snapshot = await response.json();
    document.dispatchEvent(new CustomEvent('transport-live-update', { detail: snapshot }));
    const snapshotAt = new Date(snapshot.generatedAt).getTime();
    const snapshotAge = Date.now() - snapshotAt;
    const features = liveFeatures(snapshot);
    const observedCount = features.filter(({ properties }) => properties.positionKind === 'observed').length;
    const predictedCount = features.filter(({ properties }) => properties.positionKind === 'predicted').length;
    const countLabel = [
      observedCount ? `${observedCount} con GPS` : '',
      predictedCount ? `${predictedCount} estimadas` : '',
    ].filter(Boolean).join(' · ');
    replaceLiveFeatures(features);
    const generatedAt = new Date(snapshot.generatedAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    if (!Number.isFinite(snapshotAt) || snapshotAge > UNAVAILABLE_AFTER_MS || snapshot.status === 'unavailable') {
      replaceLiveFeatures([]);
      setLiveStatus('Las posiciones en vivo están temporalmente no disponibles; el mapa y los horarios programados siguen activos.', 'error');
    } else if (snapshot.status === 'degraded' || snapshotAge > STALE_AFTER_MS || features.some(({ properties }) => properties.stale)) {
      setLiveStatus(features.length
        ? `${countLabel || `${features.length} posiciones`} con datos demorados · última consulta a las ${generatedAt}`
        : `Seguimiento parcial sin unidades informadas · consulta de las ${generatedAt}`,
      'stale');
    } else {
      setLiveStatus(features.length
        ? `${countLabel || `${features.length} posiciones`} · snapshot de las ${generatedAt}`
        : `Sin unidades informadas por los proveedores · consulta de las ${generatedAt}`,
      features.length ? 'live' : 'empty');
    }
  } catch (error) {
    if (error.name !== 'AbortError') setLiveStatus('El seguimiento en vivo no respondió; el mapa y los horarios programados siguen disponibles.', 'error');
  }
}

function addTransportLayers() {
  routeLayer = L.geoJSON({ type: 'FeatureCollection', features: [] }, {
    style: (feature) => ({
      color: feature?.properties?.mode === 'train'
        ? '#e9c46a'
        : routeFamily(feature).startsWith('136') ? '#f28c45' : '#6fb7ff',
      weight: feature?.properties?.mode === 'train' ? 4 : 3,
      opacity: 0.95,
    }),
  }).addTo(map);

  stopLayer = L.geoJSON({ type: 'FeatureCollection', features: [] }, {
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, markerStyle(feature)),
    onEachFeature: (feature, layer) => layer.bindPopup(() => popupContent(feature.properties || {}, 'stop')),
  }).addTo(map);

  liveLayer = L.geoJSON({ type: 'FeatureCollection', features: [] }, {
    pointToLayer: (feature, latlng) => L.marker(latlng, {
      icon: vehicleMarkerIcon(feature),
      keyboard: true,
      title: feature?.properties?.label || 'Transporte',
    }),
    onEachFeature: (feature, layer) => layer.bindPopup(() => popupContent(feature.properties || {}, 'live')),
  }).addTo(map);
  renderFilteredLayers();
}

async function initTransportMap() {
  const container = document.querySelector('[data-transport-map]');
  if (!(container instanceof HTMLElement)) return;
  map?.remove();
  liveLayer = undefined;
  routeLayer = undefined;
  stopLayer = undefined;
  currentLiveFeatures = [];
  hasAutoFocusedLive = false;
  baseMapState = 'loading';
  renderStatus();

  const mapArchiveUrl = new URL('/maps/villars-region.pmtiles', window.location.origin).href;
  let archive;
  let leafletLayer;
  try {
    [archive, { leafletLayer }] = await Promise.all([loadMapArchive(mapArchiveUrl), loadLeafletRenderer()]);
  } catch (error) {
    console.error('No se pudo preparar la cartografía local.', error);
    baseMapState = 'error';
    renderStatus();
    return;
  }
  if (!container.isConnected) return;

  map = L.map(container, {
    center: [mapData.center[1], mapData.center[0]],
    zoom: 10,
    minZoom: 8,
    maxZoom: 14,
    zoomControl: true,
    attributionControl: true,
  });

  const baseLayer = leafletLayer({
    url: archive,
    flavor: 'dark',
    lang: 'es',
    noWrap: true,
    minZoom: 8,
    maxZoom: 14,
    maxDataZoom: 14,
    bounds: [[-35.22, -59.32], [-34.48, -58.38]],
    attribution: '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  baseLayer.once('load', () => {
    baseMapState = 'ready';
    renderStatus();
  });
  baseLayer.on('tileerror', (event) => {
    console.error('No se pudo cargar una tesela de la cartografía local.', event.error);
    if (baseMapState !== 'ready') {
      baseMapState = 'error';
      renderStatus();
    }
  });
  baseLayer.addTo(map);
  addTransportLayers();
  bindMapFilters();

  if (liveSnapshotUrl) {
    updateLiveLayer();
    pollTimer = window.setInterval(updateLiveLayer, 60_000);
  } else {
    setLiveStatus('Mapa autocontenido activo. La capa de posiciones queda lista para conectar al Worker de Cloudflare.', 'static');
  }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) updateLiveLayer(); });
document.addEventListener('astro:page-load', initTransportMap);
document.addEventListener('astro:before-swap', () => {
  window.clearInterval(pollTimer);
  pollingController?.abort();
  map?.remove();
  map = undefined;
  liveLayer = undefined;
  routeLayer = undefined;
  stopLayer = undefined;
  currentLiveFeatures = [];
  hasAutoFocusedLive = false;
  filterController?.abort();
});
