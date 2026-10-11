/** Test-only transport; production authorization is not bypassed by these routes. */
import { CoordinationStore, coordinationKey } from '../../core/v1/coordination.mjs';
import { DurableCoordinationBackend } from '../../adapters/cloudflare/coordination.mjs';

export class TestCoordinator {
  constructor(ctx) {
    this.store = new CoordinationStore(new DurableCoordinationBackend(ctx));
  }

  async fetch(request) {
    const { scope, operation, value } = await request.json();
    try {
      const result = await this.store.transaction(scope, async (tx) => {
        if (operation === 'put') {
          await tx.put('record', value);
          return value;
        }
        if (operation === 'get') return (await tx.get('record')) ?? null;
        const current = (await tx.get('counter')) ?? { schema_version: 1, value: 0 };
        const next = { ...current, value: current.value + 1 };
        await tx.put('counter', next);
        if (operation === 'abort') throw new Error('intentional transaction abort');
        return next;
      });
      return Response.json(result);
    } catch (error) {
      return Response.json({ code: error.code ?? 'ABORTED' }, { status: 409 });
    }
  }
}

export default {
  async fetch(request, env) {
    const { scope, object_override } = await request.clone().json();
    const id = env.COORDINATOR.idFromName(object_override ?? (await coordinationKey(scope)));
    return env.COORDINATOR.get(id).fetch(request);
  },
};
