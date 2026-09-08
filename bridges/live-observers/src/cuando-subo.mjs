import { createEnvelope } from './contract.mjs';
import { plainText } from './html.mjs';
import { publishEnvelope } from './publisher.mjs';

const STOP_URL = 'https://cuandosubo.sube.gob.ar/onebusaway-webapp/where/iphone/stop.action?id=';

function capture(value, expression) {
  return expression.exec(value)?.[1] || null;
}

export function parseCuandoSuboStopPage(html, stop, observedAt = new Date()) {
  if (typeof html !== 'string' || html.length < 100 || html.length > 256_000) {
    throw new TypeError('Unexpected Cuándo SUBO stop page size');
  }
  const publishedStopName = plainText(capture(html, /class="arrivalsStopAddress"[^>]*>([\s\S]*?)<\/div>/i));
  if (!publishedStopName) throw new Error('Cuándo SUBO page has no recognizable stop heading');
  const allowedRoutes = new Set((stop.routeIds || []).map(String));
  const arrivals = [];
  for (const match of html.matchAll(/<tr class="arrivalsRow">([\s\S]*?)<\/tr>/gi)) {
    const row = match[1];
    const routeId = capture(row, /[?&](?:amp;)?route=([^&"]+)/i);
    const tripId = capture(row, /trip\.action\?id=([^&"]+)/i);
    const destinationHtml = capture(row, /class="arrivalsDestinationEntry"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const scheduledTime = plainText(capture(row, /class="arrivalsTimeEntry"[^>]*>([\s\S]*?)<\/span>/i));
    const etaRaw = plainText(capture(row, /class="arrivalsStatusEntry[^"]*"[^>]*>([\s\S]*?)<\/td>/i));
    const etaMinutes = Number.parseInt(etaRaw, 10);
    if (!routeId || !tripId || !allowedRoutes.has(routeId)) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduledTime)) continue;
    if (!Number.isInteger(etaMinutes) || etaMinutes < 0 || etaMinutes > 300) continue;
    arrivals.push({
      routeId,
      tripId,
      stopId: stop.id,
      stopName: stop.name || publishedStopName,
      destination: plainText(destinationHtml) || 'Destino no informado',
      scheduledTime,
      etaMinutes,
      observedAt: observedAt.toISOString(),
    });
  }
  return arrivals;
}

async function fetchStop(stop) {
  const response = await fetch(`${STOP_URL}${encodeURIComponent(stop.id)}`, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'SolarisPKN-Transport-Community-Observer/0.1 (+https://github.com/SolarisPKN/SolarisPKN-Transport)',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Cuándo SUBO public page returned HTTP ${response.status}`);
  return response.text();
}

function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function runCuandoSubo(config, { once = false, signal } = {}) {
  const providerConfig = config.cuandoSubo;
  const observations = new Map();
  let index = 0;
  do {
    const stop = providerConfig.stops[index % providerConfig.stops.length];
    const observedAt = new Date();
    try {
      const arrivals = parseCuandoSuboStopPage(await fetchStop(stop), stop, observedAt);
      for (const arrival of arrivals) {
        observations.set(`${arrival.stopId}:${arrival.routeId}:${arrival.tripId}`, arrival);
      }
      for (const [key, arrival] of observations) {
        if (observedAt.getTime() - Date.parse(arrival.observedAt) > providerConfig.snapshotTtlMs) {
          observations.delete(key);
        }
      }
      const envelope = createEnvelope('cuando-subo-bridge', {
        arrivals: [...observations.values()],
        now: observedAt,
        ttlMs: providerConfig.snapshotTtlMs,
      });
      const result = await publishEnvelope(envelope, config);
      console.log(`[cuando-subo] ${result.mode}: ${stop.name}, ${arrivals.length} arribos aceptados`);
    } catch (error) {
      console.error(`[cuando-subo] ${stop.name}: ${String(error.message || error).slice(0, 180)}`);
    }
    index += 1;
    if (!once && !signal?.aborted) await delay(providerConfig.minimumRequestIntervalMs, signal);
  } while (!once && !signal?.aborted);
}
