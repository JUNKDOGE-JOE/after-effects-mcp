import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function testFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (/\.test\.(?:cjs|js|mjs)$/u.test(entry.name)) files.push(target);
    }
  }
  return files.sort();
}

export async function importDirectoryTests(directoryUrl) {
  const root = fileURLToPath(new URL('.', directoryUrl));
  for (const file of testFiles(root)) await import(pathToFileURL(file).href);
}
