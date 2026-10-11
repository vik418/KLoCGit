/** Import an authorized local Candidate at promotion time, then perform Git CAS. */
import { git } from '../../server/git.mjs';
import { LocalGitStore } from './git-store.mjs';
import { V1Error, assertIdempotencyKey } from '../../core/v1/conventions.mjs';
import { gitOid, gitRef, copyJsonData } from '../../core/v1/domain.mjs';
import { GitRefRejection, gitSnapshot } from '../../core/v1/git-store.mjs';
import { gitObjectOid } from '../../core/v1/workspace.mjs';

const immutableReads = ['--no-replace-objects', '--no-lazy-fetch'];

export class LocalCandidateGitStore extends LocalGitStore {
  constructor({ resolvePromotionSource, limits, ...options }) {
    super(options);
    if (typeof resolvePromotionSource !== 'function') throw new V1Error('INVALID_ARGUMENT');
    const budget = copyJsonData(limits);
    const fields = ['max_objects', 'max_bytes', 'max_history_commits'];
    if (
      !budget ||
      Object.keys(budget).length !== fields.length ||
      fields.some((key) => !Number.isSafeInteger(budget[key]) || budget[key] < 1)
    )
      throw new V1Error('INVALID_ARGUMENT');
    this.resolvePromotionSource = resolvePromotionSource;
    this.limits = Object.freeze(budget);
  }

  async snapshot(commit_oid) {
    gitOid(commit_oid);
    const source = await this.resolvePromotionSource(this.repository.id, commit_oid);
    if (!source) return super.snapshot(commit_oid);
    return (await this.#workspace(source, commit_oid)).identity;
  }

  async #workspace(source, commit_oid) {
    const workspace = await source.fetch(
      { schema_version: 1, repo_id: this.repository.id, commit_oid },
      { blobs: 'none' },
    );
    const identity = gitSnapshot(workspace.identity);
    if (identity.repo_id !== this.repository.id || identity.commit_oid !== commit_oid)
      throw new V1Error('INTEGRITY_MISMATCH');
    if (workspace.status().metadata_complete !== true) throw new V1Error('INCOMPLETE_ANALYSIS');
    return workspace;
  }

  async #contains(oid, kind) {
    try {
      const actual = await git(this.adapter.dir(this.repository), [
        ...immutableReads,
        'cat-file',
        '-t',
        oid,
      ]);
      if (actual !== kind) throw new V1Error('INTEGRITY_MISMATCH');
      return true;
    } catch (error) {
      if (error instanceof V1Error) throw error;
      if (
        Number.isInteger(error.code) &&
        /could not get object info|Not a valid object name/.test(error.stderr ?? '')
      )
        return false;
      throw new V1Error('PROVIDER_UNAVAILABLE');
    }
  }

  async #objects(source, target) {
    const pending = [target],
      seen = new Set(),
      visitedObjects = new Set(),
      objects = new Map();
    let bytes = 0,
      commits = 0;
    while (pending.length) {
      const oid = pending.pop();
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (++commits > this.limits.max_history_commits) throw new V1Error('INCOMPLETE_ANALYSIS');
      if (await this.#contains(oid, 'commit')) continue;
      const workspace = await this.#workspace(source, oid);
      for (const object of workspace.objectInventory()) {
        gitOid(object.oid, target.length);
        if (!['commit', 'tree', 'blob'].includes(object.kind))
          throw new V1Error('INVALID_ARGUMENT');
        if (visitedObjects.has(object.oid)) continue;
        visitedObjects.add(object.oid);
        if (visitedObjects.size > this.limits.max_objects) throw new V1Error('INCOMPLETE_ANALYSIS');
        if (await this.#contains(object.oid, object.kind)) continue;
        const result = await workspace.readObject(object.oid, object.kind);
        if (result.status !== 'AVAILABLE')
          throw new V1Error(result.status === 'MISSING' ? 'NOT_FOUND' : 'PROVIDER_UNAVAILABLE');
        if (!(result.bytes instanceof Uint8Array)) throw new V1Error('INTEGRITY_MISMATCH');
        const content = result.bytes.slice();
        if ((bytes += content.length) > this.limits.max_bytes)
          throw new V1Error('INCOMPLETE_ANALYSIS');
        if ((await gitObjectOid(object.kind, content, target.length)) !== object.oid)
          throw new V1Error('INTEGRITY_MISMATCH');
        objects.set(object.oid, { ...object, bytes: content });
      }
      pending.push(...workspace.identity.parent_oids);
    }
    return [...objects.values()];
  }

  /**
   * Called by the trusted PromotionService after current basis/policy authorization.
   * Reads and preflight never persist candidate objects. Complete verified bytes
   * enter canonical Git only for the authorized promotion attempt. An external
   * push may still win; update-ref always checks the original reviewed OID.
   */
  async compare_and_swap_ref(ref, expected, target, options) {
    gitRef(ref);
    gitOid(expected);
    gitOid(target, expected.length);
    assertIdempotencyKey(options?.idempotency_key);
    try {
      if ((await this.observe_ref(this.repository.id, ref)) !== expected) return false;
      const source = await this.resolvePromotionSource(this.repository.id, target);
      const objects = source ? await this.#objects(source, target) : [];
      if ((await this.observe_ref(this.repository.id, ref)) !== expected) return false;
      for (const object of objects) {
        const written = await git(
          this.adapter.dir(this.repository),
          [...immutableReads, 'hash-object', '-w', '-t', object.kind, '--stdin'],
          object.bytes,
        );
        if (written !== object.oid) throw new V1Error('INTEGRITY_MISMATCH');
      }
    } catch (error) {
      // Object hydration/import has not attempted the canonical ref write.
      // This receipt lets the journal reject safely instead of blocking forever.
      throw new GitRefRejection(error instanceof V1Error ? error.code : 'PROVIDER_UNAVAILABLE');
    }
    try {
      await git(this.adapter.dir(this.repository), [
        ...immutableReads,
        'update-ref',
        ref,
        target,
        expected,
      ]);
      return true;
    } catch (error) {
      if (
        typeof error.stderr === 'string' &&
        error.stderr.includes("cannot lock ref '" + ref + "'") &&
        error.stderr.includes('but expected ' + expected)
      )
        return false;
      throw new V1Error('OUTCOME_UNKNOWN');
    }
  }
}
