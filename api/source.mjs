/** Authenticated source reads shared by the local server and Worker gateway. */
import { V1Error } from '../core/v1/conventions.mjs';
import { repositoryId } from '../core/repository-input.mjs';
import { errorResponse, PRIVATE_JSON_HEADERS } from './http.mjs';

const pattern = /^\/api\/source\/repositories\/([^/]+)\/(refs|tree|file|history|commit|summary)$/;

export function ownsSourcePath(path) {
  return path.startsWith('/api/source/');
}

export async function handleSourceRequest(engine, { method, url, principal }) {
  try {
    const match = url.pathname.match(pattern);
    if (!match) throw new V1Error('NOT_FOUND');
    if (method !== 'GET')
      return Response.json(
        {
          schema_version: 1,
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Source browsing supports GET.' },
        },
        { status: 405, headers: { ...PRIVATE_JSON_HEADERS, allow: 'GET' } },
      );
    const id = repositoryId(decodeURIComponent(match[1]));
    // Authorization precedes repository lookup and every provider call.
    engine.access.require(principal, 'repository.read', [engine.access.canonicalRepository(id)]);
    const repository =
      engine.state.nativeRepositories.find((repo) => repo.id === id) ??
      engine.state.repositories.find((repo) => repo.id === id);
    if (!repository) throw new V1Error('NOT_FOUND');
    const params = url.searchParams;
    if (
      [...params.keys()].some(
        (key) => !['commit_oid', 'ref', 'path', 'limit', 'offset', 'cursor'].includes(key),
      ) ||
      [...params.keys()].some((key) => params.getAll(key).length !== 1)
    )
      throw new V1Error('INVALID_ARGUMENT');
    const input = Object.fromEntries(params);
    if (!input.commit_oid && !input.ref) input.ref = repository.canonical_ref;
    const browser = engine.git.sourceBrowser(repository);
    const operation = match[2];
    const result =
      operation === 'refs'
        ? await browser.refs({ limit: input.limit, cursor: input.cursor })
        : operation === 'commit'
          ? { schema_version: 1, commit: await browser.snapshot(input) }
          : await browser[operation === 'tree' ? 'directory' : operation](input);
    return Response.json(result, { headers: PRIVATE_JSON_HEADERS });
  } catch (error) {
    if (!(error instanceof V1Error)) {
      const code =
        error.status === 401
          ? 'UNAUTHENTICATED'
          : error.status === 403
            ? 'FORBIDDEN'
            : error.status === 404
              ? 'NOT_FOUND'
              : error.status === 400 || error instanceof URIError
                ? 'INVALID_ARGUMENT'
                : 'PROVIDER_UNAVAILABLE';
      error = new V1Error(code);
    }
    return errorResponse(error);
  }
}
