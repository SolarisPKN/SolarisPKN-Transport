import assert from 'node:assert/strict';
import test from 'node:test';
import { operationalStatusForService } from '../src/utils/transport-operational-status.js';

const route = { type: 'train', lineKey: 'belgrano-sur' };
const service = {
  name: '5010', destination: 'González Catán',
  stops: [{ minutes: 1090 }, { minutes: 1113 }, { minutes: 1133 }],
};
const date = new Date('2026-09-01T21:43:00.000Z');

test('la grilla diferencia estimación activa, confirmación y cancelación explícita', () => {
  const estimated = operationalStatusForService(null, route, 'weekday', service, 'America/Argentina/Buenos_Aires', date);
  assert.deepEqual({ state: estimated.state, label: estimated.label }, { state: 'scheduled-active', label: 'En curso estimado' });

  const confirmed = operationalStatusForService({ services: [{
    provider: 'sofse', lineKey: 'belgrano-sur', serviceNumber: '5010', destination: 'González Catán',
    operationalDate: '2026-09-01', status: 'confirmed',
  }] }, route, 'weekday', service, 'America/Argentina/Buenos_Aires', new Date('2026-09-01T21:00:00.000Z'));
  assert.equal(confirmed.state, 'confirmed');

  const cancelled = operationalStatusForService({ services: [{
    provider: 'sofse', lineKey: 'belgrano-sur', serviceNumber: '5010', destination: 'González Catán',
    operationalDate: '2026-09-01', status: 'cancelled', message: 'Servicio cancelado',
  }] }, route, 'weekday', service, 'America/Argentina/Buenos_Aires', date);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.label, 'Cancelado');

  const delayed = operationalStatusForService({ services: [{
    provider: 'sofse', lineKey: 'belgrano-sur', serviceNumber: '5010', destination: 'González Catán',
    operationalDate: '2026-09-01', status: 'delayed', delayMinutes: 7,
  }] }, route, 'weekday', service, 'America/Argentina/Buenos_Aires', date);
  assert.equal(delayed.state, 'delayed');
  assert.equal(delayed.label, 'Demorado +7 min');
});

test('una formación próxima sin señal dinámica sigue rotulada como programada', () => {
  const status = operationalStatusForService(null, route, 'weekday', service, 'America/Argentina/Buenos_Aires', new Date('2026-09-01T20:00:00.000Z'), 0);
  assert.equal(status.state, 'scheduled');
  assert.equal(status.label, 'Programado');
});
