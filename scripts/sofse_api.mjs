#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export const SOFSE_BASE_URL = 'https://api-servicios.sofse.gob.ar/v1';
export const ARGENTINA_TIME_ZONE = 'America/Argentina/Buenos_Aires';

const DEFAULT_TIMEOUT_MS = 10_000;
const APP_USER_AGENT = 'Trenes Argentinos/7.70.1 SolarisPKN-Transport';

export class SofseApiError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.name = 'SofseApiError';
    this.status = status;
    this.body = body;
  }
}

function argentinaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ARGENTINA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(
    parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]),
  );
}

export function argentinaDate(date = new Date()) {
  const { year, month, day } = argentinaParts(date);
  return `${year}-${month}-${day}`;
}

export function argentinaTime(date = new Date()) {
  const { hour, minute } = argentinaParts(date);
  return `${hour}:${minute}`;
}

function replaceLowercase(value, replacements) {
  return [...value].map((character) => replacements[character] ?? character).join('');
}

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Reproduce el login que usa la APK oficial 7.70.1.
 * La fecha debe calcularse en Argentina: cerca de las 21:00, usar UTC rompe el login.
 */
export function buildAppCredentials(date = new Date()) {
  const compactDate = argentinaDate(date).replaceAll('-', '');
  const username = base64(`${compactDate}sofse`);

  const firstPass = replaceLowercase(base64(username), {
    a: '#t', e: '#x', i: '#f', o: '#l', u: '#7', '=': '#g',
  });

  const secondPass = replaceLowercase(base64([...firstPass].reverse().join('')), {
    a: '#j', e: '#p', i: '#w', o: '#8', u: '#0', '=': '#v',
  });

  return {
    username,
    password: encodeURIComponent([...secondPass].reverse().join('')),
  };
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;

    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      throw new SofseApiError(`SOFSE respondio HTTP ${response.status}.`, {
        status: response.status,
        body,
      });
    }

    return body;
  } catch (error) {
    if (error instanceof SofseApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new SofseApiError(`La consulta a SOFSE excedio ${timeoutMs} ms.`, { cause: error });
    }
    throw new SofseApiError(`No se pudo consultar SOFSE: ${error.message}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function addIfPresent(params, name, value) {
  if (value !== undefined && value !== null && value !== '') {
    params.set(name, String(value));
  }
}

function unwrapCollection(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.results)) return response.results;
  if (Array.isArray(response?.resultado)) return response.resultado;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

function serviceIdentity(item) {
  const service = item?.servicio ?? item;
  const origin = service?.desde ?? service?.origen ?? {};
  const destination = service?.hasta ?? service?.destino ?? {};
  const departure = origin?.salida?.programada ?? service?.salida?.programada ?? '';
  const arrival = destination?.llegada?.programada ?? service?.llegada?.programada ?? '';

  return [
    service?.numero ?? service?.nroTren ?? '',
    service?.sentido ?? '',
    origin?.idElemento ?? origin?.id ?? '',
    destination?.idElemento ?? destination?.id ?? '',
    departure,
    arrival,
  ].join('|');
}

/** El backend duplica algunos servicios del sentido Lozano -> Catan. */
export function deduplicateServices(responseOrItems) {
  const unique = new Map();
  for (const item of unwrapCollection(responseOrItems)) {
    const key = serviceIdentity(item);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

/**
 * SOFSE puede completar la cantidad pedida con servicios del dia siguiente,
 * pero proyectando sus timestamps sobre el dia consultado. servicio.fecha es
 * el campo que permite separar ambos cronogramas.
 */
export function servicesForDate(responseOrItems, date) {
  const matching = unwrapCollection(responseOrItems).filter((item) => {
    const service = item?.servicio ?? item;
    if (!service?.fecha) return true;
    return formatArgentinaTimestamp(service.fecha)?.slice(0, 10) === date;
  });

  return deduplicateServices(matching);
}

function stationId(station) {
  return station?.idElemento ?? station?.idEstacion ?? station?.estacion?.idElemento ?? station?.id;
}

function stationName(station) {
  return station?.nombre ?? station?.estacion?.nombre ?? station?.descripcion ?? null;
}

function serviceStations(item) {
  const service = item?.servicio ?? item;
  return service?.estaciones ?? service?.recorrido ?? [];
}

/**
 * El catalogo /infraestructura/estaciones no incluye Lozano. El itinerario de
 * /arribos si lo incluye, por eso esta funcion es la fuente de descubrimiento.
 */
export function collectStationsFromServices(responseOrItems) {
  const stations = new Map();

  for (const item of deduplicateServices(responseOrItems)) {
    for (const station of serviceStations(item)) {
      const id = stationId(station);
      if (id === undefined || id === null) continue;

      const previous = stations.get(String(id));
      const next = {
        id: Number.isNaN(Number(id)) ? id : Number(id),
        nombre: stationName(station),
        idPunto: station?.idPunto ?? previous?.idPunto ?? null,
        orden: station?.orden ?? previous?.orden ?? null,
        parada: Boolean(station?.parada ?? previous?.parada),
      };
      stations.set(String(id), { ...previous, ...next });
    }
  }

  return [...stations.values()].sort((a, b) => (a.orden ?? 9999) - (b.orden ?? 9999));
}

export function formatArgentinaTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: ARGENTINA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date).replace(' ', 'T');
}

function summarizedStation(station) {
  return {
    id: stationId(station) ?? null,
    nombre: stationName(station),
    orden: station?.orden ?? null,
    parada: station?.parada ?? null,
    llegadaProgramada: formatArgentinaTimestamp(station?.llegada?.programada),
    salidaProgramada: formatArgentinaTimestamp(station?.salida?.programada),
  };
}

export function summarizeService(item) {
  const service = item?.servicio ?? item;
  const origin = service?.desde ?? service?.origen ?? {};
  const destination = service?.hasta ?? service?.destino ?? {};

  return {
    numero: service?.numero ?? service?.nroTren ?? null,
    sentido: service?.sentido ?? null,
    ramal: service?.ramal ?? null,
    origen: {
      id: stationId(origin) ?? null,
      nombre: stationName(origin),
      salidaProgramada: formatArgentinaTimestamp(origin?.salida?.programada),
    },
    destino: {
      id: stationId(destination) ?? null,
      nombre: stationName(destination),
      llegadaProgramada: formatArgentinaTimestamp(destination?.llegada?.programada),
    },
    estaciones: serviceStations(item).map(summarizedStation),
  };
}

export class SofseClient {
  constructor({ baseUrl = SOFSE_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenDate = null;
  }

  async authenticate(now = new Date()) {
    const credentials = buildAppCredentials(now);
    const body = await fetchJson(`${this.baseUrl}/auth/authorize`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': APP_USER_AGENT,
      },
      body: JSON.stringify(credentials),
    }, this.timeoutMs);

    const token = typeof body === 'string'
      ? body
      : body?.token ?? body?.accessToken ?? body?.access_token;

    if (!token) {
      throw new SofseApiError('SOFSE autentico, pero no devolvio un token reconocible.', { body });
    }

    this.token = token;
    this.tokenDate = argentinaDate(now);
    return token;
  }

  async request(path, { query, retryAuth = true } = {}) {
    const today = argentinaDate();
    if (!this.token || this.tokenDate !== today) await this.authenticate();

    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [name, value] of Object.entries(query ?? {})) addIfPresent(url.searchParams, name, value);

    try {
      return await fetchJson(url, {
        headers: {
          Accept: 'application/json',
          Authorization: this.token,
          'User-Agent': APP_USER_AGENT,
        },
      }, this.timeoutMs);
    } catch (error) {
      if (retryAuth && (error.status === 401 || error.status === 403)) {
        this.token = null;
        await this.authenticate();
        return this.request(path, { query, retryAuth: false });
      }
      throw error;
    }
  }

  getManagements() {
    return this.request('/infraestructura/gerencias', { query: { idEmpresa: 1 } });
  }

  getBranches(managementId) {
    return this.request('/infraestructura/ramales', { query: { idGerencia: managementId } });
  }

  getStationsByBranch(branchId) {
    return this.request('/infraestructura/estaciones', { query: { idRamal: branchId } });
  }

  searchStations(name) {
    return this.request('/infraestructura/estaciones', { query: { nombre: name } });
  }

  getArrivals({
    originId,
    destinationId,
    date = argentinaDate(),
    time = argentinaTime(),
    count = 30,
    forApp = true,
    branchId,
    direction,
    searchType,
    serviceType,
  }) {
    if (originId === undefined || originId === null) throw new TypeError('originId es obligatorio.');

    return this.request(`/arribos/estacion/${encodeURIComponent(originId)}`, {
      query: {
        hasta: destinationId,
        fecha: date,
        hora: time,
        cantidad: count,
        paraApp: forApp,
        ramal: branchId,
        sentido: direction,
        tipoBusqueda: searchType,
        tipoServicio: serviceType,
      },
    });
  }
}

function parseCliArguments(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }

    const name = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      result[name] = true;
    } else {
      result[name] = next;
      index += 1;
    }
  }
  return result;
}

function numberArgument(args, name, { required = false } = {}) {
  const value = args[name];
  if ((value === undefined || value === true) && required) throw new TypeError(`Falta --${name}.`);
  if (value === undefined || value === true) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`--${name} debe ser numerico.`);
  return number;
}

function usage() {
  return `Uso:
  node scripts/sofse_api.mjs arrivals --origin 154 --destination 6000 --branch 67 --direction 1
  node scripts/sofse_api.mjs discover-stations --origin 154 --branch 67 --direction 1
  node scripts/sofse_api.mjs search-stations --name Lozano
  node scripts/sofse_api.mjs branches --management 21
  node scripts/sofse_api.mjs stations --branch 67

Opciones de arrivals/discover-stations:
  --date YYYY-MM-DD   Fecha argentina (por defecto: hoy)
  --time HH:mm        Hora argentina (por defecto: ahora)
  --count N           Cantidad solicitada (por defecto: 30)
`;
}

async function main() {
  const [command, ...values] = process.argv.slice(2);
  const args = parseCliArguments(values);
  const client = new SofseClient();
  let result;

  switch (command) {
    case 'arrivals': {
      const response = await client.getArrivals({
        originId: numberArgument(args, 'origin', { required: true }),
        destinationId: numberArgument(args, 'destination'),
        branchId: numberArgument(args, 'branch'),
        direction: numberArgument(args, 'direction'),
        count: numberArgument(args, 'count') ?? 30,
        date: args.date ?? argentinaDate(),
        time: args.time ?? argentinaTime(),
      });
      result = servicesForDate(response, args.date ?? argentinaDate()).map(summarizeService);
      break;
    }
    case 'discover-stations': {
      const response = await client.getArrivals({
        originId: numberArgument(args, 'origin', { required: true }),
        destinationId: numberArgument(args, 'destination'),
        branchId: numberArgument(args, 'branch'),
        direction: numberArgument(args, 'direction'),
        count: numberArgument(args, 'count') ?? 30,
        date: args.date ?? argentinaDate(),
        time: args.time ?? '00:00',
      });
      result = collectStationsFromServices(response);
      break;
    }
    case 'search-stations':
      if (!args.name || args.name === true) throw new TypeError('Falta --name.');
      result = await client.searchStations(args.name);
      break;
    case 'branches':
      result = await client.getBranches(numberArgument(args, 'management', { required: true }));
      break;
    case 'stations':
      result = await client.getStationsByBranch(numberArgument(args, 'branch', { required: true }));
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(usage());
      return;
    default:
      throw new TypeError(`Comando desconocido: ${command}\n\n${usage()}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    const detail = error.body && typeof error.body !== 'object' ? ` ${error.body}` : '';
    process.stderr.write(`${error.name}: ${error.message}${detail}\n`);
    process.exitCode = 1;
  });
}
