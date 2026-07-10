import fs from 'node:fs';

const MACHO_ARM64_CPU = 0x0100000c;
const MACHO_X64_CPU = 0x01000007;
const PE_AMD64_MACHINE = 0x8664;
const PE_ARM64_MACHINE = 0xaa64;

export function architectureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function detectBinaryArchitecture(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return null;
  const magicLittle = bytes.readUInt32LE(0);
  const magicBig = bytes.readUInt32BE(0);
  if (magicLittle === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    if (cpu === MACHO_ARM64_CPU) return 'macho-arm64';
    if (cpu === MACHO_X64_CPU) return 'macho-x64';
    return 'macho-unknown';
  }
  if (magicBig === 0xfeedfacf) {
    const cpu = bytes.readUInt32BE(4);
    if (cpu === MACHO_ARM64_CPU) return 'macho-arm64';
    if (cpu === MACHO_X64_CPU) return 'macho-x64';
    return 'macho-unknown';
  }
  if ([0xcafebabe, 0xcafebabf].includes(magicBig)
      || [0xbebafeca, 0xbfbafeca].includes(magicLittle)) {
    return 'macho-universal';
  }
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a || bytes.length < 0x40) return null;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset > bytes.length - 6
      || bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') {
    return 'pe-invalid';
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine === PE_AMD64_MACHINE) return 'pe-x64';
  if (machine === PE_ARM64_MACHINE) return 'pe-arm64';
  return 'pe-unknown';
}

export async function detectBinaryArchitectureFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, 1024 * 1024);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, 0);
    return detectBinaryArchitecture(bytes);
  } finally {
    await handle.close();
  }
}

export async function assertBinaryArchitecture(filePath, platform, label = filePath) {
  const actual = await detectBinaryArchitectureFile(filePath);
  const expected = platform === 'macos-arm64' ? 'macho-arm64' : 'pe-x64';
  if (actual !== expected) {
    throw architectureError(
      'BUNDLE_ARCH_MISMATCH',
      `native architecture mismatch for ${label}: expected ${expected}, received ${actual ?? 'non-native'}`,
    );
  }
  return actual;
}
