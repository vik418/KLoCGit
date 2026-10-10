/** Observe Git, then record an immutable revision. Push payloads are only hints. */
import { V1Error, assertSchemaVersion, objectId } from './conventions.mjs';
import { FutureRevision, copyJsonData } from './domain.mjs';
import { coordinationScope } from './coordination.mjs';
import { digestCanonical } from './encoding.mjs';
import { gitSnapshot } from './git-store.mjs';

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function identity(revision) {
  const { schema_version, system_id, repo_id, ref, commit_oid, tree_oid, parent_oids } = revision;
  // Delivery time and producer claims must not manufacture another Git version.
  return { schema_version, system_id, repo_id, ref, commit_oid, tree_oid, parent_oids };
}

async function revisionId(revision) {
  return objectId(
    'future-revision',
    await digestCanonical('object-future-revision', identity(revision)),
  );
}

export class FutureIngestor {
  constructor({ scope, gitStore, authorize, clock, observationFilter }) {
    this.scope = coordinationScope(scope);
    valid(this.scope.kind === 'REF');
    valid(gitStore?.repo_id === this.scope.resource_id.repo_id);
    valid(typeof gitStore.observe_ref === 'function' && typeof gitStore.fetch === 'function');
    valid(typeof authorize === 'function' && typeof clock === 'function');
    this.gitStore = gitStore;
    this.authorizer = authorize;
    this.clock = clock;
    this.observationFilter = copyJsonData(observationFilter);
    valid(
      this.observationFilter &&
        typeof this.observationFilter === 'object' &&
        !Array.isArray(this.observationFilter),
    );
  }

  authorize = async ({ principal, event }) => {
    if (
      event.tenant_id !== this.scope.tenant_id ||
      event.system_id !== this.scope.system_id ||
      event.subject_id !== this.scope.resource_id.repo_id ||
      event.objective_id !== null
    )
      return false;
    return (
      (await this.authorizer({
        principal,
        scope: this.scope,
        action: 'future.observe',
      })) === true
    );
  };

  resolveScope = async () => this.scope;

  /** Use for both ordinary deliveries and gaps requiring authoritative rereads. */
  observe = async ({ event, payload, principal, transaction }) => {
    const input = copyJsonData(payload);
    assertSchemaVersion(input);
    valid(Object.keys(input).length === 4);
    valid(
      ['schema_version', 'repo_id', 'ref', 'producer'].every((field) =>
        Object.hasOwn(input, field),
      ),
    );
    if (
      input.repo_id !== this.scope.resource_id.repo_id ||
      input.ref !== this.scope.resource_id.ref
    )
      throw new V1Error('FORBIDDEN');
    valid(
      input.producer === null ||
        (typeof input.producer === 'object' && !Array.isArray(input.producer)),
    );
    const commit_oid = await this.gitStore.observe_ref(input.repo_id, input.ref);
    const source = await this.gitStore.fetch(
      { schema_version: 1, repo_id: input.repo_id, commit_oid },
      this.observationFilter,
    );
    const snapshot = gitSnapshot(source.identity);
    const body = {
      schema_version: 1,
      system_id: this.scope.system_id,
      repo_id: snapshot.repo_id,
      ref: input.ref,
      commit_oid: snapshot.commit_oid,
      tree_oid: snapshot.tree_oid,
      parent_oids: snapshot.parent_oids,
    };
    const id = await revisionId(body);
    const key = 'future-revision:' + id;
    const stored = await transaction.get(key);
    const created = stored === undefined;
    const revision = created
      ? FutureRevision({
          ...body,
          id,
          producer: input.producer === null ? null : { basis: 'DECLARED', value: input.producer },
          observed_at: this.clock(),
        })
      : FutureRevision(stored);
    if ((await revisionId(revision)) !== id) throw new V1Error('INTEGRITY_MISMATCH');
    if (created) await transaction.put(key, revision);
    const previous = await transaction.get('observed-ref');
    if (previous?.revision_id !== id) {
      await transaction.put('observed-ref', {
        schema_version: 1,
        revision_id: id,
        commit_oid: revision.commit_oid,
      });
    }
    await transaction.put('git-observation:' + event.event_id, {
      schema_version: 1,
      event_id: event.event_id,
      trace_id: event.trace_id,
      revision_id: id,
      created,
      principal,
    });
    // No Git mutation follows ingestion; ordinary Git remains independently usable.
    return [];
  };
}
