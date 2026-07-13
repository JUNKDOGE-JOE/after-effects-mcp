const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function canonicalServerUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password
      || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('invalid GitHub server URL');
  }
  return url.origin;
}

function positiveDecimal(value, field) {
  const text = String(value || '');
  const numeric = Number(text);
  if (!POSITIVE_DECIMAL.test(text) || !Number.isSafeInteger(numeric) || numeric < 1) {
    throw new Error(`invalid Actions ${field}`);
  }
  return text;
}

function repositoryName(value) {
  const repository = String(value || '');
  if (!REPOSITORY.test(repository)) throw new Error('invalid GitHub repository identity');
  return repository;
}

export function buildActionsRunDetailsUrl({
  serverUrl,
  repository,
  runId,
  runAttempt,
} = {}) {
  const origin = canonicalServerUrl(serverUrl);
  const name = repositoryName(repository);
  const id = positiveDecimal(runId, 'run identity');
  const attempt = positiveDecimal(runAttempt, 'run identity');
  return `${origin}/${name}/actions/runs/${id}/attempts/${attempt}`;
}

export function parseActionsRunDetailsUrl(value, {
  serverUrl,
  repository,
} = {}) {
  const origin = canonicalServerUrl(serverUrl);
  const name = repositoryName(repository);
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('Check details_url is not the exact Actions run URL');
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = url.pathname.match(new RegExp(
    `^/${escaped}/actions/runs/([1-9]\\d*)/attempts/([1-9]\\d*)$`,
  ));
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || !match) {
    throw new Error('Check details_url is not the exact Actions run URL');
  }
  const runId = positiveDecimal(match[1], 'run identity');
  const runAttempt = Number(positiveDecimal(match[2], 'run identity'));
  return { runId, runAttempt };
}

export function assertActiveAttestationRunProvenance(state, detailsUrl, options = {}) {
  const parsed = parseActionsRunDetailsUrl(detailsUrl, options);
  if (typeof state?.activeRunId !== 'string'
      || state.activeRunId !== parsed.runId
      || !Number.isSafeInteger(state?.activeRunAttempt)
      || state.activeRunAttempt < 1
      || state.activeRunAttempt !== parsed.runAttempt) {
    throw new Error('active attestation run provenance mismatch');
  }
  return parsed;
}
