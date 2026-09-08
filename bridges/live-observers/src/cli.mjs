import { loadConfig } from './config.mjs';
import { runCuandoSubo } from './cuando-subo.mjs';

const provider = process.argv[2];
const once = process.argv.includes('--once');
const controller = new AbortController();

for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => controller.abort());
}

const config = await loadConfig();
console.log(`[bridge] config: ${config.configPath}`);
console.log(`[bridge] publication: ${config.publish ? 'enabled' : 'dry-run'}`);

if (provider === 'cuando-subo') {
  await runCuandoSubo(config, { once, signal: controller.signal });
} else {
  throw new Error('Use cuando-subo as the provider. Transporte YA automation is disabled by its public no-scraping notice.');
}
