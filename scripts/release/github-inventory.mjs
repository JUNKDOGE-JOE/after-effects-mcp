const SHA = /^[a-f0-9]{40}$/;
const DEFAULT_LIMITS = Object.freeze({
  maxCheckSuites: 1000,
  maxCheckRuns: 20000,
  maxWorkflowRuns: 10000,
});

function requiredText(value, field) {
  const text = String(value || '');
  if (!text || text.length > 255) throw new Error(`${field} is invalid`);
  return text;
}

function boundedLimit(limits, field) {
  const value = limits?.[field] ?? DEFAULT_LIMITS[field];
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[field]) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function safeId(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} is invalid`);
  return value;
}

function client(github) {
  if (!github || typeof github.paginate !== 'function') {
    throw new Error('GitHub pagination client is required');
  }
  return github;
}

async function paginateBounded(github, endpoint, args, {
  arrayKey,
  maximum,
  label,
}) {
  let reportedTotal;
  const items = await github.paginate(endpoint, args, (response) => {
    const data = response?.data;
    const page = Array.isArray(data) ? data : data?.[arrayKey];
    const total = data?.total_count;
    if (!Array.isArray(page)
        || !Number.isSafeInteger(total) || total < 0
        || (reportedTotal !== undefined && reportedTotal !== total)) {
      throw new Error(`${label} pagination metadata is invalid`);
    }
    reportedTotal = total;
    if (total > maximum) throw new Error(`${label} exceeds the fail-closed bound`);
    return page;
  });
  if (!Array.isArray(items) || reportedTotal === undefined || items.length !== reportedTotal) {
    throw new Error(`${label} is incomplete`);
  }
  if (items.length > maximum) throw new Error(`${label} exceeds the fail-closed bound`);
  return items;
}

export async function listAllCheckRunsForRef(github, {
  owner,
  repo,
  ref,
  limits,
} = {}) {
  client(github);
  owner = requiredText(owner, 'owner');
  repo = requiredText(repo, 'repo');
  ref = requiredText(ref, 'check ref');
  if (!SHA.test(ref)) throw new Error('check ref must be one full SHA');
  const maxCheckSuites = boundedLimit(limits, 'maxCheckSuites');
  const maxCheckRuns = boundedLimit(limits, 'maxCheckRuns');

  const suites = await paginateBounded(
    github,
    github.rest.checks.listSuitesForRef,
    { owner, repo, ref, per_page: 100 },
    {
      arrayKey: 'check_suites',
      maximum: maxCheckSuites,
      label: 'check suite inventory',
    },
  );

  const suiteIds = new Set();
  for (const suite of suites) {
    const id = safeId(suite?.id, 'check suite id');
    if (suiteIds.has(id)) throw new Error('duplicate check suite in inventory');
    if (suite?.head_sha !== ref) throw new Error('check suite ref identity is invalid');
    suiteIds.add(id);
  }

  const runs = [];
  const runIds = new Set();
  for (const suite of suites) {
    const suiteRuns = await paginateBounded(
      github,
      github.rest.checks.listForSuite,
      {
        owner,
        repo,
        check_suite_id: suite.id,
        filter: 'all',
        per_page: 100,
      },
      {
        arrayKey: 'check_runs',
        maximum: maxCheckRuns - runs.length,
        label: 'check run inventory',
      },
    );
    if (runs.length + suiteRuns.length > maxCheckRuns) {
      throw new Error('check run inventory exceeds the fail-closed bound');
    }
    for (const run of suiteRuns) {
      const id = safeId(run?.id, 'check run id');
      if (runIds.has(id)) throw new Error('duplicate check run in inventory');
      if (run?.head_sha !== ref || run?.check_suite?.id !== suite.id) {
        throw new Error('check run suite/ref identity is invalid');
      }
      runIds.add(id);
      runs.push(run);
    }
  }
  return runs.sort((left, right) => left.id - right.id);
}

export async function listAllWorkflowRunsForWorkflow(github, {
  owner,
  repo,
  workflowId,
  limits,
} = {}) {
  client(github);
  owner = requiredText(owner, 'owner');
  repo = requiredText(repo, 'repo');
  workflowId = requiredText(workflowId, 'workflow id');
  const maxWorkflowRuns = boundedLimit(limits, 'maxWorkflowRuns');

  // Search filters such as event/head_sha impose GitHub's 1,000-result cap.
  // Fetch the complete retained workflow inventory and filter locally instead.
  const runs = await paginateBounded(
    github,
    github.rest.actions.listWorkflowRuns,
    { owner, repo, workflow_id: workflowId, per_page: 100 },
    {
      arrayKey: 'workflow_runs',
      maximum: maxWorkflowRuns,
      label: 'workflow run inventory',
    },
  );
  const ids = new Set();
  for (const run of runs) {
    const id = safeId(run?.id, 'workflow run id');
    if (ids.has(id)) throw new Error('duplicate workflow run in inventory');
    ids.add(id);
  }
  return runs;
}
