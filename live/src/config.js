export function validateConfig(config) {
  if (config?.schemaVersion !== 1) throw new Error('config/live.json requiere schemaVersion 1.');
  if (config?.deployment?.cron !== '*/2 * * * *') throw new Error('El único cron live permitido es */2 * * * *.');
  const providers = new Map();
  for (const provider of config.providers || []) {
    if (!provider?.id || providers.has(provider.id)) throw new Error('Provider duplicado o sin id.');
    providers.set(provider.id, provider);
  }
  const lines = [];
  for (const line of config.lines || []) {
    if (!line?.id || !['train', 'bus'].includes(line.mode)) throw new Error('Línea live inválida.');
    const connectors = (line.connectors || [])
      .filter((item) => providers.get(item.provider)?.enabled === true)
      .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));
    lines.push({ ...line, connectors });
  }
  return { ...config, lines, providerMap: providers };
}

export function executionPlan(config) {
  const valid = validateConfig(config);
  return {
    schemaVersion: 1,
    cron: valid.deployment.cron,
    categories: { 'minute % 4 = 0': 'train', 'minute % 4 = 2': 'bus' },
    providers: [...valid.providerMap.values()].map(({ id, module, enabled }) => ({ id, module, enabled })),
    lines: valid.lines.filter((line) => line.enabled !== false).map((line) => ({ id: line.id, mode: line.mode, connectors: line.connectors.map((item) => item.provider) })),
  };
}
