import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = (path) => fs.readFile(path, 'utf8');

test('product trust policy keeps only secret confidentiality as a runtime security promise', async () => {
  const policy = await read('docs/THREAT_MODEL.md');

  assert.match(policy, /one interactive OS user on the After Effects host/i);
  assert.match(policy, /only runtime confidentiality promise.*provider credentials and API secrets/is);
  assert.match(policy, /second local OS user.*same-UID process/is);
  assert.match(policy, /power-loss continuation.*cross-restart task resumption/is);
  assert.match(policy, /Do not create release gates, acceptance requirements, or hardening Issues/is);
  assert.match(policy, /Correctness and data integrity are retained/);
  assert.match(policy, /no blind retry after an uncertain write/i);
  assert.match(policy, /Release integrity is retained/);
});

test('maintained policy surfaces do not defer local-adversary work to a later milestone', async () => {
  const [agents, readme, issueTemplate, workflow, completionTemplate, runtime, helper, phase0] = await Promise.all([
    read('AGENTS.md'),
    read('README.md'),
    read('.github/ISSUE_TEMPLATE/capability-package.md'),
    read('docs/CAPABILITY_PACKAGE_WORKFLOW.md'),
    read('docs/templates/capability-package-completion.md'),
    read('docs/RUNTIME_MANAGER.md'),
    read('docs/platform/PLATFORM_HELPER_SECURITY.md'),
    read('docs/platform/PHASE0.md'),
  ]);

  assert.match(agents, /only runtime confidentiality commitment.*Provider\/API secrets/is);
  assert.match(agents, /Do not create gates or hardening work for second-user isolation/is);
  assert.doesNotMatch(agents, /later release\/remote\/multi-user security milestone/i);
  assert.match(readme, /implementation details, not a supported defense/i);
  assert.match(issueTemplate, /requires no pairing, connection code, or fingerprint ceremony/i);
  assert.doesNotMatch(issueTemplate, /Pairing and known modal-dialog recovery prepared/i);
  assert.match(workflow, /Power-loss\/cross-restart continuation.*rejected/is);
  assert.doesNotMatch(completionTemplate, /pairing/i);
  assert.match(runtime, /Power-loss continuation.*explicit non-goals/is);
  assert.match(helper, /not a security boundary against another local account/i);
  assert.match(helper, /never falls back to a plaintext provider file/i);
  assert.match(phase0, /accepted limitation rather than an open architecture risk/i);
  assert.match(phase0, /experiment is rejected work/i);
});
