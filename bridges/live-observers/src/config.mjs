import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MINIMUM_INTERVAL_MS = 60_000;

async function readable(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(value, fallback, minimum = 1) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum) {
    throw new TypeError(`Expected an integer greater than or equal to ${minimum}`);
  }
  return number;
}

export async function loadConfig(environment = process.env) {
  const requested = environment.SOLARIS_BRIDGE_CONFIG || 'config.local.json';
  const requestedPath = path.resolve(PACKAGE_ROOT, requested);
  const examplePath = path.join(PACKAGE_ROOT, 'config.example.json');
  const configPath = await readable(requestedPath) ? requestedPath : examplePath;
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const stateDirectory = path.resolve(PACKAGE_ROOT, config.stateDirectory || '.state');

  if (config.publish && !environment.SOLARIS_BRIDGE_INGEST_SECRET) {
    throw new Error('Publishing requires the private SOLARIS_BRIDGE_INGEST_SECRET');
  }
  if (config.publish && !String(config.ingestBaseUrl || '').startsWith('https://')) {
    throw new Error('Publishing requires an HTTPS ingestBaseUrl');
  }

  config.cuandoSubo.minimumRequestIntervalMs = positiveInteger(
    config.cuandoSubo.minimumRequestIntervalMs,
    MINIMUM_INTERVAL_MS,
    MINIMUM_INTERVAL_MS,
  );
  config.cuandoSubo.snapshotTtlMs = positiveInteger(
    config.cuandoSubo.snapshotTtlMs,
    900_000,
    config.cuandoSubo.minimumRequestIntervalMs,
  );
  if (!Array.isArray(config.cuandoSubo.stops) || config.cuandoSubo.stops.length === 0) {
    throw new Error('cuandoSubo.stops must contain at least one public stop');
  }
  await mkdir(stateDirectory, { recursive: true });
  return {
    ...config,
    configPath,
    stateDirectory,
    ingestSecret: environment.SOLARIS_BRIDGE_INGEST_SECRET || null,
  };
}

export { MINIMUM_INTERVAL_MS, PACKAGE_ROOT };
