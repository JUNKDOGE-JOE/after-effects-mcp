// Writes the export under ~/.ae-mcp/logs/ and reveals it in Explorer.
function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

export function writeLogExport({ text, fileName, deps }) {
  const req = deps ? null : getCepRequire();
  const fs = deps ? deps.fs : req('fs');
  const os = deps ? deps.os : req('os');
  const path = deps ? deps.path : req('path');
  const dir = path.join(os.homedir(), '.ae-mcp', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

export function revealInExplorer(filePath, execImpl, onError) {
  const exec = execImpl || getCepRequire()('child_process').exec;
  const winPath = String(filePath).replace(/\//g, '\\');
  exec('explorer.exe /select,\"' + winPath + '\"', { windowsHide: true }, (err) => { if (err && onError) onError(err); });
}
