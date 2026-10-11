import assert from 'node:assert/strict';
import test from 'node:test';
import { ArgoDeploymentTransport } from '../../adapters/cd/argo.mjs';
import { buildReleaseConstraints } from '../../core/v1/releases.mjs';
import { releaseFixture, providerServer, deploymentAdapter } from './support/deployment.mjs';

async function fixture(t, options = {}) {
  const f = await releaseFixture();
  let app = {
    metadata: {
      name: 'app',
      namespace: 'argocd',
      uid: 'uid',
      resourceVersion: '1',
      annotations: { owner: 'team' },
    },
    spec: {
      project: 'project',
      source: { repoURL: 'https://git.example/app', path: 'deploy', targetRevision: 'main' },
      syncPolicy: { automated: {} },
    },
    status: { sync: { status: 'OutOfSync' }, health: { status: 'Progressing' } },
  };
  let drop = false,
    race = false;
  const server = await providerServer(t, (request) => {
    assert.equal(request.url.pathname, '/api/v1/applications/app');
    assert.equal(request.url.searchParams.get('project'), 'project');
    assert.equal(request.url.searchParams.get('appNamespace'), 'argocd');
    assert.equal(request.headers.authorization, 'Bearer test-credential');
    if (request.method === 'GET') return { body: app };
    assert.equal(request.method, 'PATCH');
    assert.equal(request.body.patchType, 'json');
    const patches = JSON.parse(request.body.patch);
    if (race) {
      race = false;
      app.metadata.resourceVersion = 'external';
    }
    for (const patch of patches) {
      const parts = patch.path
        .slice(1)
        .split('/')
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
      const field = parts.pop();
      let target = app;
      for (const part of parts) target = target[part];
      if (patch.op === 'test') {
        if (target[field] !== patch.value) return { status: 409, body: {} };
      } else if (patch.op === 'remove') delete target[field];
      else target[field] = patch.value;
    }
    app.metadata.resourceVersion = '2';
    if (drop) {
      drop = false;
      return { drop: true };
    }
    return { body: app };
  });
  const transport = new ArgoDeploymentTransport({
    http: server.http,
    application: 'app',
    project: 'project',
    namespace: 'argocd',
    repositories: { app: { repo_url: 'https://git.example/app', path: 'deploy' } },
    ...options,
  });
  return {
    ...f,
    ...server,
    transport,
    adapter: deploymentAdapter(transport, 'argo'),
    app: () => app,
    setApp: (value) => {
      app = value;
    },
    drop: () => {
      drop = true;
    },
    race: () => {
      race = true;
    },
  };
}

test('Argo receives exact desired state with a resource-version guard and stable retry identity', async (t) => {
  const f = await fixture(t);
  const handle = await f.adapter.submit(f.revision, f.constraints, f.context);
  assert.equal(f.app().spec.source.targetRevision, f.revision.repositories.app);
  assert.equal(f.app().metadata.annotations.owner, 'team');
  assert.equal(f.app().metadata.annotations['klocgit.dev/system-revision'], f.revision.digest);
  assert.deepEqual(await f.adapter.submit(f.revision, f.constraints, f.context), handle);
  assert.equal(f.requests.filter((r) => r.method === 'PATCH').length, 1);
  assert.equal((await f.adapter.observe(handle, f.context)).observation.status, 'UNKNOWN');
  f.app().status.sync = { status: 'Synced', revision: f.revision.repositories.app };
  f.app().status.health.status = 'Healthy';
  const report = await f.adapter.observe(handle, f.context);
  assert.equal(report.observation.status, 'SUCCEEDED');
  assert.deepEqual(report.observed_repositories, f.revision.repositories);
  f.app().status.health.status = 'Degraded';
  assert.equal((await f.adapter.observe(handle, f.context)).observation.status, 'FAILED');
});

test('unsupported constraints and wrong repository/project cannot mutate an Argo Application', async (t) => {
  const f = await fixture(t);
  const constraints = await buildReleaseConstraints({
    ...f.body,
    preconditions: [{ schema_version: 1, condition: 'backup' }],
  });
  await assert.rejects(f.adapter.submit(f.revision, constraints, f.context), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
  f.app().spec.source.repoURL = 'https://git.example/other';
  await assert.rejects(f.adapter.submit(f.revision, f.constraints, f.context), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
  f.app().spec.project = 'other';
  await assert.rejects(f.adapter.submit(f.revision, f.constraints, f.context), {
    code: 'FORBIDDEN',
  });
  assert.equal(f.requests.filter((r) => r.method === 'PATCH').length, 0);
});

test('registered constraint translation preserves the complete immutable external-CD contract', async (t) => {
  let captured;
  const f = await fixture(t, {
    translateConstraints: (revision, constraints) => {
      captured = { revision, constraints };
      return {
        schema_version: 1,
        patches: [
          {
            op: 'add',
            path: '/metadata/annotations/external.example~1contract',
            value: constraints.digest,
          },
        ],
      };
    },
  });
  const constraints = await buildReleaseConstraints({
    ...f.body,
    postconditions: [{ schema_version: 1, condition: 'external-health-observation' }],
    forward_only_operations: [{ schema_version: 1, operation: 'migration' }],
  });
  await f.adapter.submit(f.revision, constraints, f.context);
  assert.deepEqual(captured, { revision: f.revision, constraints });
  assert.equal(f.app().metadata.annotations['external.example/contract'], constraints.digest);
});

test('external Application edits race safely with desired-state submission', async (t) => {
  const f = await fixture(t);
  f.race();
  await assert.rejects(f.adapter.submit(f.revision, f.constraints, f.context), {
    code: 'CONFLICT',
  });
  assert.equal(f.app().spec.source.targetRevision, 'main');
});

test('a lost patch response is ambiguous and the retained operation marker reconciles a retry', async (t) => {
  const f = await fixture(t);
  f.drop();
  await assert.rejects(f.adapter.submit(f.revision, f.constraints, f.context), {
    code: 'OUTCOME_UNKNOWN',
  });
  await f.adapter.submit(f.revision, f.constraints, f.context);
  assert.equal(f.requests.filter((r) => r.method === 'PATCH').length, 1);
  const changed = await buildReleaseConstraints({
    ...f.body,
    compatibility_requirements: [{ schema_version: 1, contract: 'changed' }],
  });
  await assert.rejects(f.adapter.submit(f.revision, changed, f.context), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('recreated, replaced or contradictory Argo state cannot report success for an old run', async (t) => {
  const f = await fixture(t);
  const handle = await f.adapter.submit(f.revision, f.constraints, f.context);
  f.app().status.sync = { status: 'Synced', revision: 'b'.repeat(40) };
  f.app().status.health.status = 'Healthy';
  assert.equal((await f.adapter.observe(handle, f.context)).observation.status, 'UNKNOWN');
  f.app().status.sync.revision = f.revision.repositories.app;
  f.app().metadata.uid = 'replacement';
  assert.equal((await f.adapter.observe(handle, f.context)).observation.status, 'UNKNOWN');
});
