// Writes the export under the platform log root and reveals it natively.
import { createPlatformAdapter } from './platform/index.js';

export function writeLogExport({ text, fileName, platform, fsImpl }) {
  const adapter = platform || createPlatformAdapter();
  const fs = fsImpl || adapter.fs;
  const dir = adapter.paths.logsRoot;
  const safeName = String(fileName || '');
  if (!safeName || adapter.paths.basename(safeName) !== safeName || safeName === '.' || safeName === '..') {
    throw new Error('Log export file name must be a single safe path component');
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = adapter.paths.join([dir, safeName]);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

export function revealLogExport(filePath, platform) {
  const adapter = platform || createPlatformAdapter();
  return adapter.revealFile(filePath);
}

export function revealInExplorer(filePath, _unused, onError) {
  const result = revealLogExport(filePath);
  result.catch((error) => { if (onError) onError(error); });
  return result;
}
