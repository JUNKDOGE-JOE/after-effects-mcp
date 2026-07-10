import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';

import { sha256Directory } from '../lib/files.mjs';
import { auditZxpPayload } from '../lib/zxp-payload-audit.mjs';

const CERTIFICATE_DER_BASE64 = [
  'MIIB+TCCAWICCQC7OUDPw2+G2DANBgkqhkiG9w0BAQsFADBBMQswCQYDVQQGEwJV',
  'UzELMAkGA1UECAwCQ0ExDzANBgNVBAoMBkFFLU1DUDEUMBIGA1UEAwwLQUUtTUNQ',
  'LVRlc3QwHhcNMjYwNzEwMDYyMTExWhcNMzcwOTI2MDYyMTExWjBBMQswCQYDVQQG',
  'EwJVUzELMAkGA1UECAwCQ0ExDzANBgNVBAoMBkFFLU1DUDEUMBIGA1UEAwwLQUUt',
  'TUNQLVRlc3QwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBALrHBxhuCW8THU8q',
  'ZFGi/SjKWqpevNWlxv4gby9aLXCx5xTj8Z+jqsO4nLICv55KSGDReo/YiBZEE2fs',
  'LwVienewJL8QdjdwOb8g3G9I8Ec6e6JJs1iqVX48zWxjkTHtv10trD7i806HWC3Z',
  'i5oopxwa6uqS41JdmqpaHXBcIGB5AgMBAAEwDQYJKoZIhvcNAQELBQADgYEApeVN',
  'XVvYTgWHG1AV7FG8FENzypv8BfB+HgLcRVSMm1hpqD0gSj6jfLhFIsEYgfDMucLD',
  'w/9UyKuvUHKBF5pWjYFCXd/cRTVAGiAGMlLhSEVaSwb4aMSBVYksEceqK9xJBFwW',
  'xaDFO/A3aoCas0MloSJyVTfSxu3K3/tsC3CcPo0=',
].join('');
const CERTIFICATE_FINGERPRINT = new X509Certificate(
  Buffer.from(CERTIFICATE_DER_BASE64, 'base64'),
).fingerprint256.replaceAll(':', '').toLowerCase();
const CHAIN_LEAF_DER_BASE64 = 'MIIC1DCCAbwCCQD/0OgC/M+aijANBgkqhkiG9w0BAQsFADAsMRkwFwYDVQQDDBBBRSBNQ1AgVGVzdCBSb290MQ8wDQYDVQQKDAZBRSBNQ1AwHhcNMjYwNzEwMDczMzIyWhcNMjcwNzEwMDczMzIyWjAsMRkwFwYDVQQDDBBBRSBNQ1AgVGVzdCBMZWFmMQ8wDQYDVQQKDAZBRSBNQ1AwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDlRrb7vOLT1KOL2J4vXgN0WQlI8BNnqbYT3osaJLUIHZVwsw5B9ROXOsVT9NimKZDRR4VeZTIa2otOft0bKSqgu1iwiOynWshBmz0R1AZ+2PEhQQObHAjsAwNktm8tOL/OCfsPM6AEizoOxXHDpHub/VxbSYk63yZtKfD1XuBxtdtl9J+2W/ue20C5RDdYgqiujS/EP7AFxG81BeTXCJVwQUUMF/8z440URN2xcb57+6kFjdByFWF2qVoze94HarLoi5dBXansvzSqkCcfDmgEC8szTHXs9x8hYKLs6YczWq8Kh56vWcgpAFV7l2Be6aDTNtl3yDAAGlk3mlThY8evAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAJFIUtlVj6YZrBbvX3lU+3ySXVdCphxUlCBlSob/OJI57rl4el0UFMoPXb+z8Vinv9E9UN9XVsNmdn9/kfYa4t7IlWd9iWtJUYz9r5oTWVFsUXAuJkgD4uHA+YvrwqsUJLAR4qpqNxM+41Hmnv4hOHdtagHOYvp9u0rRowPOUc5lcxvDdx4v4tor1pkjNe/yWQCiio1lqMnfHyGiFhY9cU0Us0tgIFUSCZ8xsU8EKNYP/voUiWjcdmnTd5MyEy6hOhXGmT9bUe6Sgtq59NTKNlDiIE/ywxsPJ6G9vOqJYgmWnvl2QG3fWC7WpBn9EBElmvK67Nz/QJFoiUtzaOxdO+w=';
const CHAIN_CA_DER_BASE64 = 'MIIC1DCCAbwCCQCVeQg+KkUXXDANBgkqhkiG9w0BAQsFADAsMRkwFwYDVQQDDBBBRSBNQ1AgVGVzdCBSb290MQ8wDQYDVQQKDAZBRSBNQ1AwHhcNMjYwNzEwMDczMzIyWhcNMzYwNzA3MDczMzIyWjAsMRkwFwYDVQQDDBBBRSBNQ1AgVGVzdCBSb290MQ8wDQYDVQQKDAZBRSBNQ1AwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDp/Mls4iobRPSfRUW3KXIViIBetLG4oteEMD9L8fJ4Jly7BmtSIrufj02oGhlT9DzgY4nUvtqfpWY4nQMhgjFK/rzJ0YBUIRYPlSzxPuO//nU7fY3IPuoF3Q5a43kaWNtiMcom0wBLUvQlawRI2XuUTbULIiJhF0tWWiiet+8fkjBqjfRszHslMeY9j4sTZsYfJK6QbzN85t+5JFdHLgZ+GdrtSFm4hqIyZB4oSHa5fOEktCOQJXHxNFhS0JCGi8TLRRxZ2Sr/jCZPERGZQE0QzSvzqnPaHMwkoXkNBICt5RuUgpQpOD6ey7Stoh7+wFNubrrQ2kUvD1fXb9+9MH0BAgMBAAEwDQYJKoZIhvcNAQELBQADggEBALcXwHQIJ1lvp+oxezQmaMTd6iJTw75sGy/svLpa182abgVBo/LBdB5o84ZHh4X6rhdeD4O31fTIZEY4ayXeAuAn1KzUAzVWehYFBPGSnCB74icaYo3xRLBIsIeSVC5EztnUnDZML1clRrA6v/CO0QLrh1f9JldGxum25cllKPgYCUXhg5EnDRyc5KZDdY30+CPZtCzFk9uBBcEToBYnK9B6nL5fYRp8dvUmntDxN1bPA/PmGoTO8oJ2CoJpkPWb7MywgW2qev8kvNHgKpv5p9M6LZuCCHo8Lbv52QMOggO4Nj835j+YUcYaNT+mSLJ8+EiLvuH4RjQJYJrHB64mVn4=';
const CHAIN_LEAF_FINGERPRINT = new X509Certificate(
  Buffer.from(CHAIN_LEAF_DER_BASE64, 'base64'),
).fingerprint256.replaceAll(':', '').toLowerCase();
const MIMETYPE = 'application/vnd.adobe.air-ucf-package+zip';

