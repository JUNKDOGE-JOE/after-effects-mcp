import { validateAttestation } from './attestation.mjs';

const PLATFORMS = ['macos-arm64', 'windows-x64'];
const PLATFORM_SET = new Set(PLATFORMS);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DECIMAL_ID = /^\d+$/;
const POSITIVE_DECIMAL_ID = /^[1-9]\d*$/;
const VERSION = '0.9.2';

function recordIdentity(record, field) {
  return record?.[field] ?? record?.report?.[field];
}

function timestamp(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function uniqueSorted(errors) {
  return [...new Set(errors)].sort();
}

function validateManifestIdentity(candidateSha, manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1) errors.push('manifest schema mismatch');
  if (manifest?.version !== VERSION) errors.push('manifest version mismatch');
  if (manifest?.candidateSha !== candidateSha) errors.push('manifest candidate mismatch');
  if (!DECIMAL_ID.test(String(manifest?.workflowRunId ?? ''))) {
    errors.push('manifest workflow run id mismatch');
  }
  if (!Array.isArray(manifest?.artifacts)) errors.push('manifest artifacts are missing');
  return errors;
}

function expectedAttestation(platform, candidateSha, manifest, artifact) {
  return {
    platform,
    candidateSha,
    workflowRunId: manifest.workflowRunId,
    artifactId: artifact.artifactId,
    artifactName: artifact.name,
    artifactSha256: artifact.sha256,
  };
}

function recordMatches(record, platform, candidateSha, artifactId) {
  return recordIdentity(record, 'platform') === platform
    && recordIdentity(record, 'candidateSha') === candidateSha
    && String(recordIdentity(record, 'artifactId') ?? '') === String(artifactId);
}

export function verifyReleaseInputs({
  candidateSha,
  mainSha,
  manifest,
  attestations,
} = {}) {
  const errors = [];
  if (!SHA.test(String(candidateSha ?? ''))) errors.push('candidate SHA is invalid');
  if (candidateSha !== mainSha) errors.push('candidate is not protected main HEAD');
  errors.push(...validateManifestIdentity(candidateSha, manifest));
  if (!Array.isArray(attestations)) {
    errors.push('attestation history is missing');
    attestations = [];
  }

  for (const platform of PLATFORMS) {
    const artifacts = Array.isArray(manifest?.artifacts)
      ? manifest.artifacts.filter((item) => item?.platform === platform && item?.role === 'install')
      : [];
    if (artifacts.length !== 1) {
      errors.push(`${platform} requires exactly one install artifact`);
      continue;
    }
    const artifact = artifacts[0];
    if (!DECIMAL_ID.test(String(artifact?.artifactId ?? ''))
        || typeof artifact?.name !== 'string'
        || !DIGEST.test(String(artifact?.sha256 ?? ''))) {
      errors.push(`${platform} install artifact identity is invalid`);
      continue;
    }

    const candidates = attestations
      .filter((item) => recordMatches(item, platform, candidateSha, artifact.artifactId))
      .map((item, index) => ({ item, index, updatedAt: timestamp(item?.updatedAt) }))
      .sort((left, right) => {
        if (left.updatedAt === right.updatedAt) return left.index - right.index;
        if (left.updatedAt === null) return -1;
        if (right.updatedAt === null) return 1;
        return left.updatedAt - right.updatedAt;
      });

    if (candidates.some((entry) => entry.updatedAt === null)) {
      errors.push(`${platform} attestation timestamp is invalid`);
    }
    for (let index = 1; index < candidates.length; index += 1) {
      if (candidates[index - 1].updatedAt !== null
          && candidates[index - 1].updatedAt === candidates[index].updatedAt) {
        errors.push(`${platform} attestation history is ambiguous`);
      }
    }

    const expected = expectedAttestation(platform, candidateSha, manifest, artifact);
    let validFailure = false;
    for (const { item } of candidates) {
      if (item?.deleted || !item?.report) continue;
      const reportErrors = validateAttestation(item.report, expected);
      if (reportErrors.length === 0 && item.report.result === 'FAIL') validFailure = true;
    }
    if (validFailure) errors.push(`${platform} candidate was rejected by FAIL`);

    const latest = candidates.at(-1)?.item;
    if (!latest || latest.deleted || !latest.report) {
      errors.push(`${platform} current attestation is missing`);
      continue;
    }
    errors.push(...validateAttestation(latest.report, expected)
      .map((error) => `${platform}: ${error}`));
    if (latest.report.result !== 'PASS') errors.push(`${platform} attestation is not PASS`);
  }

  return uniqueSorted(errors);
}

