import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { cleanupArchivedDay, prepareArchiveDay } from '../scripts/archive-live-history.mjs';

function storeFrom(entries, { failGet = false } = {}) {
  const map = new Map(entries);
  const deleted = [];
  return { deleted, list: async (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)), get: async (key) => { if (failGet) throw new Error('falló'); return map.get(key); }, delete: async (key) => { deleted.push(key); map.delete(key); } };
}

test('Registry ordena, comprime y borra R2 sólo después de verificar', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-'));
  const record = (generatedAt, mode) => Buffer.from(JSON.stringify({ schemaVersion: 2, generatedAt, mode, events: [] }));
  const store = storeFrom([
    ['history/2026-09-10/0002-bus.json', record('2026-09-10T00:02:00Z', 'bus')],
    ['history/2026-09-10/0000-train.json', record('2026-09-10T00:00:00Z', 'train')],
  ]);
  const manifestPath = path.join(tmp, 'manifest.json');
  const result = await prepareArchiveDay({ day: '2026-09-10', store, outputRoot: tmp, manifestPath });
  assert.equal(result.count, 2);
  assert.equal(store.deleted.length, 0);
  await cleanupArchivedDay({ store, manifestPath });
  assert.equal(store.deleted.length, 2);
  const text = gunzipSync(await fs.readFile(result.outputPath)).toString('utf8');
  assert.ok(text.indexOf('0000-train') < text.indexOf('0002-bus'));
});

test('si falla el archivado no borra R2', async () => {
  const store = storeFrom([['history/2026-09-10/0000-train.json', Buffer.from('{}')]], { failGet: true });
  await assert.rejects(() => prepareArchiveDay({ day: '2026-09-10', store, outputRoot: os.tmpdir(), manifestPath: path.join(os.tmpdir(), `manifest-${Date.now()}.json`) }));
  assert.deepEqual(store.deleted, []);
});
