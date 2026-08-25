import assert from 'node:assert/strict';
import test from 'node:test';

import {
  argentinaDate,
  buildAppCredentials,
  collectStationsFromServices,
  deduplicateServices,
  formatArgentinaTimestamp,
  servicesForDate,
} from './sofse_api.mjs';

test('usa el dia argentino y no el dia UTC para autenticar', () => {
  const afterUtcMidnight = new Date('2026-08-24T00:30:00.000Z');
  assert.equal(argentinaDate(afterUtcMidnight), '2026-08-23');
  assert.equal(buildAppCredentials(afterUtcMidnight).username, 'MjAyNjA4MjNzb2ZzZQ==');
});

test('convierte los timestamps UTC de SOFSE a hora argentina', () => {
  assert.equal(formatArgentinaTimestamp('2026-08-23T14:01:00.000Z'), '2026-08-23T11:01:00');
});

test('elimina servicios repetidos por el backend', () => {
  const service = {
    servicio: {
      numero: 5702,
      sentido: 2,
      desde: { idElemento: 6000, salida: { programada: '2026-08-23T14:13:00Z' } },
      hasta: { idElemento: 154, llegada: { programada: '2026-08-23T15:52:00Z' } },
    },
  };
  assert.equal(deduplicateServices({ results: [service, structuredClone(service)] }).length, 1);
});

test('descarta el cronograma del dia siguiente que SOFSE mezcla en la respuesta', () => {
  const service = (fecha, salida) => ({
    servicio: {
      numero: 2803,
      fecha,
      sentido: 1,
      desde: { idElemento: 269, salida: { programada: salida } },
      hasta: { idElemento: 225, llegada: { programada: salida } },
    },
  });

  const response = {
    results: [
      service('2026-08-23T03:00:00Z', '2026-08-23T07:13:00Z'),
      service('2026-08-24T03:00:00Z', '2026-08-23T07:08:00Z'),
    ],
  };

  assert.equal(servicesForDate(response, '2026-08-23').length, 1);
  assert.equal(servicesForDate(response, '2026-08-23')[0].servicio.desde.salida.programada,
    '2026-08-23T07:13:00Z');
});

test('descubre Lozano dentro del itinerario aunque falte en el catalogo', () => {
  const response = {
    results: [{
      servicio: {
        numero: 5701,
        estaciones: [
          { idElemento: 154, nombre: 'Gonzalez Catan', orden: 1, parada: true },
          { idElemento: 6000, idPunto: 8040, nombre: 'Lozano', orden: 19, parada: true },
          { idElemento: 6001, idPunto: 8041, nombre: 'Navarro', orden: 20, parada: false },
        ],
      },
    }],
  };

  assert.deepEqual(collectStationsFromServices(response), [
    { id: 154, nombre: 'Gonzalez Catan', idPunto: null, orden: 1, parada: true },
    { id: 6000, nombre: 'Lozano', idPunto: 8040, orden: 19, parada: true },
    { id: 6001, nombre: 'Navarro', idPunto: 8041, orden: 20, parada: false },
  ]);
});
