import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = '.github/workflows/release.yml';

async function workflow() {
  return readFile(workflowPath, 'utf8');
}

function step(text, name) {
  const marker = `      - name: ${name}`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = text.indexOf('\n      - name:', start + marker.length);
  return text.slice(start, next === -1 ? text.length : next);
}

test('promotion queues every idempotent retry instead of replacing an older pending run', async () => {
  const text = await workflow();

  assert.match(
    text,
    /concurrency:\n  group: release-v0\.9\.2\n  queue: max\n  cancel-in-progress: false/,
  );
});

test('build inventory requires four live release artifacts and only permits two optional preflight artifacts', async () => {
  const text = await workflow();
  const docs = await readFile('docs/RELEASE.md', 'utf8');
  const body = step(text, 'Resolve one successful build run and four exact artifact IDs');
  const tag = step(text, 'Revalidate active evidence and create or verify annotated tag');

  assert.match(body, /const allowedPreflightNames = new Set\(\[/);
  assert.match(body, /ae-mcp-zxpsigncmd-4\.1\.3-macos-x86_64/);
  assert.match(body, /ae-mcp-zxpsigncmd-4\.1\.3-windows-x64/);
  assert.match(body, /artifacts\.length < expectedNames\.size/);
  assert.match(body, /artifacts\.length > expectedNames\.size \+ allowedPreflightNames\.size/);
  assert.match(body, /seenNames\.has\(artifact\.name\)/);
  assert.match(body, /!Number\.isSafeInteger\(artifact\.id\).*artifact\.size_in_bytes <= 0/s);
  assert.match(body, /const outputName = expectedNames\.get\(artifact\.name\)/);
  assert.match(body, /if \(outputName\)[\s\S]*artifact\.expired === true[\s\S]*core\.setOutput\(outputName/);
  assert.match(body, /else if \(!allowedPreflightNames\.has\(artifact\.name\)\)/);
  assert.doesNotMatch(body, /artifacts\.length !== expectedNames\.size/);

  assert.match(tag, /const allowedPreflightNames = new Set\(\[/);
  assert.match(tag, /ae-mcp-zxpsigncmd-4\.1\.3-macos-x86_64/);
  assert.match(tag, /ae-mcp-zxpsigncmd-4\.1\.3-windows-x64/);
  assert.match(tag, /const releaseArtifacts = \[\]/);
  assert.match(tag, /if \(expectedArtifactId\)[\s\S]*artifact\.expired === true[\s\S]*releaseArtifacts\.push/);
  assert.match(tag, /else if \(!allowedPreflightNames\.has\(artifact\.name\)\)/);
  assert.doesNotMatch(tag, /JSON\.stringify\(actual\) !== JSON\.stringify\(wanted\)/);
  assert.match(docs, /preflight artifact[^\n]*(?:过期|清理|缺失)[^\n]*(?:四个|4 个)[^\n]*(?:下载|晋级)/i);
});

test('draft promotion persists one release ID and never resolves mutable assets by tag', async () => {
  const text = await workflow();

  assert.match(text, /repos\.listReleases/);
  assert.match(text, /repos\.createRelease/);
  assert.match(text, /core\.setOutput\('release_id', String\(release\.id\)\)/);
  assert.doesNotMatch(text, /repos\.getReleaseByTag|repos\.getRelease\s*\(|gh release/);
  assert.doesNotMatch(text, /releases\/download\//);
  assert.ok((text.match(/RELEASE_ID: \$\{\{ steps\.release\.outputs\.release_id \}\}/g) || []).length >= 4);
  assert.ok((text.match(/releases\/assets\/\$\{asset\.id\}/g) || []).length >= 2);

  for (const name of [
    'Download pre-existing release assets without replacement',
    'Download the complete draft assets for post-upload verification',
  ]) {
    const body = step(text, name);
    assert.match(body, /inventory\.releaseId !== process\.env\.RELEASE_ID/);
    assert.match(body, /releases\/assets\/\$\{asset\.id\}/);
  }
});

test('tag gate independently reconciles every current PR comment and binds Check provenance to one workflow run', async () => {
  const text = await workflow();
  const body = step(text, 'Revalidate active evidence and create or verify annotated tag');

  assert.match(body, /reconcileAttestationState/);
  assert.match(body, /issues\.listComments/);
  assert.match(body, /action: 'created'/);
  assert.match(body, /current valid FAIL comment blocks promotion|candidateRejected/);
  assert.match(body, /candidate attestation latest attempt must complete successfully/);
  assert.match(body, /actions\.getWorkflowRun/);
  assert.match(body, /actions\.getWorkflow/);
  assert.match(body, /run\.run_attempt/);
  assert.match(body, /run\.head_sha/);
  assert.match(body, /runPath[^\n]*attestation\.yml|workflowPath[^\n]*attestation\.yml/);
  assert.match(body, /assertActiveAttestationRunProvenance/);
  assert.match(body, /provenance/);
  assert.match(body, /commentAudit/);
});

test('attestation writers and promotion share the exact Actions run details URL contract', async () => {
  const promotion = await workflow();
  const attestation = await readFile('.github/workflows/attestation.yml', 'utf8');

  assert.equal((attestation.match(/buildActionsRunDetailsUrl/g) || []).length, 4);
  assert.equal((attestation.match(/details_url: detailsUrl/g) || []).length, 2);
  assert.doesNotMatch(attestation, /details_url: context\.payload\.issue\.html_url/);
  assert.match(promotion, /assertActiveAttestationRunProvenance/);
  assert.match(promotion, /state\.activeRunId/);
  assert.match(promotion, /state\.activeRunAttempt/);
  assert.doesNotMatch(promotion, /actions\/runs\/\(\\d\+\)\/attempts\/\(\\d\+\)/);
});

test('tag and publish reject every candidate attestation run whose latest attempt is not successful', async () => {
  const text = await workflow();
  const docs = await readFile('docs/RELEASE.md', 'utf8');
  const tag = step(text, 'Revalidate active evidence and create or verify annotated tag');
  const publish = step(text, 'Revalidate comments, Checks, tag, and downloaded assets before publication');

  for (const body of [tag, publish]) {
    assert.match(body, /async function requireLatestAttestationAttemptsSuccessful/);
    assert.match(body, /listAllWorkflowRunsForWorkflow/);
    assert.match(body, /const latestByRun = new Map\(\)/);
    assert.match(body, /run\.status !== 'completed'/);
    assert.match(body, /run\.conclusion !== 'success'/);
    assert.match(body, /await requireLatestAttestationAttemptsSuccessful\(/);
    assert.doesNotMatch(body, /for \(const status of \['queued', 'in_progress'/);
  }
  assert.match(docs, /latest attempt[^\n]*(?:completed[^\n]*success|成功)[^\n]*(?:rerun|重跑)/i);
});

test('promotion and attestation enumerate deterministic Checks through check suites', async () => {
  const promotion = await workflow();
  const attestation = await readFile('.github/workflows/attestation.yml', 'utf8');

  assert.match(promotion, /listAllCheckRunsForRef/);
  assert.match(attestation, /listAllCheckRunsForRef/);
  assert.doesNotMatch(promotion, /checks\.listForRef/);
  assert.doesNotMatch(attestation, /checks\.listForRef/);
  assert.doesNotMatch(
    promotion,
    /listWorkflowRuns,[\s\S]{0,180}event:\s*'issue_comment'/,
  );
});

test('irreversible tag and publication mutations have adjacent full revalidation gates', async () => {
  const text = await workflow();
  const docs = await readFile('docs/RELEASE.md', 'utf8');
  const tag = step(text, 'Revalidate active evidence and create or verify annotated tag');
  const publish = step(text, 'Revalidate comments, Checks, tag, and downloaded assets before publication');

  assert.match(tag, /async function revalidateTagGate/);
  assert.match(tag, /await revalidateTagGate\([^;]*\);\s*await github\.rest\.git\.createRef/s);
  assert.match(tag, /repos\.getBranch/);
  assert.match(tag, /issues\.listComments/);
  assert.match(tag, /listAllCheckRunsForRef/);

  assert.match(publish, /async function revalidatePublicationGate/);
  assert.match(
    publish,
    /const publishableRelease = await revalidatePublicationGate\(true\);\s*const \{ data: published \} = await github\.rest\.repos\.updateRelease/s,
  );
  assert.match(
    publish,
    /repos\.updateRelease\([\s\S]*const publishedRelease = await revalidatePublicationGate\(false\)/,
  );
  assert.match(publish, /release\.draft !== expectedDraft/);
  assert.match(publish, /repos\.getBranch/);
  assert.match(publish, /git\.getRef/);
  assert.match(publish, /issues\.listComments/);
  assert.match(publish, /checks\.get/);
  assert.match(publish, /listAllWorkflowRunsForWorkflow/);
  assert.match(publish, /repos\.listReleaseAssets/);
  assert.match(docs, /tag ruleset[\s\S]{0,240}merge freeze/i);
  assert.match(docs, /标签规则集[\s\S]{0,240}合并冻结/);
});

test('protected admin-read token proves immutable releases before tag and publish and publication verifies immutable result', async () => {
  const text = await workflow();
  const tag = step(text, 'Revalidate active evidence and create or verify annotated tag');
  const publish = step(text, 'Revalidate comments, Checks, tag, and downloaded assets before publication');
  const docs = await readFile('docs/RELEASE.md', 'utf8');

  for (const body of [tag, publish]) {
    assert.match(body, /AE_MCP_RELEASE_ADMIN_TOKEN/);
    assert.match(body, /\/immutable-releases/);
    assert.match(body, /X-GitHub-Api-Version: 2026-03-10/);
    assert.match(body, /immutable\?\.enabled !== true/);
  }
  assert.match(publish, /published\.immutable !== true/);
  assert.match(publish, /!release\.draft && release\.immutable !== true/);
  assert.match(docs, /AE_MCP_RELEASE_ADMIN_TOKEN/);
  assert.match(docs, /Administration[^\n]*read|admin-read/i);
  assert.match(docs, /details_url[^\n]*actions\/runs|workflow run[^\n]*provenance/i);
});

test('promotion remains no-build and no-sign', async () => {
  const text = await workflow();
  assert.doesNotMatch(text, /actions\/upload-artifact/);
  assert.doesNotMatch(text, /npm\s+(?:ci|install|run\s+build)|pip\s+install|uv\s+sync/);
  assert.doesNotMatch(text, /stage-platform-bundle|build-portable-runtime|build-platform-helper/);
  assert.doesNotMatch(
    text,
    /run-signing-plan|codesign|signtool|package-macos-dmg|ZXPSignCmd(?:\.exe)?\s+-(?:sign|verify)/i,
  );
});
