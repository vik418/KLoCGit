import http from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { Engine, emptyState } from '../core/engine.mjs';
import { DomainError } from '../core/hash.mjs';
import { redactSensitive } from '../core/access.mjs';
import { authenticateEvaluationReport, evaluatorServices } from '../worker/identity.mjs';
import { LocalGit } from './git.mjs';
import { handleLocalRequest } from './local-api.mjs';
import {
  readRequestPayload,
  jsonResponse,
  authenticatedPrincipal,
  assertSameOrigin,
} from './local-http.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = process.env.KLOCGIT_ROOT
  ? path.resolve(process.env.KLOCGIT_ROOT)
  : path.join(project, '.klocgit-workspace');
const stateFile = path.join(root, 'state.json');
const localActor = process.env.LOCAL_ACTOR_ID;
if (typeof localActor !== 'string' || !localActor.trim())
  throw new DomainError(
    'ACTOR_NOT_CONFIGURED',
    'Set LOCAL_ACTOR_ID to your development identity',
    503,
  );
const ownerToken = process.env.LOCAL_OWNER_TOKEN;
const host = process.env.HOST ?? '127.0.0.1';
const engineOptions = { evaluators: { services: evaluatorServices(process.env) } };

async function save(state) {
  await mkdir(root, { recursive: true });
  await writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2));
  await rename(stateFile + '.tmp', stateFile);
}

async function loadEngine() {
  let state;
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (state) {
    if (state.workspace.owner_id && state.workspace.owner_id !== localActor)
      throw new DomainError('OWNER_IDENTITY_CHANGED', 'Restore the configured owner or explicitly reconcile ownership', 503);
    state.workspace.owner_id ??= localActor;
    const engine = new Engine(state, await new LocalGit(root).init(), save, engineOptions);
    await save(state);
    await engine.recover();
    return engine;
  }

  // Missing coordination metadata must not erase intact Git repositories.
  try {
    await stat(path.join(root, 'repositories'));
    throw new DomainError(
      'WORKSPACE_METADATA_MISSING',
      'Existing Git repositories need their coordination metadata restored; startup will preserve them.',
      503,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  state = emptyState();
  state.workspace.owner_id = localActor;
  const engine = new Engine(state, await new LocalGit(root).init(), save, engineOptions);
  await save(state);
  return engine;
}

const engine = await loadEngine();
const vite = await createViteServer({
  root: project,
  server: { middlewareMode: true },
  appType: 'spa',
});

async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    return vite.middlewares(request, response, () => {
      response.writeHead(404);
      response.end();
    });
  }

  try {
    assertSameOrigin(request);
    const report = request.method === 'POST' && url.pathname.match(/^\/api\/evaluation-runs\/([^/]+)\/report$/);
    let principal;
    if (!report)
      principal = await authenticatedPrincipal(request, {
        actor: localActor, ownerToken, host, identityEnv: process.env,
      });
    const payload = ['GET', 'HEAD'].includes(request.method)
      ? { input: {}, raw: '', bytes: 0 } : await readRequestPayload(request);
    if (report) {
      const webRequest = new Request(url, { method: request.method, headers: request.headers });
      principal = await authenticateEvaluationReport(webRequest, process.env, payload.input, report[1]);
    }
    engine.access.assertQuota('request_bytes', 0, payload.bytes);
    const input = payload.input;
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new DomainError('INVALID_REQUEST', 'Request body must be an object');
    const result = await engine.serial(() =>
      handleLocalRequest(
        engine,
        {
          method: request.method,
          url,
          input, principal, actor: principal.actor_id,
          headers: request.headers, bytes: payload.bytes,
        },
        { root, save },
      ),
    );
    jsonResponse(response, 200, result);
  } catch (error) {
    jsonResponse(response, error.status ?? 500, {
      error: error.code ?? 'INTERNAL_ERROR',
      message: error.status
        ? error.message
        : 'The operation failed. Git repositories remain available.',
      details: redactSensitive(error.details ?? {}),
    });
  }
}

const server = http.createServer(handleRequest);
const port = Number(process.env.PORT ?? 43187);
server.listen(port, host, () => {
  console.log('klocgit workspace: http://localhost:' + server.address().port);
  console.log('Canonical repositories: ' + path.join(root, 'repositories'));
  console.log(
    'Owner identity: ' +
      localActor +
      '; ' +
      (ownerToken ? 'credential required' : 'local development session'),
  );
});

async function shutdown() {
  server.close();
  await vite.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
