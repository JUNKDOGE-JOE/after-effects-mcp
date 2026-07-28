import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderMacosHelperEntitlements,
} from '../macos-helper-entitlements.mjs';

test('release helper entitlements bind Data Protection Keychain to the protected team', () => {
  const rendered = renderMacosHelperEntitlements('ABCDE12345');

  assert.match(
    rendered,
    /<key>com\.apple\.application-identifier<\/key>\s*<string>ABCDE12345\.com\.junkdoge\.ae-mcp\.platform-helper<\/string>/,
  );
  assert.match(
    rendered,
    /<key>keychain-access-groups<\/key>\s*<array>\s*<string>ABCDE12345\.com\.junkdoge\.ae-mcp\.platform-helper<\/string>\s*<\/array>/,
  );
  assert.doesNotMatch(rendered, /__AE_MCP_APPLE_TEAM_ID__/);
});

test('release helper entitlements reject an unprotected or malformed team id', () => {
  for (const value of ['', 'abcde12345', 'ABCDE1234', 'ABCDE12345.extra']) {
    assert.throws(
      () => renderMacosHelperEntitlements(value),
      { code: 'SIGNING_IDENTITY_INVALID' },
    );
  }
});
