import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { pathExists, sha256File } from './files.mjs';

export async function downloadLockedAsset({ url, sha256, expectedBytes, destination }) {
  if (typeof url !== 'string' || !/^(https|data):/.test(url)) {
    throw new Error(`locked asset URL must use HTTPS: ${url}`);
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`invalid locked SHA-256: ${sha256}`);
  }
  if (
    expectedBytes !== undefined
    && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
  ) {
    throw new Error(`expectedBytes must be a non-negative safe integer: ${expectedBytes}`);
  }

  const resolvedDestination = path.resolve(destination);
  await fs.promises.mkdir(path.dirname(resolvedDestination), { recursive: true });
  if (await pathExists(resolvedDestination)) {
    throw new Error(`destination already exists: ${resolvedDestination}`);
  }
  const temporary = path.join(
    path.dirname(resolvedDestination),
    `.${path.basename(resolvedDestination)}.${process.pid}.${randomUUID()}.download`,
  );

  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`);
    }
    let receivedBytes = 0;
    const exactLength = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (expectedBytes !== undefined && receivedBytes > expectedBytes) {
          callback(new Error(
            `download byte length exceeds expectedBytes for ${url}: `
            + `expected ${expectedBytes}, received more than ${expectedBytes}`,
          ));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      exactLength,
      fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    if (expectedBytes !== undefined && receivedBytes !== expectedBytes) {
      throw new Error(
        `download byte length does not match expectedBytes for ${url}: `
        + `expected ${expectedBytes}, received ${receivedBytes}`,
      );
    }

    const actual = await sha256File(temporary);
    if (actual !== sha256) {
      throw new Error(`SHA-256 mismatch for ${url}: expected ${sha256}, received ${actual}`);
    }

    try {
      await fs.promises.link(temporary, resolvedDestination);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`destination already exists: ${resolvedDestination}`);
      }
      throw error;
    }
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}
