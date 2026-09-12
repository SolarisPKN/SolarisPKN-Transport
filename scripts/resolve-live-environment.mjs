import fs from 'node:fs/promises';
import path from 'node:path';
import { validateConfig } from '../live/src/config.js';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.resolve(root, process.env.LIVE_CONFIG_PATH || 'config/live.json');
const config = validateConfig(JSON.parse(await fs.readFile(configPath, 'utf8')));
const values = {
  LIVE_CONFIG_PATH: path.relative(root, configPath).replaceAll('\\', '/'),
  LIVE_WORKER_NAME: process.env.LIVE_WORKER_NAME || config.deployment.workerName,
  LIVE_R2_BUCKET_NAME: process.env.LIVE_R2_BUCKET_NAME || config.deployment.r2Bucket,
};
for (const value of Object.values(values)) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(value)) throw new Error(`Valor de despliegue inválido: ${value}`);
}
const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
if (process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, lines, 'utf8');
process.stdout.write(lines);
