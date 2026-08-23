export function openCodeCatalogId(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 200 || !/^[a-z0-9._:@/+\-]+$/i.test(text)) return '';
  return text;
}
