import { Engine, emptyState } from '../core/engine.mjs';
import { ArtifactsGit } from './artifacts.mjs';
import { handlePublicRequest, jsonResponse } from './http.mjs';
import { handleCoordinatorRequest } from './routes.mjs';
import { consumeEvents } from './events.mjs';

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
