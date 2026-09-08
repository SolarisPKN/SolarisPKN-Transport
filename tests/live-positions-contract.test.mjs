import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  acceptProviderResponse,
  ProviderResponseError,
  refreshSnapshot,
} from '../examples/live-positions/aggregator.mjs';
import { classifySnapshot, markerModel } from '../examples/live-positions/client.mjs';
import { validateSnapshot } from '../examples/live-positions/contract.mjs';

const fixtureDirectory = new URL('./fixtures/live-positions/', import.meta.url);

async function json(name) {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8'));
}

test('the canonical schema is strict Draft 2020-12 JSON Schema', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../docs/contracts/live-positions.schema.json', import.meta.url),
    'utf8',
  ));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'generatedAt',
    'expiresAt',
    'discardAfter',
    'status',
    'sources',
    'vehicles',
    'fallback',
  ]);
  assert.deepEqual(schema.$defs.vehicle.properties.positionKind.enum, ['reported', 'estimated', 'none']);
  assert.deepEqual(schema.$defs.vehicle.properties.dataStatus.enum, ['fresh', 'stale']);
  assert.equal(schema.$defs.vehicle.additionalProperties, false);
});

test('all sanitized positive fixtures satisfy runtime and semantic checks', async () => {
  for (const name of [
    'reported.json',
    'estimated.json',
    'active-without-position.json',
    'partial-provider-failure.json',
    'stale.json',
  ]) {
    const result = validateSnapshot(await json(name));
    assert.equal(result.ok, true, `${name}: ${result.errors.join('; ')}`);
  }
});

test('the negative fixture fails independently useful contract rules', async () => {
  const result = validateSnapshot(await json('invalid.json'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes('expiresAt must be after')));
  assert.ok(result.errors.some((message) => message.includes('position is required')));
  assert.ok(result.errors.some((message) => message.includes('observedAt is required')));
  assert.ok(result.errors.some((message) => message.includes('provider must equal source.id')));
  assert.ok(result.errors.some((message) => message.includes('fallback must not reference')));
});

test('reported, estimated, and missing positions remain distinguishable', async () => {
  const reported = (await json('reported.json')).vehicles[0];
  const estimated = (await json('estimated.json')).vehicles[0];
  const withoutPosition = (await json('active-without-position.json')).vehicles[0];
  assert.equal(markerModel(reported).style, 'reported');
  assert.equal(markerModel(estimated).style, 'estimated');
  assert.equal(withoutPosition.status, 'active');
  assert.equal(markerModel(withoutPosition), null);
});

test('fresh, stale, unavailable, and timetable-only states are separate', async () => {
  const fresh = await json('reported.json');
  const stale = await json('stale.json');
  assert.equal(classifySnapshot(fresh, new Date('2026-08-30T12:01:00.000Z')).kind, 'fresh');
  assert.equal(classifySnapshot(stale, new Date('2026-08-30T12:01:00.000Z')).kind, 'stale');
  assert.equal(classifySnapshot(fresh, new Date('2026-08-30T12:11:00.000Z')).kind, 'timetable-only');
});

test('an HTTP 200 with an invalid semantic body is a provider failure', () => {
  assert.throws(
    () => acceptProviderResponse({
      httpStatus: 200,
      body: { data: {} },
      normalize: () => null,
    }),
    (error) => error instanceof ProviderResponseError
      && error.code === 'semantic-invalid-response',
  );
});

test('a failed provider retains only its still-usable previous vehicles as stale', async () => {
  const previous = await json('reported.json');
  const snapshot = await refreshSnapshot({
    collectors: {
      'provider-a': async () => {
        throw new ProviderResponseError('semantic-invalid-response');
      },
    },
    previous,
    now: new Date('2026-08-30T12:01:00.000Z'),
  });
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.sources[0].status, 'unavailable');
  assert.equal(snapshot.sources[0].errorCode, 'semantic-invalid-response');
  assert.equal(snapshot.vehicles[0].dataStatus, 'stale');
  assert.equal(snapshot.fallback.mode, 'none');
});

test('no valid live state produces an explicit local-timetable fallback', async () => {
  const snapshot = await refreshSnapshot({
    collectors: {
      'provider-a': async () => {
        throw new ProviderResponseError('semantic-invalid-response');
      },
      'provider-b': async () => {
        throw new ProviderResponseError('request-failed');
      },
    },
    now: new Date('2026-08-30T12:01:00.000Z'),
  });
  assert.equal(snapshot.status, 'unavailable');
  assert.deepEqual(snapshot.vehicles, []);
  assert.equal(snapshot.fallback.mode, 'timetable-only');
  assert.equal(snapshot.fallback.timetableRef, 'horarios.db');
});

test('collectors can return an active service without inventing coordinates', async () => {
  const fixture = await json('active-without-position.json');
  const snapshot = await refreshSnapshot({
    collectors: {
      'provider-b': async () => ({ status: 'ok', vehicles: fixture.vehicles }),
    },
    now: new Date('2026-08-30T12:00:00.000Z'),
  });
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.vehicles[0].positionKind, 'none');
  assert.equal(snapshot.vehicles[0].position, null);
});

test('a current provider response cannot silently relabel an old observation as fresh', async () => {
  const fixture = await json('stale.json');
  const snapshot = await refreshSnapshot({
    collectors: {
      'provider-a': async () => ({ status: 'ok', vehicles: fixture.vehicles }),
    },
    now: new Date('2026-08-30T12:00:00.000Z'),
  });
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.sources[0].status, 'ok');
  assert.equal(snapshot.vehicles[0].dataStatus, 'stale');
});

test('an intentionally disabled source is not mislabeled as an invalid response', async () => {
  const snapshot = await refreshSnapshot({
    collectors: { 'provider-a': null },
    now: new Date('2026-08-30T12:00:00.000Z'),
  });
  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.sources[0].status, 'disabled');
  assert.equal(snapshot.fallback.reason, 'live-unavailable');
});
