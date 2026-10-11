import { createServer } from 'node:http';
import { buildSystemRevision, buildReleaseConstraints } from '../../../core/v1/releases.mjs';
import { DeploymentAdapter } from '../../../core/v1/deployment.mjs';
import { ProviderHttp } from '../../../adapters/cd/http.mjs';

export async function releaseFixture() {
  const revision = await buildSystemRevision({
    schema_version: 1,
    repositories: { app: 'a'.repeat(40) },
    configuration_digests: {},
    accepted_decisions: [],
  });
  const body = {
    schema_version: 1,
    system_revision_digest: revision.digest,
    ordering_constraints: [],
    compatibility_requirements: [],
    preconditions: [],
    postconditions: [],
    forward_only_operations: [],
  };
  const constraints = await buildReleaseConstraints(body);
  const context = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    principal: { actor_id: 'owner', tenant_id: 'tenant' },
    idempotency_key: 'release',
    trace_id: 'trace',
  };
  return { revision, constraints, body, context };
}

export async function providerServer(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let encoded = '';
    for await (const chunk of req) encoded += chunk;
    const request = {
      method: req.method,
      url: new URL(req.url, 'http://localhost'),
      body: encoded ? JSON.parse(encoded) : undefined,
      headers: req.headers,
    };
    requests.push(request);
    try {
      const reply = await handler(request);
      if (reply.drop) {
        res.destroy();
        return;
      }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    } catch {
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const http = new ProviderHttp({
    base_url: 'http://127.0.0.1:' + server.address().port,
    credential: async () => 'test-credential',
    timeout_ms: 2000,
    max_bytes: 65536,
  });
  return { http, requests };
}

export function deploymentAdapter(transport, provider_id) {
  return new DeploymentAdapter({
    provider_id,
    transport,
    authorize: (actor, resource) => actor.tenant_id === resource.tenant_id,
    policyEvaluator: { can_promote: () => true },
    now: () => '2026-10-11T00:00:00Z',
  });
}
