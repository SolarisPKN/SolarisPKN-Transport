const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['quot', '"'], ['apos', "'"], ['lt', '<'], ['gt', '>'],
  ['aacute', 'á'], ['eacute', 'é'], ['iacute', 'í'], ['oacute', 'ó'], ['uacute', 'ú'],
  ['Aacute', 'Á'], ['Eacute', 'É'], ['Iacute', 'Í'], ['Oacute', 'Ó'], ['Uacute', 'Ú'],
  ['ntilde', 'ñ'], ['Ntilde', 'Ñ'], ['ordm', 'º'], ['deg', '°'], ['nbsp', ' '],
]);

export function decodeHtml(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return NAMED_ENTITIES.get(entity) ?? match;
  });
}

export function plainText(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
