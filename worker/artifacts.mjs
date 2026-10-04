import { DomainError } from '../core/hash.mjs';
export class ArtifactsGit {
  constructor(env) {
    this.env = env;
    this.configHash = env.VALIDATION_CONFIG_HASH ?? 'unconfigured';
  }
  async withRepo(repo, fn) {
    const capability = await this.env.ARTIFACTS.get(repo.id);
    try {
      return await fn(capability);
    } finally {
      capability[Symbol.dispose]?.();
    }
  }
  async ref(repo, ref) {
    return this.withRepo(repo, async (r) => {
      const log = await r.log({ ref, limit: 1 });
      if (!log.length) throw new DomainError('REF_NOT_FOUND', 'Git ref does not exist', 404);
      return log[0].hash;
    });
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
    const values = await this.execute('trailers', { repo: repo.id, commit });
    return values.map((t) => `${t.key}: ${t.value}`).join('\n');
  }
  suitesForScope(repo, scope) {
    return repo.validation_profile === 'checkout-effects-v2' &&
      scope.some((p) => ['client/retry.mjs', 'server/charge.mjs', 'app.mjs'].includes(p))
      ? ['checkout-effects']
      : [];
  }
  async execute(operation, payload) {
    if (!this.env.GIT_EXECUTOR || !this.env.GIT_BRIDGE_TOKEN || this.configHash === 'unconfigured')
      throw new DomainError(
        'GIT_EXECUTOR_UNAVAILABLE',
        'A trusted Git executor and versioned validation configuration must be configured. Git ingestion remains available.',
        503,
      );
    const response = await this.env.GIT_EXECUTOR.fetch(
      new Request('https://git-executor.internal/' + operation, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.env.GIT_BRIDGE_TOKEN,
        },
        body: JSON.stringify({ ...payload, configHash: this.configHash }),
      }),
    );
    const data = await response.json();
    if (!response.ok)
      throw new DomainError(
        data.error ?? 'GIT_EXECUTOR_FAILED',
        data.message ?? 'Git executor failed',
        response.status,
      );
    return data;
  }
  async profile(repo) {
    return this.execute('profile', { repo: repo.id });
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
    const result = await this.execute('diff', { repo: repo.id, base, head });
    return result.diff;
  }
}
