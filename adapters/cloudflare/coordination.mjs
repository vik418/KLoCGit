/** Use one Durable Object per immutable coordination scope key. */
import { V1Error, parseDigest } from '../../core/v1/conventions.mjs';

export class DurableCoordinationBackend {
  constructor(ctx) {
    if (
      typeof ctx?.storage?.transaction !== 'function' ||
      typeof ctx.blockConcurrencyWhile !== 'function'
    ) {
      throw new V1Error('INVALID_ARGUMENT');
    }
    this.ctx = ctx;
  }

  async transaction(scope, callback) {
    parseDigest(scope, 'coordination-scope');
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const value = await this.ctx.storage.transaction(async (storage) => {
          const binding = await storage.get('scope-binding');
          if (binding && (binding.schema_version !== 1 || binding.scope !== scope)) {
            throw new V1Error('FORBIDDEN');
          }
          if (!binding) await storage.put('scope-binding', { schema_version: 1, scope });
          return callback({
            get: (key) => storage.get('record:' + key),
            put: (key, value) => storage.put('record:' + key, value),
            delete: (key) => storage.delete('record:' + key),
          });
        });
        return { value };
      } catch (error) {
        // An exception escaping blockConcurrencyWhile resets the object. A
        // rejected domain transition should roll back without resetting it.
        return { error };
      }
    });
    if (Object.hasOwn(outcome, 'error')) throw outcome.error;
    return outcome.value;
  }
}
