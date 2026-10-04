// Trusted Git transport + platform-owned sandbox checks. No producer test commands.
import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hash, DomainError } from '../core/hash.mjs';
import { RemoteGit } from './remote-git.mjs';
export { RemoteGit } from './remote-git.mjs';
const exec = promisify(execFile);

async function sandboxAvailability() {
  try {
    const node = await realpath(process.execPath);
    await exec(
      '/usr/bin/bwrap',
      [
        '--unshare-user',
        '--unshare-pid',
        '--unshare-net',
        '--unshare-ipc',
        '--unshare-uts',
        '--die-with-parent',
        '--clearenv',
        '--ro-bind',
        '/lib',
        '/lib',
        '--ro-bind',
        '/lib64',
        '/lib64',
        '--dir',
        '/runtime',
        '--ro-bind',
        node,
        '/runtime/node',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
        '--',
        '/runtime/node',
        '--max-old-space-size=64',
        '-e',
        'process.exit(0)',
      ],
      { env: { LANG: 'C.UTF-8' }, timeout: 3000, maxBuffer: 4096 },
    );
    return {
      available: true,
      scope:
        'Private namespace runtime startup only; each exact candidate still needs trusted validation.',
    };
  } catch {
    return {
      available: false,
      reason: 'Required private namespace runtime could not start. Validation must fail closed.',
    };
  }
}
export async function createBridge({ manifest, token = process.env.GIT_BRIDGE_TOKEN } = {}) {
  if (!manifest?.cacheDirectory || !token)
    throw new Error('Executor manifest and trusted service credential are required.');
  const adapter = await new RemoteGit(manifest.cacheDirectory, manifest).init(),
    sandbox = await sandboxAvailability();
  let tail = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      if ((await hash(req.headers.authorization ?? '')) !== (await hash('Bearer ' + token)))
        throw new DomainError('UNAUTHENTICATED', 'Trusted service credential required', 401);
      if (req.url === '/health' && req.method === 'GET')
        return send(200, { executor: 'ready', configHash: adapter.configHash, sandbox });
      if (req.method !== 'POST')
        throw new DomainError('METHOD_NOT_ALLOWED', 'Executor operations require POST', 405);
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1000000)
          throw new DomainError('PAYLOAD_TOO_LARGE', 'Request exceeds 1MB', 413);
      }
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        throw new DomainError('INVALID_JSON', 'Executor input must be JSON');
      }
      if (input.configHash !== adapter.configHash)
        throw new DomainError('CONFIG_STALE', 'Executor validation configuration changed', 409);
      const job = tail.then(async () => {
        const repo = adapter.configured({
          id: input.repo,
          canonical_ref: input.ref ?? 'refs/heads/main',
          canonical_repo: input.canonical_repo,
          source_repo: input.source_repo,
        });
        if (req.url === '/profile')
          return {
            validation_profile: repo.validation_profile ?? null,
            context_repo: repo.context_repo ?? null,
          };
        if (
          [
            '/compose',
            '/revert',
            '/is-ancestor',
            '/merge-base',
            '/validate',
            '/suite',
            '/cas',
          ].includes(req.url) &&
          ((input.validation_profile ?? null) !== (repo.validation_profile ?? null) ||
            (input.context_repo ?? null) !== (repo.context_repo ?? null))
        )
          throw new DomainError(
            'VALIDATION_PROFILE_MISMATCH',
            'Repository validation configuration differs between coordinator and trusted executor',
            409,
          );
        if (req.url === '/compose') return adapter.compose(repo, input.head, input.revisions);
        if (req.url === '/revert')
          return adapter.revert(repo, input.head, input.target, input.mainline);
        if (req.url === '/is-ancestor')
          return { isAncestor: await adapter.isAncestor(repo, input.ancestor, input.descendant) };
        if (req.url === '/merge-base')
          return { base: await adapter.mergeBase(repo, input.head, input.canonical) };
        if (req.url === '/validate' || req.url === '/suite')
          return adapter.validate(repo, input.commit, input.constraints, input.validityHeads);
        if (req.url === '/trailers') return adapter.trailers(repo, input.commit);
        if (req.url === '/diff') return { diff: await adapter.diff(repo, input.base, input.head) };
        if (req.url === '/cas')
          return { updated: await adapter.cas(repo, input.expected, input.commit) };
        throw new DomainError('NOT_FOUND', 'Unknown executor operation', 404);
      });
      tail = job.catch(() => {});
      send(200, await job);
    } catch (e) {
      send(e.status ?? 500, {
        error: e.code ?? 'EXECUTOR_FAILED',
        message: e.status ? e.message : 'Trusted executor failed',
      });
    }
  });
  return { server, adapter, sandbox };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.GIT_EXECUTOR_MANIFEST || !process.env.GIT_BRIDGE_TOKEN)
    throw new Error('GIT_EXECUTOR_MANIFEST and GIT_BRIDGE_TOKEN must be configured.');
  const manifest = JSON.parse(await readFile(process.env.GIT_EXECUTOR_MANIFEST, 'utf8')),
    { server, adapter, sandbox } = await createBridge({ manifest });
  server.listen(
    Number(process.env.GIT_EXECUTOR_PORT ?? 8788),
    process.env.GIT_EXECUTOR_HOST ?? '127.0.0.1',
    () =>
      console.log(JSON.stringify({ executor: 'ready', configHash: adapter.configHash, sandbox })),
  );
}
