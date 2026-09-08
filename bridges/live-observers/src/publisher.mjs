import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertEnvelope } from './contract.mjs';

const ENDPOINTS = {
  'transporteya-bridge': 'transporteya',
  'cuando-subo-bridge': 'cuando-subo',
};

export function signedHeaders(body, secret, now = Date.now(), nonce = randomUUID()) {
  if (!secret) throw new Error('Missing Solaris bridge ingest secret');
  const timestamp = String(now);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Solaris-Timestamp': timestamp,
    'X-Solaris-Nonce': nonce,
    'X-Solaris-Signature': `sha256=${signature}`,
  };
}

export async function writeLocalSnapshot(envelope, stateDirectory) {
  assertEnvelope(envelope);
  const outputDirectory = path.join(stateDirectory, 'output');
  await mkdir(outputDirectory, { recursive: true });
  const filename = `${envelope.provider}.json`;
  const destination = path.join(outputDirectory, filename);
  const temporary = path.join(outputDirectory, `.${filename}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}

export async function publishEnvelope(envelope, config) {
  assertEnvelope(envelope);
  const localPath = await writeLocalSnapshot(envelope, config.stateDirectory);
  if (!config.publish) return { mode: 'dry-run', localPath };

  const endpoint = ENDPOINTS[envelope.provider];
  const body = JSON.stringify(envelope);
  const response = await fetch(`${String(config.ingestBaseUrl).replace(/\/$/, '')}/ingest/${endpoint}`, {
    method: 'POST',
    headers: signedHeaders(body, config.ingestSecret),
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Villars ingest returned HTTP ${response.status}`);
  return { mode: 'published', localPath, status: response.status };
}
