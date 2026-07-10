import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listAllCheckRunsForRef,
  listAllWorkflowRunsForWorkflow,
} from '../github-inventory.mjs';

function fakeGithub({
  suites = [],
  suiteTotalCount = suites.length,
  runsBySuite = new Map(),
  runTotalCounts = new Map(),
  workflowRuns = [],
  workflowTotalCount = workflowRuns.length,
} = {}) {
  const calls = [];
  const listSuitesForRef = function listSuitesForRef() {};
  const listForSuite = function listForSuite() {};
  const listWorkflowRuns = function listWorkflowRuns() {};
  return {
    calls,
    rest: {
      checks: { listSuitesForRef, listForSuite },
      actions: { listWorkflowRuns },
    },
    async paginate(endpoint, args, mapPage) {
      calls.push({ endpoint, args: structuredClone(args) });
      if (endpoint === listSuitesForRef) {
        const data = { total_count: suiteTotalCount, check_suites: structuredClone(suites) };
        if (!mapPage) return data.check_suites;
        data.check_suites.total_count = data.total_count;
        return mapPage({ data: data.check_suites });
      }
      if (endpoint === listForSuite) {
        const suiteRuns = structuredClone(runsBySuite.get(String(args.check_suite_id)) || []);
        const data = {
          total_count: runTotalCounts.get(String(args.check_suite_id)) ?? suiteRuns.length,
          check_runs: suiteRuns,
        };
        if (!mapPage) return data.check_runs;
        data.check_runs.total_count = data.total_count;
        return mapPage({ data: data.check_runs });
      }
      if (endpoint === listWorkflowRuns) {
        const data = { total_count: workflowTotalCount, workflow_runs: structuredClone(workflowRuns) };
        if (!mapPage) return data.workflow_runs;
        data.workflow_runs.total_count = data.total_count;
        return mapPage({ data: data.workflow_runs });
      }
      throw new Error('unexpected endpoint');
    },
  };
}

test('check inventory enumerates every suite then every suite check run', async () => {
  const github = fakeGithub({
    suites: [
      { id: 10, head_sha: 'a'.repeat(40) },
      { id: 11, head_sha: 'a'.repeat(40) },
    ],
    runsBySuite: new Map([
      ['10', [{ id: 100, name: 'other', head_sha: 'a'.repeat(40), check_suite: { id: 10 } }]],
      ['11', [{
        id: 101,
        name: 'windows-rc-attestation',
        external_id: `ae-mcp-rc:${'a'.repeat(40)}:windows-x64`,
        head_sha: 'a'.repeat(40),
        check_suite: { id: 11 },
      }]],
    ]),
  });

  const runs = await listAllCheckRunsForRef(github, {
    owner: 'owner', repo: 'repo', ref: 'a'.repeat(40),
  });
  assert.deepEqual(runs.map((item) => item.id), [100, 101]);
  assert.deepEqual(github.calls.map((item) => item.endpoint.name), [
    'listSuitesForRef', 'listForSuite', 'listForSuite',
  ]);
  assert.ok(github.calls.every((item) => item.endpoint.name !== 'listForRef'));
});

test('check inventory fails closed on duplicate identity or configured bounds', async () => {
  const sha = 'a'.repeat(40);
  await assert.rejects(
    listAllCheckRunsForRef(fakeGithub({
      suites: Array.from({ length: 1001 }, (_, index) => ({ id: index + 1, head_sha: sha })),
    }), { owner: 'owner', repo: 'repo', ref: sha }),
    /check suite inventory exceeds/,
  );
  await assert.rejects(
    listAllCheckRunsForRef(fakeGithub({
      suites: [{ id: 1, head_sha: sha }],
      suiteTotalCount: 1001,
    }), { owner: 'owner', repo: 'repo', ref: sha }),
    /check suite inventory exceeds|incomplete/i,
  );
  await assert.rejects(
    listAllCheckRunsForRef(fakeGithub({
      suites: [{ id: 10, head_sha: sha }, { id: 10, head_sha: sha }],
    }), { owner: 'owner', repo: 'repo', ref: sha }),
    /duplicate check suite/,
  );
  await assert.rejects(
    listAllCheckRunsForRef(fakeGithub({
      suites: [{ id: 10, head_sha: sha }, { id: 11, head_sha: sha }],
    }), { owner: 'owner', repo: 'repo', ref: sha, limits: { maxCheckSuites: 1 } }),
    /check suite inventory exceeds/,
  );
  await assert.rejects(
    listAllCheckRunsForRef(fakeGithub({
      suites: [{ id: 10, head_sha: sha }, { id: 11, head_sha: sha }],
      runsBySuite: new Map([
        ['10', [{ id: 100, name: 'one', head_sha: sha, check_suite: { id: 10 } }]],
        ['11', [{ id: 100, name: 'two', head_sha: sha, check_suite: { id: 11 } }]],
      ]),
    }), { owner: 'owner', repo: 'repo', ref: sha }),
    /duplicate check run/,
  );
});

test('workflow inventory paginates without capped search filters and rejects duplicates or overflow', async () => {
  const github = fakeGithub({ workflowRuns: [{ id: 20 }, { id: 21 }] });
  const runs = await listAllWorkflowRunsForWorkflow(github, {
    owner: 'owner', repo: 'repo', workflowId: 'attestation.yml',
  });
  assert.deepEqual(runs.map((item) => item.id), [20, 21]);
  assert.deepEqual(Object.keys(github.calls[0].args).sort(), [
    'owner', 'per_page', 'repo', 'workflow_id',
  ]);

  await assert.rejects(
    listAllWorkflowRunsForWorkflow(fakeGithub({
      workflowRuns: [{ id: 20 }, { id: 20 }],
    }), { owner: 'owner', repo: 'repo', workflowId: 'attestation.yml' }),
    /duplicate workflow run/,
  );
  await assert.rejects(
    listAllWorkflowRunsForWorkflow(fakeGithub({
      workflowRuns: [{ id: 20 }, { id: 21 }],
    }), {
      owner: 'owner', repo: 'repo', workflowId: 'attestation.yml',
      limits: { maxWorkflowRuns: 1 },
    }),
    /workflow run inventory exceeds/,
  );
});
