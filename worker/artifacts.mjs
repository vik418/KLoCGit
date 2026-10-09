import { ArtifactSubscriptions } from './artifact-subscriptions.mjs';
import { DomainError } from '../core/hash.mjs';
import { observationRef } from '../core/git-refs.mjs';
import {
  artifactRemote,
  requestSourceBindings,
  SOURCE_TOKEN_TTL,
  validSourceToken,
} from '../server/source-authority.mjs';
import {
  artifactRepositoryCreate,
  artifactRepositoryFork,
  artifactRepositoryImport,
  artifactRepositoryInfo,
} from './artifact-repositories.mjs';

/**
 * Worker-side Git adapter: native Artifacts reads remain available without the
 * executor, while composition, validation and canonical writes use the trusted
 * service. A native read result never substitutes for composed-tree validation.
 *
 * @param {object} env Artifacts binding, private executor service/credential and
 *   the expected validation configuration hash.
 */
export class ArtifactsGit {
  constructor(env) {
    this.env = env;
    this.configHash = env.VALIDATION_CONFIG_HASH;
  }
  repositorySubscriptionPreflight() {
    return new ArtifactSubscriptions(this.env).preflight();
  }
  repositorySubscribe(input) {
    return new ArtifactSubscriptions(this.env).ensure(input);
  }
  repositorySubscriptionInfo(input) {
    return new ArtifactSubscriptions(this.env).inspect(input);
  }
  repositoryCreate(input) {
    return artifactRepositoryCreate(this.env, input);
  }
  repositoryImport(input) {
    return artifactRepositoryImport(this.env, input);
  }
  repositoryFork(input) {
    return artifactRepositoryFork(this.env, input);
  }
  repositoryInfo(input) {
    return artifactRepositoryInfo(this.env, input);
  }
  async withRepo(repo, fn) {
    const capability = await this.env.ARTIFACTS.get(repo.id);
    try {
      return await fn(capability);
    } finally {
      capability[Symbol.dispose]?.();
    }
  }
  async readRef(repo, ref) {
    observationRef(ref);
    if (ref.startsWith('refs/tags/'))
      return this.execute('read-ref', { ...this.descriptor(repo), ref });
    return this.withRepo(repo, async (r) => {
      const log = await r.log({ ref, limit: 1 });
      if (!log.length) throw new DomainError('REF_NOT_FOUND', 'Git ref does not exist', 404);
      return {
        ref,
        kind: 'branch',
        object_id: log[0].hash,
        object_type: 'commit',
        commit: log[0].hash,
        available_for_future: true,
      };
    });
  }
  async ref(repo, ref) {
    const value = await this.readRef(repo, ref);
    if (!value.available_for_future)
      throw new DomainError('REF_NOT_COMMIT', 'This ref does not resolve to a commit', 422);
    return value.commit;
  }
  async retainObservation(repo, objects) {
    return this.execute('retain-observation', { ...this.descriptor(repo), objects });
  }
  async listRefs(repo, input = {}) {
    // The binding's commit log cannot prove a tag's object identity or enumerate refs.
    return this.execute('list-refs', { ...this.descriptor(repo), ...input });
  }
  async flatten(r, tree, prefix = '', budget = { count: 0 }) {
    if (++budget.count > 20000)
      throw new DomainError(
        'ANALYSIS_BUDGET',
        'Tree traversal requires a larger asynchronous analysis budget',
        422,
      );
    const output = Object.create(null);
    const entries = await r.readTree(tree);
    if (!entries) throw new DomainError('MISSING_TREE', 'Immutable Git tree is unavailable', 404);
    for (const entry of entries) {
      const file = prefix + entry.name;
      if (entry.type === 'tree')
        Object.assign(output, await this.flatten(r, entry.hash, file + '/', budget));
      else output[file] = { hash: entry.hash, mode: entry.mode };
    }
    return output;
  }
  async facts(repo, head, base) {
    return this.withRepo(repo, async (r) => {
      const [commit, baseline] = await Promise.all([r.readCommit(head), r.readCommit(base)]);
      if (!commit || !baseline)
        throw new DomainError('MISSING_COMMIT', 'Immutable Git commit is unavailable', 404);
      const [a, b] = await Promise.all([
        this.flatten(r, commit.treeHash),
        this.flatten(r, baseline.treeHash),
      ]);
      const scope = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
        .sort();
      return { head: commit.hash, base: baseline.hash, tree: commit.treeHash, scope };
    });
  }
  async file(repo, commit, path) {
    if (!/^[a-f0-9]{40}$/.test(commit ?? ''))
      throw new DomainError('INVALID_COMMIT', 'Context reads require an immutable commit');
    if (
      typeof path !== 'string' ||
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw new DomainError('INVALID_CONTEXT_PATH', 'Use a repository-relative file path');
    return this.withRepo(repo, async (r) => {
      const blob = await r.readFile({ ref: commit, path });
      if (blob === null) return null;
      if (blob.size > 1048576)
        throw new DomainError('CONTEXT_FILE_LIMIT', 'Context files are bounded at 1MiB', 422);
      return blob.text();
    });
  }
  async message(repo, commit) {
    return this.withRepo(repo, async (r) => {
      const value = await r.readCommit(commit);
      if (!value) throw new DomainError('MISSING_COMMIT', 'Immutable commit is unavailable', 404);
      return value.message;
    });
  }
  async trailers(repo, commit) {
    const values = await this.execute('trailers', { ...this.descriptor(repo), commit });
    return values.map((t) => `${t.key}: ${t.value}`).join('\n');
  }
  suitesForScope(repo, scope) {
    return repo.validation_profile === 'checkout-effects-v0' &&
      scope.some((p) => ['client/retry.mjs', 'server/charge.mjs', 'app.mjs'].includes(p))
      ? ['checkout-effects']
      : [];
  }
  /**
   * Send one trusted operation with the platform's configuration hash. The
   * executor can reject mismatched validation code; caller-supplied payloads
   * cannot replace this hash. No request is retried here, since a lost mutation
   * reply requires canonical journal recovery.
   *
   * @param {string} operation Executor operation selected by an adapter wrapper.
   * @param {object} payload Repository and exact operation inputs.
   * @returns {Promise<*>} Parsed operation-specific JSON from the executor.
   * @throws {DomainError} Executor/configuration is missing or a non-success reply arrives.
   * @throws {Error} Service transport or response JSON parsing fails.
   */
  async execute(operation, payload) {
    if (
      !this.env.GIT_EXECUTOR ||
      !this.env.GIT_BRIDGE_TOKEN ||
      typeof this.configHash !== 'string' ||
      !this.configHash.trim()
    )
      throw new DomainError(
        'GIT_EXECUTOR_UNAVAILABLE',
        'A trusted Git executor and versioned validation configuration must be configured. Git ingestion remains available.',
        503,
      );
    if (Object.hasOwn(payload, 'source_credentials'))
      throw new DomainError(
        'SOURCE_AUTHORITY_INVALID',
        'Executor credentials are selected by the adapter',
        403,
      );
    const bindings = requestSourceBindings(operation, payload);
    const handles = [];
    try {
      const credentials = [];
      for (const binding of bindings) {
        let capability;
        try {
          capability = await this.env.ARTIFACTS.get(binding.id);
          const handle = { capability, token: null };
          handles.push(handle);
          const info = await capability.info();
          const remote = artifactRemote(info.remote, binding.id);
          handle.token = await capability.createToken('read', SOURCE_TOKEN_TTL);
          if (!validSourceToken(handle.token))
            throw new DomainError(
              'SOURCE_CREDENTIAL_INVALID',
              'Artifacts returned invalid scoped credentials',
              503,
            );
          credentials.push({
            ...binding,
            remote: remote.remote,
            scope: 'read',
            plaintext: handle.token.plaintext,
            expiresAt: handle.token.expiresAt,
          });
        } catch {
          throw new DomainError(
            'SOURCE_CREDENTIAL_UNAVAILABLE',
            'A short-lived read credential could not be established for the registered source',
            503,
          );
        }
      }
      const response = await this.env.GIT_EXECUTOR.fetch(
        new Request('https://git-executor.internal/' + operation, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + this.env.GIT_BRIDGE_TOKEN,
          },
          body: JSON.stringify({
            ...payload,
            configHash: this.configHash,
            ...(credentials.length ? { source_credentials: credentials } : {}),
          }),
        }),
      );
      const data = await response.json();
      if (credentials.some((entry) => JSON.stringify(data).includes(entry.plaintext)))
        throw new DomainError(
          'SOURCE_CREDENTIAL_LEAK',
          'Executor returned private credential material',
          503,
        );
      if (!response.ok)
        throw new DomainError(
          data.error ?? 'GIT_EXECUTOR_FAILED',
          data.message ?? 'Git executor failed',
          response.status,
        );
      return data;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'GIT_EXECUTOR_UNAVAILABLE',
        'Trusted Git transport requires reconciliation; private credentials are excluded from diagnostics',
        503,
      );
    } finally {
      // Revocation is best effort after the one RPC. Bounded read-only expiry is
      // the failure floor if the coordinator or provider disappears mid-call.
      for (const { capability, token } of handles) {
        if (token) {
          try {
            await capability.revokeToken(token.id || token.plaintext);
          } catch {}
        }
        try {
          capability[Symbol.dispose]?.();
        } catch {}
      }
    }
  }

  async profile(repo) {
    return this.execute('profile', this.descriptor(repo));
  }
  descriptor(repo) {
    return {
      repo: repo.id,
      validation_profile: repo.validation_profile ?? null,
      context_repo: repo.context_repo ?? null,
      ...(repo.canonical_repo ? { canonical_repo: repo.canonical_repo } : {}),
      ...(repo.source_repo ? { source_repo: repo.source_repo } : {}),
    };
  }
  async compose(repo, head, revisions) {
    return this.execute('compose', { ...this.descriptor(repo), head, revisions });
  }
  async composeSelections(repo, head, selections) {
    return this.execute('compose-selections', { ...this.descriptor(repo), head, selections });
  }
  async isAncestor(repo, ancestor, descendant) {
    if (![ancestor, descendant].every((value) => /^[a-f0-9]{40}$/.test(value ?? '')))
      throw new DomainError('INVALID_COMMIT', 'Ancestry checks require immutable commit hashes');
    const result = await this.execute('is-ancestor', {
      ...this.descriptor(repo),
      ancestor,
      descendant,
    });
    if (typeof result.isAncestor !== 'boolean')
      throw new DomainError(
        'GIT_EXECUTOR_FAILED',
        'Executor returned invalid ancestry evidence',
        503,
      );
    return result.isAncestor;
  }
  async mergeBase(repo, head, canonical) {
    if (![head, canonical].every((value) => /^[a-f0-9]{40}$/.test(value ?? '')))
      throw new DomainError('INVALID_COMMIT', 'Merge base checks require immutable commit hashes');
    const result = await this.execute('merge-base', { ...this.descriptor(repo), head, canonical });
    if (!/^[a-f0-9]{40}$/.test(result.base ?? ''))
      throw new DomainError(
        'GIT_EXECUTOR_FAILED',
        'Executor returned an invalid immutable merge base',
        503,
      );
    return result.base;
  }
  async revert(repo, head, target, mainline) {
    if (![head, target].every((value) => /^[a-f0-9]{40}$/.test(value ?? '')))
      throw new DomainError('INVALID_COMMIT', 'Revert candidates require immutable commit hashes');
    return this.execute('revert', {
      ...this.descriptor(repo),
      head,
      target,
      ...(mainline !== undefined && mainline !== null ? { mainline } : {}),
    });
  }
  async validate(repo, commit, constraints, validityHeads) {
    return this.execute('validate', {
      ...this.descriptor(repo),
      commit,
      constraints,
      validityHeads,
    });
  }
  async cas(repo, expected, commit) {
    const result = await this.execute('cas', {
      ...this.descriptor(repo),
      ref: repo.canonical_ref,
      expected,
      commit,
    });
    return result.updated === true;
  }
  async diff(repo, base, head) {
    const result = await this.execute('diff', { ...this.descriptor(repo), base, head });
    return result.diff;
  }
}