async function tempDir(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-zxp-audit-'));
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));
  return root;
}

function makeZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const directory = entry.name.endsWith('/');
    const method = directory || data.length === 0 ? 0 : 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method === 8 ? 20 : 10, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localRecords.push(local, name, compressed);

    const mode = entry.mode ?? (directory ? 0o040755 : 0o100644);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(method === 8 ? 20 : 10, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

function signatureXml(certificate = CERTIFICATE_DER_BASE64) {
  const certificates = Array.isArray(certificate) ? certificate : [certificate];
  return `<signatures><Signature><KeyInfo><X509Data>${certificates.map((value) => `<X509Certificate>${value}</X509Certificate>`).join('')}</X509Data></KeyInfo></Signature></signatures>`;
}

function zxpEntries(payload = 'helper-bytes') {
  return [
    { name: 'META-INF/' },
    { name: 'META-INF/signatures.xml', data: signatureXml() },
    { name: 'mimetype', data: MIMETYPE },
    { name: 'bin/' },
    { name: 'bin/helper', data: payload, mode: 0o100755 },
    { name: 'bundle-manifest.json', data: '{}\n' },
  ];
}

async function fixture(t, entries = zxpEntries()) {
  const root = await tempDir(t);
  const signingRoot = path.join(root, 'signing');
  const zxpPath = path.join(root, 'panel.zxp');
  await fs.promises.mkdir(path.join(signingRoot, 'bin'), { recursive: true });
  await fs.promises.writeFile(path.join(signingRoot, 'bin', 'helper'), 'helper-bytes');
  await fs.promises.chmod(path.join(signingRoot, 'bin', 'helper'), 0o755);
  await fs.promises.writeFile(path.join(signingRoot, 'bundle-manifest.json'), '{}\n');
  await fs.promises.writeFile(zxpPath, makeZip(entries));
  return { signingRoot, zxpPath };
}

test('independently binds every ZXP payload byte, Unix mode, and signer certificate', async (t) => {
  const { signingRoot, zxpPath } = await fixture(t);
  const result = await auditZxpPayload({
    signingRoot,
    zxpPath,
    expectedCertificateFingerprint: CERTIFICATE_FINGERPRINT,
  });
  assert.deepEqual(result, {
    certificateFingerprint: CERTIFICATE_FINGERPRINT,
    payloadSha256: await sha256Directory(signingRoot),
  });
});

test('accepts one unique ordered leaf-to-CA chain and binds the actual leaf signer', async (t) => {
  const entries = zxpEntries().map((entry) => (
    entry.name === 'META-INF/signatures.xml'
      ? { ...entry, data: signatureXml([CHAIN_LEAF_DER_BASE64, CHAIN_CA_DER_BASE64]) }
      : entry
  ));
  const { signingRoot, zxpPath } = await fixture(t, entries);
  const result = await auditZxpPayload({
    signingRoot,
    zxpPath,
    expectedCertificateFingerprint: CHAIN_LEAF_FINGERPRINT,
  });
  assert.equal(result.certificateFingerprint, CHAIN_LEAF_FINGERPRINT);

  const duplicate = entries.map((entry) => (
    entry.name === 'META-INF/signatures.xml'
      ? { ...entry, data: signatureXml([CHAIN_LEAF_DER_BASE64, CHAIN_CA_DER_BASE64, CHAIN_CA_DER_BASE64]) }
      : entry
  ));
  const duplicated = await fixture(t, duplicate);
  await assert.rejects(
    auditZxpPayload({
      signingRoot: duplicated.signingRoot,
      zxpPath: duplicated.zxpPath,
      expectedCertificateFingerprint: CHAIN_LEAF_FINGERPRINT,
    }),
    { code: 'SIGNING_ZXP_ARCHIVE_INVALID' },
  );
});

test('rejects changed, added, missing, or wrong-mode ZXP payload entries', async (t) => {
  for (const [name, mutate] of [
    ['changed', (entries) => entries.map((entry) => (
      entry.name === 'bin/helper' ? { ...entry, data: 'tampered' } : entry
    ))],
    ['added', (entries) => [...entries, { name: 'extra.txt', data: 'extra' }]],
    ['missing', (entries) => entries.filter((entry) => entry.name !== 'bin/helper')],
    ['mode', (entries) => entries.map((entry) => (
      entry.name === 'bin/helper' ? { ...entry, mode: 0o100644 } : entry
    ))],
  ]) {
    const { signingRoot, zxpPath } = await fixture(t, mutate(zxpEntries()));
    await assert.rejects(
      auditZxpPayload({
        signingRoot,
        zxpPath,
        expectedCertificateFingerprint: CERTIFICATE_FINGERPRINT,
      }),
      { code: 'SIGNING_ZXP_PAYLOAD_MISMATCH' },
      name,
    );
  }
});

test('rejects unsafe paths, duplicate portable names, and an unexpected certificate', async (t) => {
  for (const [name, entries, fingerprint] of [
    ['traversal', [...zxpEntries(), { name: '../escape', data: 'x' }], CERTIFICATE_FINGERPRINT],
    ['case duplicate', [...zxpEntries(), { name: 'BIN/HELPER', data: 'x' }], CERTIFICATE_FINGERPRINT],
    ['certificate', zxpEntries(), createHash('sha256').update('other').digest('hex')],
  ]) {
    const { signingRoot, zxpPath } = await fixture(t, entries);
    await assert.rejects(
      auditZxpPayload({
        signingRoot,
        zxpPath,
        expectedCertificateFingerprint: fingerprint,
      }),
      (error) => error?.code === (name === 'certificate'
        ? 'SIGNING_ZXP_CERTIFICATE_MISMATCH'
        : 'SIGNING_ZXP_ARCHIVE_INVALID'),
      name,
    );
  }
});
