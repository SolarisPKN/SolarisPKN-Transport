import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { executionPlan, validateConfig } from '../live/src/config.js';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.resolve(root, process.env.LIVE_CONFIG_PATH || 'config/live.json');
const output = path.resolve(root, '.live-build');
const config = validateConfig(JSON.parse(await fs.readFile(configPath, 'utf8')));
const workerName = process.env.LIVE_WORKER_NAME || config.deployment.workerName;
const bucketName = process.env.LIVE_R2_BUCKET_NAME || config.deployment.r2Bucket;
if (!/^[a-z0-9-]{1,63}$/.test(workerName) || !/^[a-z0-9-]{3,63}$/.test(bucketName)) throw new Error('Nombre de Worker o bucket R2 inválido.');
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await build({
  entryPoints: [path.resolve(root, 'live/src/index.js')],
  outfile: path.resolve(output, 'worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  define: { __LIVE_CONFIG__: JSON.stringify(config) },
});
const wrangler = {
  $schema: 'node_modules/wrangler/config-schema.json',
  name: workerName,
  main: 'worker.mjs',
  compatibility_date: '2026-08-25',
  observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 1 } },
  workers_dev: false,
  preview_urls: false,
  r2_buckets: [{ binding: 'TRANSPORT_LIVE', bucket_name: bucketName }],
  triggers: { crons: [config.deployment.cron] },
};
await fs.writeFile(path.resolve(output, 'wrangler.jsonc'), `${JSON.stringify(wrangler, null, 2)}\n`);
await fs.writeFile(path.resolve(output, 'execution-plan.json'), `${JSON.stringify(executionPlan(config), null, 2)}\n`);
await fs.writeFile(path.resolve(output, 'r2-cors.json'), `${JSON.stringify({ rules: [{ allowed: { origins: config.deployment.allowedOrigins, methods: ['GET', 'HEAD'], headers: ['accept', 'if-none-match', 'range'] }, exposeHeaders: ['etag', 'content-length', 'content-range', 'accept-ranges'], maxAgeSeconds: 3600 }] }, null, 2)}\n`);
console.log(`Worker compilado: ${workerName}; R2: ${bucketName}; cron: ${config.deployment.cron}`);
