import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubActionsDeploymentTransport } from '../../adapters/cd/github-actions.mjs';
import { buildReleaseConstraints } from '../../core/v1/releases.mjs';
import { releaseFixture, providerServer, deploymentAdapter } from './support/deployment.mjs';

async function fixture(t) {
  const f = await releaseFixture();
  let run,
    drop = false;
  const server = await providerServer(t, (request) => {
    assert.equal(request.headers['x-github-api-version'], '2026-03-10');
    if (request.method === 'POST') {
      assert.equal(
        request.url.pathname,
        '/repos/team/releases/actions/workflows/deploy.yml/dispatches',
      );
      assert.equal(request.body.ref, 'main');
      run = {
        id: 42,
        path: '.github/workflows/deploy.yml',
        display_title: 'klocgit:' + request.body.inputs.operation_id,
        head_branch: 'main',
        status: 'queued',
        conclusion: null,
      };
      return drop
        ? { drop: true }
        : {
            body: {
              workflow_run_id: 42,
              run_url: 'https://api.github.com/repos/team/releases/actions/runs/42',
              html_url: 'https://github.com/team/releases/actions/runs/42',
            },
          };
    }
    assert.equal(request.url.pathname, '/repos/team/releases/actions/runs/42');
    return { body: run };
  });
  const transport = new GitHubActionsDeploymentTransport({
    http: server.http,
    owner: 'team',
    repository: 'releases',
    workflow_id: 'deploy.yml',
    ref: 'main',
    run_name_prefix: 'klocgit:',
  });
  return {
    ...f,
    ...server,
    transport,
    adapter: deploymentAdapter(transport, 'github-actions'),
    run: () => run,
    drop: () => {
      drop = true;
    },
  };
}

test('GitHub Actions receives the complete exact release contract and returns its actual run identity', async (t) => {
  const f = await fixture(t);
  const constraints = await buildReleaseConstraints({
    ...f.body,
    ordering_constraints: [{ schema_version: 1, before: 'database', after: 'app' }],
    preconditions: [{ schema_version: 1, condition: 'backup' }],
    postconditions: [{ schema_version: 1, condition: 'health' }],
    compatibility_requirements: [{ schema_version: 1, contract: 'api' }],
    forward_only_operations: [{ schema_version: 1, operation: 'migration' }],
  });
  const handle = await f.adapter.submit(f.revision, constraints, f.context);
  assert.equal(handle.external_run_id, '42');
  const inputs = f.requests[0].body.inputs;
  assert.deepEqual(JSON.parse(inputs.system_revision), f.revision);
  assert.deepEqual(JSON.parse(inputs.release_constraints), constraints);
  assert.equal(inputs.operation_id, handle.operation_id);
});

test('GitHub workflow states preserve pending, running, failure, cancellation and uncertainty', async (t) => {
  const f = await fixture(t);
  const handle = await f.adapter.submit(f.revision, f.constraints, f.context);
  for (const [status, conclusion, expected] of [
    ['queued', null, 'SUBMITTED'],
    ['in_progress', null, 'RUNNING'],
    ['completed', 'success', 'SUCCEEDED'],
    ['completed', 'failure', 'FAILED'],
    ['completed', 'cancelled', 'CANCELLED'],
    ['completed', 'timed_out', 'UNKNOWN'],
    ['completed', 'skipped', 'UNKNOWN'],
    ['new-provider-state', null, 'UNKNOWN'],
  ]) {
    Object.assign(f.run(), { status, conclusion });
    const report = await f.adapter.observe(handle, f.context);
    assert.equal(report.observation.status, expected);
    assert.equal(report.observed_repositories, null);
  }
});

test('another workflow, run, ref or operation cannot substitute for the submitted run', async (t) => {
  const f = await fixture(t);
  const handle = await f.adapter.submit(f.revision, f.constraints, f.context);
  const original = { ...f.run() };
  for (const changed of [
    { id: 43 },
    { path: '.github/workflows/other.yml' },
    { head_branch: 'other' },
    { display_title: 'klocgit:other' },
  ]) {
    Object.assign(f.run(), original, changed);
    await assert.rejects(f.adapter.observe(handle, f.context), { code: 'INTEGRITY_MISMATCH' });
  }
});

test('a lost dispatch reply stays ambiguous rather than inventing a run ID', async (t) => {
  const f = await fixture(t);
  f.drop();
  await assert.rejects(f.adapter.submit(f.revision, f.constraints, f.context), {
    code: 'OUTCOME_UNKNOWN',
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.run().id, 42);
});
