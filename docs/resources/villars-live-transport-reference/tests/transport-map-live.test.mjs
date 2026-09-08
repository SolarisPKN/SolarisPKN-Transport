import assert from 'node:assert/strict';
import test from 'node:test';
import { featureIsVisible, routeFamily } from '../src/utils/transport-map-live.js';

test('the Catán-Lozano SOFSE route remains mapped to the Belgrano Sur filter', () => {
  const feature = { properties: { mode: 'train', routeId: 'sofse-67' } };
  assert.equal(routeFamily(feature), 'belgrano-sur');
  assert.equal(featureIsVisible(feature, {
    modes: new Set(['train']),
    routes: new Set(['belgrano-sur']),
  }), true);
});

test('the Merlo-Lobos train and bridge buses keep distinct map families', () => {
  assert.equal(routeFamily({ properties: { mode: 'train', routeId: 'sofse-53' } }), 'sarmiento-merlo-lobos');
  assert.equal(routeFamily({ properties: { mode: 'bus', routeId: '136-villars' } }), '136-villars');
  assert.equal(routeFamily({ properties: { mode: 'bus', routeId: '135_1623' } }), '322-lujan');
  assert.equal(routeFamily({ properties: { mode: 'bus', routeId: '135_1625' } }), '322-canuelas');
  assert.equal(routeFamily({ properties: { mode: 'bus', routeId: '739_670' } }), '136-rapido');
});
