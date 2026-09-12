import { CONNECTORS } from './connectors/index.js';
import { buildAlertDeltas, buildDeltas, applyObservationTimes } from './delta.js';
import { emptyCurrent, validCurrent, vehicleIdentity } from './schema.js';
import { safeError } from './connectors/http.js';
import { validateConfig } from './config.js';

export function categoryForScheduledTime(scheduledTime) {
  const date = new Date(Number(scheduledTime));
  if (!Number.isFinite(date.getTime())) throw new Error('scheduledTime inválido.');
  const minute = date.getUTCMinutes();
  if (minute % 4 === 0) return 'train';
  if (minute % 4 === 2) return 'bus';
  throw new Error(`El cron */2 produjo un minuto inesperado: ${minute}.`);
}

function groupKey(mode) { return mode === 'train' ? 'trains' : 'buses'; }

async function readCurrent(env, at) {
  try {
    const value = await env.TRANSPORT_LIVE.get('current.json', { type: 'json' });
    return validCurrent(value) ? value : emptyCurrent(at);
  } catch {
    return emptyCurrent(at);
  }
}

function isValidResult(result, checkedAt, staleAfterSeconds) {
  if (!result || !Array.isArray(result.vehicles) || !Array.isArray(result.alerts)) return false;
  if (result.vehicles.length === 0 && result.alerts.length === 0) return false;
  const sourceMs = result.sourceTimestamp ? new Date(result.sourceTimestamp).getTime() : checkedAt.getTime();
  return Number.isFinite(sourceMs) && checkedAt.getTime() - sourceMs <= staleAfterSeconds * 1000;
}

export async function collectCategory(configInput, mode, env, checkedAt, connectorRegistry = CONNECTORS) {
  const config = validateConfig(configInput);
  const context = { cache: {} };
  const vehicles = [];
  const alerts = [];
  const providers = [];
  let newestSourceTimestamp = null;
  for (const line of config.lines.filter((candidate) => candidate.enabled !== false && candidate.mode === mode)) {
    let accepted = false;
    const attempts = [];
    for (const connectorRef of line.connectors) {
      const provider = config.providerMap.get(connectorRef.provider);
      if (!provider?.enabled) continue;
      const connector = connectorRegistry.get(provider.module);
      if (!connector?.collect) throw new Error(`Conector ${provider.module} no registrado.`);
      try {
        const result = await connector.collect({ provider, line: { ...line, external: connectorRef.external || {} }, context, checkedAt, env });
        const valid = isValidResult(result, checkedAt, config.quality.staleAfterSeconds);
        attempts.push({ provider: provider.id, status: valid ? 'ok' : 'empty-or-stale' });
        if (!valid) continue;
        vehicles.push(...result.vehicles);
        alerts.push(...result.alerts);
        if (result.sourceTimestamp && (!newestSourceTimestamp || result.sourceTimestamp > newestSourceTimestamp)) newestSourceTimestamp = result.sourceTimestamp;
        accepted = true;
        break;
      } catch (error) {
        attempts.push({ provider: provider.id, status: 'error', error: safeError(error) });
      }
    }
    providers.push({ lineId: line.id, accepted, attempts });
  }
  return { vehicles, alerts, providers, sourceTimestamp: newestSourceTimestamp, status: providers.every((item) => item.accepted) ? 'ok' : vehicles.length || alerts.length ? 'degraded' : 'unavailable' };
}

export function historyKey(scheduledTime, mode) {
  const date = new Date(Number(scheduledTime));
  const day = date.toISOString().slice(0, 10);
  const hhmm = date.toISOString().slice(11, 16).replace(':', '');
  return `history/${day}/${hhmm}-${mode}.json`;
}

export async function refreshLive(env, scheduledTime, configInput = __LIVE_CONFIG__, connectorRegistry = CONNECTORS) {
  const mode = categoryForScheduledTime(scheduledTime);
  const key = groupKey(mode);
  const checkedAt = new Date(Number(scheduledTime));
  const at = checkedAt.toISOString();
  const config = validateConfig(configInput);
  const previous = await readCurrent(env, at);
  const collected = await collectCategory(config, mode, env, checkedAt, connectorRegistry);
  const oldGroup = previous[key];
  const tolerance = config.quality.positionToleranceMeters[mode];
  const acceptedLineIds = new Set(collected.providers.filter((item) => item.accepted).map((item) => item.lineId));
  const observedVehicles = applyObservationTimes(oldGroup.vehicles, collected.vehicles, tolerance, at);
  const retainedVehicles = oldGroup.vehicles
    .filter((vehicle) => !acceptedLineIds.has(vehicle.routeId))
    .map((vehicle) => ({ ...vehicle, stale: true }));
  const nextVehicles = [...new Map([...retainedVehicles, ...observedVehicles]
    .map((vehicle) => [vehicleIdentity(vehicle), vehicle])).values()];
  const failedLineIds = new Set(collected.providers.filter((item) => !item.accepted).map((item) => item.lineId));
  const retainedAlerts = (oldGroup.alerts || []).filter((alert) => failedLineIds.has(alert.routeId) || (!alert.routeId && failedLineIds.size));
  const nextAlerts = [...new Map([...retainedAlerts, ...collected.alerts].map((alert) => [alert.alertId, alert])).values()];
  const delta = buildDeltas(oldGroup.vehicles, nextVehicles, { mode, toleranceMeters: tolerance, at });
  delta.checkedAt = at;
  delta.sourceTimestamp = collected.sourceTimestamp;
  delta.status = collected.status;
  delta.alerts = buildAlertDeltas(oldGroup.alerts || [], nextAlerts, at);
  const current = {
    ...previous,
    schemaVersion: 2,
    updatedAt: at,
    [key]: {
      checkedAt: at,
      sourceTimestamp: collected.sourceTimestamp,
      status: collected.status,
      vehicles: nextVehicles,
      alerts: nextAlerts,
      providers: collected.providers,
    },
  };
  await env.TRANSPORT_LIVE.put(historyKey(scheduledTime, mode), JSON.stringify(delta), { httpMetadata: { contentType: 'application/json', cacheControl: 'private, max-age=0' } });
  await env.TRANSPORT_LIVE.put(config.deployment.currentKey, JSON.stringify(current), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=30, stale-while-revalidate=90' } });
  return { current, delta, mode };
}
