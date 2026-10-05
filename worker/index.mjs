import { Engine, emptyState } from '../core/engine.mjs';
import { ArtifactsGit } from './artifacts.mjs';
import { handlePublicRequest, jsonResponse } from './http.mjs';
import { handleCoordinatorRequest } from './routes.mjs';
import { consumeEvents } from './events.mjs';

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
    state.workspace.mode = 'artifacts';
    state.workspace.producers ??= [];
    if (typeof this.env.ACTOR_ID === 'string' && this.env.ACTOR_ID.trim()) {
      state.workspace.owner_id = this.env.ACTOR_ID;
    }
    this.engine = new Engine(state, new ArtifactsGit(this.env), (state) =>
      this.ctx.storage.put('state', state),
    );
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
        const url = new URL(request.url);
        const input = request.method === 'GET' ? {} : await request.json();
        return await handleCoordinatorRequest(this.engine, this.env, {
          method: request.method,
          url,
          input,
        });
      } catch (error) {
        return jsonResponse(
          {
            error: error.code ?? 'INTERNAL_ERROR',
            message: error.status ? error.message : 'Coordination failed. Git remains available.',
            details: error.details ?? {},
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
