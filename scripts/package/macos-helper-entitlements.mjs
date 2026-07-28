import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const TEAM_ID = /^[A-Z0-9]{10}$/;
const HELPER_ID = 'com.junkdoge.ae-mcp.platform-helper';

function signingError(message) {
  const error = new Error(message);
  error.code = 'SIGNING_IDENTITY_INVALID';
  return error;
}

export function renderMacosHelperEntitlements(teamId) {
  if (!TEAM_ID.test(String(teamId || ''))) {
    throw signingError('protected Apple Team ID is invalid');
  }
  const applicationIdentifier = `${teamId}.${HELPER_ID}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '    <key>com.apple.application-identifier</key>',
    `    <string>${applicationIdentifier}</string>`,
    '    <key>keychain-access-groups</key>',
    '    <array>',
    `        <string>${applicationIdentifier}</string>`,
    '    </array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function parseArguments(argv) {
  let teamId = '';
  let out = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--team-id') teamId = argv[++index] || '';
    else if (argv[index] === '--out') out = argv[++index] || '';
    else throw signingError('expected --team-id and --out');
  }
  if (!teamId || !out) throw signingError('expected --team-id and --out');
  return { teamId, out };
}

export function writeMacosHelperEntitlements({ teamId, out }) {
  fs.writeFileSync(out, renderMacosHelperEntitlements(teamId), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    writeMacosHelperEntitlements(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error?.code || 'SIGNING_IDENTITY_INVALID'}: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
