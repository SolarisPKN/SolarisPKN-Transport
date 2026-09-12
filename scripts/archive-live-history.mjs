import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');

export function previousUtcDay(now = new Date()) {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export function validateHistoryRecord(record, key) {
  if (record?.schemaVersion !== 2 || !['train', 'bus'].includes(record?.mode) || !Array.isArray(record?.events)) {
    throw new Error(`Histórico inválido: ${key}`);
  }
  if (!Number.isFinite(new Date(record.generatedAt).getTime())) throw new Error(`generatedAt inválido: ${key}`);
  return record;
}

export async function prepareArchiveDay({ day, store, outputRoot = path.resolve(root, 'History'), manifestPath = path.resolve(root, '.live-build/archive-manifest.json') }) {
  const prefix = `history/${day}/`;
  const keys = (await store.list(prefix)).filter((key) => key.endsWith('.json')).sort();
  if (!keys.length) return { day, archived: false, count: 0, pendingDelete: 0 };
  const records = [];
  for (const key of keys) {
    const body = await store.get(key);
    const record = validateHistoryRecord(JSON.parse(Buffer.from(body).toString('utf8')), key);
    records.push({ key, record });
  }
  records.sort((a, b) => a.record.generatedAt.localeCompare(b.record.generatedAt) || a.key.localeCompare(b.key));
  const ndjson = records.map(({ key, record }) => JSON.stringify({ historyKey: key, ...record })).join('\n') + '\n';
  const gzip = gzipSync(ndjson, { level: 9, mtime: 0 });
  const [year, month] = day.split('-');
  const directory = path.resolve(outputRoot, year, month);
  const outputPath = path.resolve(directory, `registry-${day}.ndjson.gz`);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, gzip);
  const verified = gunzipSync(await fs.readFile(temporary)).toString('utf8');
  if (verified !== ndjson || verified.trim().split('\n').length !== records.length) throw new Error('El Registry escrito no superó la verificación; R2 se conserva.');
  await fs.rename(temporary, outputPath);
  const finalVerified = gunzipSync(await fs.readFile(outputPath)).toString('utf8');
  if (finalVerified !== ndjson) throw new Error('El Registry final no coincide; R2 se conserva.');
  const digest = createHash('sha256').update(await fs.readFile(outputPath)).digest('hex');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify({ day, outputPath, digest, keys }, null, 2)}\n`);
  return { day, archived: true, count: records.length, pendingDelete: keys.length, outputPath, manifestPath };
}

export async function cleanupArchivedDay({ store, manifestPath = path.resolve(root, '.live-build/archive-manifest.json') }) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const bytes = await fs.readFile(manifest.outputPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== manifest.digest) throw new Error('El Registry cambió después de prepararse; R2 se conserva.');
  const rows = gunzipSync(bytes).toString('utf8').trim().split('\n').filter(Boolean);
  if (rows.length !== manifest.keys.length) throw new Error('El Registry final no contiene todos los históricos; R2 se conserva.');
  for (const key of manifest.keys) await store.delete(key);
  return { day: manifest.day, deleted: manifest.keys.length, outputPath: manifest.outputPath };
}

export async function archiveDay({ day, store, outputRoot, manifestPath }) {
  const prepared = await prepareArchiveDay({ day, store, outputRoot, manifestPath });
  if (!prepared.archived) return { ...prepared, deleted: 0 };
  const cleaned = await cleanupArchivedDay({ store, manifestPath: prepared.manifestPath });
  return { ...prepared, deleted: cleaned.deleted };
}

async function s3StoreFromEnvironment() {
  const required = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'LIVE_R2_BUCKET_NAME'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Faltan variables para archivar R2: ${missing.join(', ')}`);
  const { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const bucket = process.env.LIVE_R2_BUCKET_NAME;
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  return {
    async list(prefix) {
      const keys = [];
      let ContinuationToken;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
        keys.push(...(page.Contents || []).map((item) => item.Key).filter(Boolean));
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return keys;
    },
    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return response.Body.transformToByteArray();
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const day = process.env.ARCHIVE_DAY || previousUtcDay();
  const store = await s3StoreFromEnvironment();
  const result = process.argv.includes('--cleanup')
    ? await cleanupArchivedDay({ store })
    : await prepareArchiveDay({ day, store });
  console.log(JSON.stringify(result));
}
