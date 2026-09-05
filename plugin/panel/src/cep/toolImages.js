import { attachmentFileUrl } from '../../../shared/chat-attachments.mjs';

const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const CACHE_BYTES = 64 * 1024 * 1024;
const RESULT_CHARS = 12 * 1024 * 1024;
const CACHE_AGE = 7 * 24 * 60 * 60 * 1000;
let sequence = 0;

export function toolDisplayText(value) {
  return String(value || '').replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[image]')
    .replace(/("base64"\s*:\s*")[^"]*(")/g, '$1[image]$2');
}

export function captureToolImages(content, adapter) {
  const parts = Array.isArray(content) ? content : [];
  const candidates = parts.filter((part) => part && (part.type === 'image'
    || (part.type === 'file' && String(part.mime || part.mimeType || '').startsWith('image/'))));
  if (!candidates.length) return {};
  const fs = adapter?.fs;
  const now = Date.now();
  let remaining = RESULT_CHARS;
  let cache;
  let files;
  let bytes = 0;
  function prepareCache() {
    if (files) return;
    cache = adapter.paths.join([adapter.paths.configRoot, 'tool-images']);
    fs.mkdirSync(cache, { recursive: true });
    files = fs.readdirSync(cache).filter((name) => /^preview-[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(name))
      .map((name) => {
        const path = adapter.paths.join([cache, name]);
        const stat = fs.statSync(path);
        return { path, size: stat.size, time: stat.mtimeMs };
      }).sort((a, b) => a.time - b.time);
    bytes = files.reduce((total, file) => total + file.size, 0);
  }
  const images = candidates.slice(0, 32).map((part) => {
    const source = part.source || part;
    const url = part.url || source.url || '';
    const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
    const mimeType = source.media_type || part.mimeType || part.mime || match?.[1];
    const data = source.data || match?.[2];
    if (!TYPES[mimeType]) return { unavailable: 'format' };
    if (!data && /^file:\/\//.test(url) && url.length < 4096) return { src: url };
    if (typeof data !== 'string' || !data.length || data.length % 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { unavailable: 'load' };
    if (data.length > 4.5 * 1024 * 1024 || data.length > remaining) return { unavailable: 'limit' };
    remaining -= data.length;
    let path;
    try {
      prepareCache();
      const size = Math.floor(data.length * 3 / 4);
      while (files.length && (bytes + size > CACHE_BYTES || files.length >= 256 || files[0].time < now - CACHE_AGE)) {
        const file = files[0];
        fs.unlinkSync(file.path);
        bytes -= file.size;
        files.shift();
      }
      path = adapter.paths.join([cache, `preview-${now.toString(36)}-${Math.random().toString(36).slice(2)}-${++sequence}.${TYPES[mimeType]}`]);
      fs.writeFileSync(path, data, { encoding: 'base64', flag: 'wx' });
      bytes += size;
      files.push({ path, size, time: now });
      return { src: attachmentFileUrl(path, adapter.id) };
    } catch {
      if (path) { try { fs.unlinkSync(path); } catch {} }
      return { unavailable: 'load' };
    }
  });
  if (candidates.length > 32) images.push({ unavailable: 'limit' });
  return { images };
}
