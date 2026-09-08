import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import worker from '../workers/transport-live/src/index.js';
import {
  bridgeVehiclesForCurrent,
  sanitizeBridgeEnvelope,
} from '../workers/transport-live/src/bridge-ingest.js';

const secret = 'solarispkn-own-test-secret';
const now = new Date();

function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'transporteya-bridge',
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    vehicles: [{
      id: 'bus:transporteya:136-villars:42',
      provider: 'transporteya-bridge',
      mode: 'bus',
      routeId: '136-villars',
      label: 'Colectivo 136 · interno 42',
      status: 'active',
      positionKind: 'reported',
      dataStatus: 'fresh',
      position: { lat: -34.82, lon: -58.94, speedKmh: 31 },
      observedAt: now.toISOString(),
      receivedAt: now.toISOString(),
      source: { id: 'transporteya-bridge', recordId: '42' },
    }],
    arrivals: [],
    ...overrides,
  };
}

function signedRequest(payload, timestamp = now.getTime(), nonce = 'nonce-test-0001') {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');
  return new Request('https://worker.example/ingest/transporteya', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Solaris-Timestamp': String(timestamp),
      'X-Solaris-Nonce': nonce,
      'X-Solaris-Signature': `sha256=${signature}`,
    },
    body,
  });
}

test('signed ingest stores only the sanitized provider envelope', async () => {
  const writes = [];
  const response = await worker.fetch(signedRequest(envelope()), {
    BRIDGE_INGEST_SECRET: secret,
    TRANSPORT_LIVE: {
      get: async () => null,
      put: async (...args) => writes.push(args),
    },
  });
  assert.equal(response.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'bridge/transporteya.json');
  const stored = JSON.parse(writes[0][1]);
  assert.equal(stored.vehicles[0].position.speedKmh, 31);
  assert.doesNotMatch(writes[0][1], /solarispkn-own-test-secret|X-Solaris-Signature/);
});

test('unsigned and wrongly signed bridge writes fail closed', async () => {
  const request = new Request('https://worker.example/ingest/transporteya', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope()),
  });
  const response = await worker.fetch(request, {
    BRIDGE_INGEST_SECRET: secret,
    TRANSPORT_LIVE: { get: async () => null, put: async () => assert.fail('must not write') },
  });
  assert.equal(response.status, 401);
});

test('ingest rejects routes outside the explicit Villars allowlist', () => {
  const candidate = envelope();
  candidate.vehicles[0].routeId = '57';
  assert.throws(() => sanitizeBridgeEnvelope(candidate, 'transporteya', now), /invalid records/i);
});

test('reported bridge position maps to the existing public current.json contract', () => {
  const sanitized = sanitizeBridgeEnvelope(envelope(), 'transporteya', now);
  const [vehicle] = bridgeVehiclesForCurrent(sanitized, now);
  assert.equal(vehicle.provider, 'transporteya-bridge');
  assert.equal(vehicle.routeId, '136-villars');
  assert.equal(vehicle.positionKind, 'observed');
  assert.equal(vehicle.stale, false);
  assert.equal(vehicle.lat, -34.82);
});
