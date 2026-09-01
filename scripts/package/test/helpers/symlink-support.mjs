import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let windowsProbe;

function probeWindowsSymlink() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-symlink-probe-'));
  try {
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    fs.writeFileSync(target, 'probe');
    fs.symlinkSync(target, link, 'file');
    return Object.freeze({ available: true });
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      return Object.freeze({
        available: false,
        reason: `Windows symbolic-link creation is unavailable (${error.code})`,
      });
    }
    throw error;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function skipIfSymlinkUnavailable(t) {
  if (process.platform !== 'win32') return false;
  windowsProbe ??= probeWindowsSymlink();
  if (windowsProbe.available) return false;
  t.skip(windowsProbe.reason);
  return true;
}

// macOS development tooling (doctor, launcher, dev installer) runs only on
// macOS; elsewhere these suites skip even when symlinks are available.
export function skipUnlessMacOS(t) {
  if (process.platform === 'darwin') return false;
  t.skip('macOS development tooling only runs on macOS');
  return true;
}
