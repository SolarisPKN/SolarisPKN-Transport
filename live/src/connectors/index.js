import * as sofse from './sofse.js';
import * as gtfsRealtime from './gtfs-realtime.js';
import * as cuandoSubo from './cuando-subo.js';
import * as transporteYa from './transporte-ya.js';

export const CONNECTORS = new Map([
  ['sofse', sofse],
  ['gtfs-realtime', gtfsRealtime],
  ['cuando-subo', cuandoSubo],
  ['transporte-ya', transporteYa],
]);
