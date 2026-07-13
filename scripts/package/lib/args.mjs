const SUPPORTED_PLATFORMS = new Set(['macos-arm64', 'windows-x64']);

function parseLongOptions(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`unknown argument: ${argument}`);
    }

    const equals = argument.indexOf('=');
    const key = equals === -1 ? argument : argument.slice(0, equals);
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (equals === -1) index += 1;
    if (!value || value.startsWith('--')) {
      throw new Error(`unknown argument or missing value: ${key}`);
    }
    if (parsed.has(key)) {
      throw new Error(`duplicate argument: ${key}`);
    }
    parsed.set(key, value);
  }
  return parsed;
}

export function parsePortableRuntimeArgs(argv) {
  const options = parseLongOptions(argv);
  const allowed = new Set(['--platform', '--out']);
  for (const key of options.keys()) {
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
  }

  const platform = options.get('--platform');
  const outDir = options.get('--out');
  if (!platform) throw new Error('--platform is required');
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`unsupported platform: ${platform}`);
  }
  if (!outDir) throw new Error('--out is required');
  return { platform, outDir };
}

export function parseRuntimeInventoryArgs(argv) {
  const options = parseLongOptions(argv);
  const allowed = new Set(['--platform', '--root', '--repo-root', '--license-approval']);
  for (const key of options.keys()) {
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
  }

  const platform = options.get('--platform');
  const runtimeRoot = options.get('--root');
  const repoRoot = options.get('--repo-root') ?? process.cwd();
  if (!platform || !SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`unsupported platform: ${platform ?? '<missing>'}`);
  }
  if (!runtimeRoot) throw new Error('--root is required');
  return {
    platform,
    runtimeRoot,
    repoRoot,
    licenseApprovalPath: options.get('--license-approval'),
  };
}

export { SUPPORTED_PLATFORMS };
