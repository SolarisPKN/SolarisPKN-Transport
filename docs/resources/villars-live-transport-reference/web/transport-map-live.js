export function routeFamily(feature) {
  if (feature?.properties?.lineKey) return feature.properties.lineKey;
  const identifier = String(feature?.properties?.routeId || feature?.properties?.id || '');
  if (identifier === 'sofse-67') return 'belgrano-sur';
  if (identifier === 'sofse-53') return 'sarmiento-merlo-lobos';
  if (identifier === '135_1623' || identifier === '135_1624' || identifier.includes('322-lujan')) return '322-lujan';
  if (identifier === '135_1625' || identifier === '135_1626' || identifier.includes('322-canuelas')) return '322-canuelas';
  if (identifier.startsWith('739_') || identifier.includes('136-rapido')) return '136-rapido';
  if (identifier.includes('136')) return '136-villars';
  if (feature?.properties?.mode === 'train') return 'belgrano-sur';
  return 'bus';
}

export function featureIsVisible(feature, filters) {
  return filters.modes.has(feature?.properties?.mode) && filters.routes.has(routeFamily(feature));
}