function newState(event) {
  return {
    schemaVersion: 1,
    candidateSha: event.candidateSha,
    platform: event.platform,
    artifactId: String(event.artifactId),
    artifactSha256: event.artifactSha256,
    activeCommentId: null,
    activeUpdatedAt: 0,
    activeRunId: null,
    activeRunAttempt: 0,
    freshEvidenceAfter: 0,
    candidateRejected: false,
    conclusion: 'failure',
  };
}

function sameStateIdentity(state, event) {
  return state?.schemaVersion === 1
    && state.candidateSha === event.candidateSha
    && state.platform === event.platform
    && String(state.artifactId) === String(event.artifactId)
    && state.artifactSha256 === event.artifactSha256;
}

function cloneState(state) {
  return {
    schemaVersion: 1,
    candidateSha: state.candidateSha,
    platform: state.platform,
    artifactId: String(state.artifactId),
    artifactSha256: state.artifactSha256,
    activeCommentId: state.activeCommentId === null ? null : String(state.activeCommentId),
    activeUpdatedAt: timestamp(state.activeUpdatedAt) ?? 0,
    activeRunId: state.activeRunId === null ? null : String(state.activeRunId),
    activeRunAttempt: Number.isSafeInteger(state.activeRunAttempt) && state.activeRunAttempt >= 0
      ? state.activeRunAttempt : 0,
    freshEvidenceAfter: timestamp(state.freshEvidenceAfter) ?? 0,
    candidateRejected: state.candidateRejected === true,
    conclusion: state.conclusion === 'success' ? 'success' : 'failure',
  };
}

function validateEventIdentity(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('attestation event is required');
  }
  if (!['created', 'edited', 'deleted'].includes(event.action)) {
    throw new Error('invalid attestation event action');
  }
  if (!SHA.test(String(event.candidateSha ?? ''))
      || !PLATFORM_SET.has(event.platform)
      || !DECIMAL_ID.test(String(event.artifactId ?? ''))
      || !DIGEST.test(String(event.artifactSha256 ?? ''))
      || !DECIMAL_ID.test(String(event.commentId ?? ''))
      || timestamp(event.updatedAt) === null) {
    throw new Error('invalid attestation event identity');
  }
  const hasRunId = event.runId !== undefined && event.runId !== null;
  const hasRunAttempt = event.runAttempt !== undefined && event.runAttempt !== null;
  if (hasRunId !== hasRunAttempt
      || (hasRunId && (!POSITIVE_DECIMAL_ID.test(String(event.runId))
        || !Number.isSafeInteger(event.runAttempt) || event.runAttempt < 1))) {
    throw new Error('invalid attestation event run provenance');
  }
}

function clearActiveEvidence(state, updatedAt) {
  state.activeCommentId = null;
  state.activeUpdatedAt = 0;
  state.activeRunId = null;
  state.activeRunAttempt = 0;
  state.freshEvidenceAfter = Math.max(state.freshEvidenceAfter, updatedAt);
  state.conclusion = 'failure';
}

function setActiveEvidence(state, event, commentId, updatedAt) {
  state.activeCommentId = commentId;
  state.activeUpdatedAt = updatedAt;
  if (event.runId !== undefined && event.runId !== null) {
    state.activeRunId = String(event.runId);
    state.activeRunAttempt = event.runAttempt;
  } else {
    state.activeRunId = null;
    state.activeRunAttempt = 0;
  }
}

export function reconcileAttestationState(previous, event) {
  validateEventIdentity(event);
  const updatedAt = timestamp(event.updatedAt);
  const commentId = String(event.commentId);
  const state = sameStateIdentity(previous, event)
    ? cloneState(previous)
    : newState(event);

  if (event.action === 'deleted') {
    if (state.activeCommentId === commentId) clearActiveEvidence(state, updatedAt);
    return state;
  }

  const expected = {
    platform: event.platform,
    candidateSha: event.candidateSha,
    artifactId: String(event.artifactId),
    artifactSha256: event.artifactSha256,
  };
  const reportErrors = event.report
    ? validateAttestation(event.report, expected)
    : ['attestation body is missing'];
  if (reportErrors.length > 0) {
    if (event.action === 'edited' && state.activeCommentId === commentId) {
      clearActiveEvidence(state, updatedAt);
    }
    return state;
  }

  if (event.report.result === 'FAIL') {
    state.candidateRejected = true;
    state.conclusion = 'failure';
    if (updatedAt > state.freshEvidenceAfter && updatedAt >= state.activeUpdatedAt) {
      setActiveEvidence(state, event, commentId, updatedAt);
    }
    return state;
  }

  if (updatedAt <= state.freshEvidenceAfter || updatedAt < state.activeUpdatedAt) return state;

  setActiveEvidence(state, event, commentId, updatedAt);
  state.conclusion = state.candidateRejected ? 'failure' : 'success';
  return state;
}
