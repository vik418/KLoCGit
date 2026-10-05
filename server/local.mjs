import http from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { Engine } from '../core/engine.mjs';
import { DomainError } from '../core/hash.mjs';
import { LocalGit } from './git.mjs';
import { createDemo } from '../scripts/demo.mjs';
import { handleLocalRequest } from './local-api.mjs';
import {
  readRequestBody,
  jsonResponse,
  authenticatedActor,
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
    state.workspace.owner_id = localActor;
    const engine = new Engine(state, await new LocalGit(root).init(), save);
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
  const { engine } = await createDemo(root, save, { pending: true });
  engine.state.workspace.owner_id = localActor;
  await save(engine.state);
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
    // One configured principal owns this local session. Client payloads never
    // select audit actors; LOCAL_OWNER_TOKEN optionally authenticates callers.
    const actor = authenticatedActor(request, { actor: localActor, ownerToken });
    assertSameOrigin(request);
    const input = request.method === 'GET' ? {} : await readRequestBody(request);
    const result = await engine.serial(() =>
      handleLocalRequest(
        engine,
        {
          method: request.method,
          url,
          input,
          actor,
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
      details: error.details ?? {},
    });
  }
}

const server = http.createServer(handleRequest);
const port = Number(process.env.PORT ?? 43187);
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log('klocgit local demo: http://localhost:' + server.address().port);
  console.log('Canonical repositories: ' + path.join(root, 'repositories'));
  console.log(
    'Owner identity: ' +
      localActor +
      '; ' +
      (ownerToken ? 'credential required' : 'local demo session'),
  );
});

async function shutdown() {
  server.close();
  await vite.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
