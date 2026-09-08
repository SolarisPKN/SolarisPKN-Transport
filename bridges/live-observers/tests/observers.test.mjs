import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createEnvelope, validateEnvelope } from '../src/contract.mjs';
import { parseCuandoSuboStopPage } from '../src/cuando-subo.mjs';
import { signedHeaders } from '../src/publisher.mjs';

test('Cuándo SUBO public HTML parser keeps only configured routes', async () => {
  const html = await readFile(new URL('./fixtures/cuando-subo-stop.html', import.meta.url), 'utf8');
  const arrivals = parseCuandoSuboStopPage(html, {
    id: '14_demo',
    name: 'Acceso a Villars',
    routeIds: ['135_1624'],
  }, new Date('2026-09-02T15:00:00.000Z'));
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].tripId, '135_demo-1');
  assert.equal(arrivals[0].destination, 'Luján');
  assert.equal(arrivals[0].etaMinutes, 32);
});

test('bridge envelope differentiates positions from arrival observations', () => {
  const now = new Date('2026-09-02T15:00:00.000Z');
  const envelope = createEnvelope('cuando-subo-bridge', {
    arrivals: [{
      routeId: '739_670', tripId: '739_demo-1', stopId: '14_demo', stopName: 'Zamudio',
      destination: 'Navarro', scheduledTime: '15:30', etaMinutes: 30, observedAt: now.toISOString(),
    }],
    now,
    ttlMs: 900_000,
  });
  assert.equal(validateEnvelope(envelope).ok, true);
  assert.deepEqual(envelope.vehicles, []);
  assert.equal(envelope.arrivals.length, 1);
});

test('the Villars observer example covers the rapid 136 and both 322 branches', async () => {
  const config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  const routeIds = new Set(config.cuandoSubo.stops.flatMap((stop) => stop.routeIds));
  for (const routeId of ['739_670', '739_671', '135_1623', '135_1624', '135_1625', '135_1626']) {
    assert.equal(routeIds.has(routeId), true, `missing route ${routeId}`);
  }
  assert.ok(config.cuandoSubo.minimumRequestIntervalMs >= 60_000);
  assert.equal(config.publish, false);
});

test('our ingest signature is deterministic and does not expose the secret', () => {
  const headers = signedHeaders('{"ok":true}', 'local-test-secret', 1_788_195_600_000, 'nonce-test');
  assert.equal(headers['X-Solaris-Timestamp'], '1788195600000');
  assert.equal(headers['X-Solaris-Nonce'], 'nonce-test');
  assert.match(headers['X-Solaris-Signature'], /^sha256=[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(headers), /local-test-secret/);
});
