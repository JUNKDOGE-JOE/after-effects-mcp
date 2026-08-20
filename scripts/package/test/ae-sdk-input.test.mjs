import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  loadAeSdkPolicy,
  parseAeSdkInputArgs,
  validateAeSdkPolicy,
} from '../ae-sdk-input.mjs';

test('the frozen native-plane SDK policy remains canonical and fail-closed', async () => {
  const policy = await loadAeSdkPolicy();
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.sdk.claimedBitness, 64);
  assert.equal(policy.sdk.licenseReview.defaultPolicy, 'deny-unless-scope-approved');
  assert.doesNotThrow(() => validateAeSdkPolicy(policy));
  assert.throws(() => validateAeSdkPolicy({ ...policy, schemaVersion: 2 }), {
    code: 'AE_SDK_POLICY_INVALID',
  });
});

test('SDK input parsing has no private Python or sidecar bootstrap path', () => {
  assert.deepEqual(parseAeSdkInputArgs([
    'verify-repository',
    '--repo-root',
    '.',
  ]), {
    command: 'verify-repository',
    repoRoot: '.',
  });
  assert.throws(() => parseAeSdkInputArgs(['verify-repository', '--python', 'x']), {
    code: 'AE_SDK_ARGUMENT_INVALID',
  });
});

test('current workflows and install docs contain the direct Node/URL setup only', async () => {
  const files = [
    '.github/workflows/ci.yml',
    '.github/workflows/build-rc.yml',
    'README.md',
    'README.zh-CN.md',
  ];
  const contents = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
  assert.ok(contents.slice(0, 2).every((body) => !/python|uv|sidecar/iu.test(body)));
  assert.ok(contents.slice(2).every((body) => /host\/stdio-shim\.js/u.test(body)));
});
