import { Engine, emptyState } from '../core/engine.mjs';
import { ArtifactsGit } from './artifacts.mjs';
import { handlePublicRequest, jsonResponse } from './http.mjs';
import { handleCoordinatorRequest } from './routes.mjs';
import { consumeEvents } from './events.mjs';
import { configuredWorkspace } from './config.mjs';
import { DomainError } from '../core/hash.mjs';
import { redactSensitive } from '../core/access.mjs';
import { trustedPrincipal, evaluatorServices } from './identity.mjs';
import { readBoundedRequest } from './http.mjs';

/**
 * Workspace metadata and operation serialization live in one Durable Object.
 * Recovery runs before request handling. This boundary orders platform writes;
 * external Git clients still require the separate reviewed-head CAS check.
 *
 * @param {object} ctx Durable Object storage and lifecycle context.
 * @param {object} env Worker bindings and configured owner identity.
 */
export class WorkspaceCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ready = ctx.blockConcurrencyWhile(() => this.initialize());
  }

  async initialize() {
    const state = (await this.ctx.storage.get('state')) ?? emptyState();
    state.workspace.id = configuredWorkspace(this.env);
    state.workspace.name = state.workspace.id;
    state.workspace.mode = 'artifacts';
    state.workspace.producers ??= [];
    const owner = this.env.ACTOR_ID;
    if (typeof owner !== 'string' || !owner.trim())
      throw new DomainError('ACTOR_NOT_CONFIGURED', 'Configure the bootstrap owner identity', 503);
    if (state.workspace.owner_id && state.workspace.owner_id !== owner)
      throw new DomainError('OWNER_IDENTITY_CHANGED', 'Restore the configured owner or explicitly reconcile ownership', 503);
    state.workspace.owner_id ??= owner;
    this.engine = new Engine(state, new ArtifactsGit(this.env),
      (state) => this.ctx.storage.put('state', state),
      { evaluators: { services: evaluatorServices(this.env) } },
    );
    await this.ctx.storage.put('state', state);
    await this.engine.recover();
  }

  /**
   * Dispatch an authenticated public request or trusted internal queue request.
   * Reads serialize too: a workspace view can reconcile newly observed Git heads.
   * Authentication belongs to the public gateway; this route never trusts a
   * request-body actor to authorize canonical changes.
   *
   * @param {Request} request Request forwarded by the public gateway or queue consumer.
   * @returns {Promise<Response>} Domain response, with handled failures encoded as JSON.
   * @throws {Error} Initialization/storage/recovery fails before dispatch can begin.
   */
  async fetch(request) {
    await this.ready;
    return this.engine.serial(async () => {
      try {
        const principal = await trustedPrincipal(request, this.env);
        const url = new URL(request.url);
        const payload = await readBoundedRequest(request);
        this.engine.access.assertQuota('request_bytes', 0, payload.bytes);
        let input = {};
        if (payload.raw) {
          try { input = JSON.parse(payload.raw); }
          catch { throw new DomainError('INVALID_JSON', 'Request body must be JSON'); }
        }
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new DomainError('INVALID_REQUEST', 'Request body must be an object');
        return await handleCoordinatorRequest(this.engine, this.env, {
          method: request.method,
          url,
          input, principal, actor: principal.actor_id, headers: request.headers,
        });
      } catch (error) {
        return jsonResponse(
          {
            error: error.code ?? 'INTERNAL_ERROR',
            message: error.status ? error.message : 'Coordination failed. Git remains available.',
            details: redactSensitive(error.details ?? {}),
          },
          error.status ?? 500,
        );
      }
    });
  }
}

export default {
  fetch: handlePublicRequest,
  queue: consumeEvents,
};
