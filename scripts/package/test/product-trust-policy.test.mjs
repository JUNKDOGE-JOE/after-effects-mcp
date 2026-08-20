import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = (relative) => fs.readFile(relative, 'utf8');

test('product trust policy keeps secret confidentiality as the only security promise', async () => {
  const policy = await read('docs/THREAT_MODEL.md');
  assert.match(policy, /one interactive OS user on the After Effects host/i);
  assert.match(policy, /only runtime confidentiality promise.*provider credentials and API secrets/is);
  assert.match(policy, /Correctness and data integrity are retained/);
  assert.match(policy, /no blind retry after an uncertain write/i);
  assert.match(policy, /Release integrity is retained/);
});

test('maintained policy surfaces describe the direct panel and signed bundle', async () => {
  const [agents, readme, issueTemplate, workflow, completionTemplate, install] = await Promise.all([
    read('AGENTS.md'),
    read('README.md'),
    read('.github/ISSUE_TEMPLATE/capability-package.md'),
    read('docs/CAPABILITY_PACKAGE_WORKFLOW.md'),
    read('docs/templates/capability-package-completion.md'),
    read('docs/INSTALL.md'),
  ]);
  assert.match(agents, /Provider\/API secrets/is);
  assert.match(agents, /Do not create gates or hardening work for second-user isolation/is);
  assert.match(readme, /127\.0\.0\.1:11488\/mcp/u);
  assert.match(issueTemplate, /requires no pairing, connection code, or fingerprint ceremony/i);
  assert.match(workflow, /Power-loss\/cross-restart continuation.*rejected/is);
  assert.doesNotMatch(completionTemplate, /pairing/i);
  assert.match(install, /host\/stdio-shim\.js/u);
});
