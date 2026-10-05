import { DomainError, hash, record } from './hash.mjs';
import {
  repositoryId,
  repositoryRef,
  repositoryDescription,
  repositoryImportSource,
} from './repository-input.mjs';

const now = () => new Date().toISOString();
const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Initialize native records without converting compatibility proposals into Futures. */
export function initializeNativeState(state) {
  for (const key of [
    'systems',
    'objectives',
    'futures',
    'futureRevisions',
    'nativeRepositories',
    'nativeRequests',
    'nativeEvents',
  ])
    state[key] ??= [];
  return state;
}

function actorIdentity(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 200)
    throw new DomainError('UNAUTHENTICATED', 'An authenticated actor is required', 401);
}

function bounded(value, label, limit, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new DomainError('INVALID_NATIVE_INPUT', label + ' must be bounded, nonempty text');
  return value.trim();
}

function nameList(value, label, optional = false) {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new DomainError('INVALID_NATIVE_INPUT', label + ' must contain at most 100 entries');
  const result = value.map((entry) => bounded(entry, label, 200));
  if (new Set(result).size !== result.length)
    throw new DomainError('INVALID_NATIVE_INPUT', label + ' cannot contain duplicates');
  return result.sort();
}

function providerInfo(info, id, ref) {
  if (
    !info ||
    info.id !== id ||
    info.ref !== ref ||
    typeof info.provider !== 'string' ||
    !info.provider ||
    (!['importing', 'forking'].includes(info.status) &&
      (typeof info.remote !== 'string' || !info.remote)) ||
    (['importing', 'forking'].includes(info.status) &&
      info.remote !== null &&
      (typeof info.remote !== 'string' || !info.remote)) ||
    !['empty', 'ready', 'importing', 'forking'].includes(info.status) ||
    (info.status === 'ready' && (!objectId.test(info.commit) || !objectId.test(info.tree)))
  )
    throw new DomainError(
      'INVALID_PROVIDER_RESULT',
      'Repository provider returned incomplete Git facts',
      503,
    );
  return {
    id,
    name: id,
    canonical_ref: ref,
    provider: info.provider,
    remote: info.remote,
    status: info.status,
    head: info.status === 'ready' ? info.commit : null,
    tree: info.status === 'ready' ? info.tree : null,
    operation_id: typeof info.operation_id === 'string' ? info.operation_id : null,
  };
}

/**
 * Native System, Objective and isolated Future lifecycle.
 * Transports own authorization and serialize entire mutations. This service
 * additionally requires an actor and writes intent before provider effects.
 */
export class NativeState {
  constructor(engine) {
    this.engine = engine;
    initializeNativeState(engine.state);
  }

  get state() {
    return initializeNativeState(this.engine.state);
  }

  object(collection, id, code) {
    const value = this.state[collection].find((item) => item.id === id);
    if (!value) throw new DomainError(code, 'Native object not found', 404);
    return value;
  }
  getRepository(id) {
    const repository = this.repositories().find((item) => item.id === id);
    if (!repository) throw new DomainError('REPO_NOT_FOUND', 'Repository not found', 404);
    return repository;
  }
  system(id) {
    return this.object('systems', id, 'SYSTEM_NOT_FOUND');
  }
  objective(id) {
    return this.object('objectives', id, 'OBJECTIVE_NOT_FOUND');
  }
  future(id) {
    return this.object('futures', id, 'FUTURE_NOT_FOUND');
  }
  revision(id) {
    return this.object('futureRevisions', id, 'FUTURE_REVISION_NOT_FOUND');
  }

  provider(method) {
    if (typeof this.engine.git[method] !== 'function')
      throw new DomainError(
        'REPOSITORY_PROVIDER_UNAVAILABLE',
        'Repository lifecycle is unavailable',
        503,
      );
    return this.engine.git[method].bind(this.engine.git);
  }
  async save() {
    await this.engine.save(this.state);
  }

  async event(type, actor, data) {
    await this.engine.audit(type, actor, data);
    const time = now();
    this.state.nativeEvents.push(
      await record('event', {
        specversion: '1.0',
        type: 'io.klocgit.' + type,
        source: '/klocgit',
        subject:
          data.future_id ?? data.objective_id ?? data.system_id ?? data.repo ?? data.request_id,
        time,
        datacontenttype: 'application/json',
        data: { version: 0, ...data },
      }),
    );
  }

  /** Retry receipts are immutable in input; uncertain effects require reconciliation. */
  async request(operation, input, actor, callback) {
    actorIdentity(actor);
    const requestId = bounded(input.request_id, 'Request identity', 128);
    const payload = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== 'request_id'),
    );
    const id = 'request_' + (await hash({ actor, request_id: requestId }));
    const digest = await hash({ operation, input: payload });
    const existing = this.state.nativeRequests.find((request) => request.id === id);
    const safeRetry = ['repository.refresh', 'future.observe', 'repository.recover'].includes(
      operation,
    );
    if (existing) {
      if (existing.input_hash !== digest)
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'This request identity has different inputs',
          409,
        );
      if (existing.status === 'applied') return structuredClone(existing.result);
      if (existing.status === 'failed' && !safeRetry)
        throw new DomainError(existing.error.code, existing.error.message, existing.error.status);
      if (
        !safeRetry ||
        existing.effects.length ||
        !['failed', 'prepared'].includes(existing.status)
      )
        throw new DomainError(
          'RECOVERY_REQUIRED',
          'Reconcile the prepared operation before retrying',
          409,
          { request_id: id },
        );
    }
    const request = existing ?? {
      id,
      request_id: requestId,
      operation,
      input_hash: digest,
      input: structuredClone(payload),
      actor,
      status: 'prepared',
      effects: [],
      created_at: now(),
      attempts: 0,
    };
    request.status = 'prepared';
    request.attempts++;
    if (!existing) this.state.nativeRequests.push(request);
    await this.engine.audit('native.request.prepared', actor, { request_id: id, operation });
    await this.save();
    try {
      const result = await callback(request);
      request.result = structuredClone(result);
      request.status = 'applied';
      await this.save();
      return structuredClone(result);
    } catch (error) {
      // Even an acknowledged repository effect can outlive a failed metadata save.
      const uncertain = request.effects.length > 0;
      request.status = uncertain ? 'recovery_required' : 'failed';
      request.error = {
        code: uncertain ? 'RECOVERY_REQUIRED' : (error.code ?? 'NATIVE_OPERATION_FAILED'),
        message: uncertain ? 'Repository outcome requires reconciliation' : error.message,
        status: uncertain ? 503 : (error.status ?? 500),
      };
      if (request.future_id)
        this.future(request.future_id).status = uncertain ? 'recovery_required' : 'failed';
      await this.engine.audit(
        uncertain ? 'native.request.recovery_required' : 'native.request.failed',
        actor,
        {
          request_id: id,
          operation,
          error: request.error.code,
        },
      );
      await this.save();
      if (uncertain)
        throw new DomainError(request.error.code, request.error.message, request.error.status, {
          request_id: id,
        });
      throw error;
    }
  }

  async effect(request, method, input) {
    const invoke = this.provider(method);
    const effect = { method, input: structuredClone(input), status: 'prepared' };
    request.effects.push(effect);
    await this.save();
    const info = await invoke({ ...input, operation_id: request.id });
    effect.result = structuredClone(info);
    effect.status = 'observed';
    await this.save();
    return info;
  }

  registerObserved(info, id, ref, description = '') {
    const observed = providerInfo(info, id, ref);
    let repository = this.state.nativeRepositories.find((repo) => repo.id === id);
    if (!repository) {
      repository = { ...observed, description, baseline: observed.head, version: 1 };
      this.state.nativeRepositories.push(repository);
    } else
      Object.assign(repository, observed, {
        baseline: repository.baseline ?? observed.head,
        version: repository.version + 1,
      });
    // Empty repos are durable native records, never null-headed canonical entries.
    if (observed.status === 'ready') {
      const canonical = this.state.repositories.find((repo) => repo.id === id);
      if (canonical)
        Object.assign(canonical, observed, {
          baseline: canonical.baseline ?? observed.head,
          unavailable: false,
        });
      else
        this.state.repositories.push({
          ...observed,
          description,
          baseline: observed.head,
          validation_profile: null,
          context_repo: null,
        });
    } else {
      const canonical = this.state.repositories.find((repo) => repo.id === id);
      if (canonical) canonical.unavailable = true;
    }
    return repository;
  }

  repositories() {
    const registered = new Map(
      this.state.repositories.map((repo) => [
        repo.id,
        {
          ...repo,
          status: repo.unavailable ? 'unavailable' : (repo.status ?? 'ready'),
        },
      ]),
    );
    for (const repository of this.state.nativeRepositories) {
      const canonical = registered.get(repository.id);
      registered.set(
        repository.id,
        canonical
          ? { ...repository, ...canonical, status: canonical.unavailable ? 'unavailable' : 'ready' }
          : repository,
      );
    }
    return [...registered.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async registerRepository(input, actor) {
    repositoryId(input.id);
    const mode = input.mode ?? 'create';
    if (!['create', 'import', 'adopt'].includes(mode))
      throw new DomainError(
        'INVALID_NATIVE_INPUT',
        'Choose repository creation, import or adoption',
      );
    const value = {
      id: input.id,
      ref: repositoryRef(
        input.ref ??
          (mode === 'import' && input.source?.branch
            ? 'refs/heads/' + input.source.branch
            : undefined),
      ),
      mode,
      description: repositoryDescription(input.description),
      ...(mode === 'import' ? { source: repositoryImportSource(input.source) } : {}),
      request_id: input.request_id,
    };
    return this.request('repository.register', value, actor, async (request) => {
      if (this.repositories().some((repo) => repo.id === value.id))
        throw new DomainError('REPO_EXISTS', 'Repository is already registered', 409);
      let info;
      if (mode === 'adopt')
        info = await this.provider('repositoryInfo')({ id: value.id, ref: value.ref });
      else {
        try {
          await this.provider('repositoryInfo')({ id: value.id, ref: value.ref });
          throw new DomainError('REPO_EXISTS', 'Repository exists; adopt it explicitly', 409);
        } catch (error) {
          if (error.code !== 'REPO_NOT_FOUND') throw error;
        }
        info = await this.effect(
          request,
          mode === 'create' ? 'repositoryCreate' : 'repositoryImport',
          {
            id: value.id,
            ref: value.ref,
            description: value.description,
            ...(value.source ? { source: value.source } : {}),
          },
        );
      }
      const repository = this.registerObserved(info, value.id, value.ref, value.description);
      await this.event('repository.registered', actor, {
        repo: repository.id,
        mode,
        status: repository.status,
        head: repository.head,
      });
      return { repository, request: { id: request.id, status: 'applied' } };
    });
  }

  async refreshRepository(id, input, actor) {
    return this.request(
      'repository.refresh',
      { id, request_id: input.request_id },
      actor,
      async () => {
        const repository = this.repositories().find((repo) => repo.id === id);
        if (!repository) throw new DomainError('REPO_NOT_FOUND', 'Repository not found', 404);
        const info = await this.provider('repositoryInfo')({ id, ref: repository.canonical_ref });
        const observed = this.registerObserved(
          info,
          id,
          repository.canonical_ref,
          repository.description,
        );
        await this.event('repository.observed', actor, {
          repo: id,
          status: observed.status,
          head: observed.head,
        });
        return { repository: observed };
      },
    );
  }

  createSystemRecord(request, ids, name, description, actor) {
    const repositories = this.repositories();
    const refs = ids.map((id) => {
      const repository = repositories.find((repo) => repo.id === id);
      if (!repository) throw new DomainError('REPO_NOT_FOUND', 'Repository not found', 404);
      return { repo_id: id, ref: repository.canonical_ref };
    });
    const system = {
      id: 'system_' + request.id.slice(8),
      name,
      description,
      repository_refs: refs,
      version: 1,
      created_by: actor,
      created_at: now(),
    };
    this.state.systems.push(system);
    return system;
  }

  async createSystem(input, actor) {
    const value = {
      name: bounded(input.name, 'System name', 100),
      description: bounded(input.description, 'Description', 2000, true),
      repository_ids: nameList(input.repository_ids, 'Repositories'),
      request_id: input.request_id,
    };
    return this.request('system.create', value, actor, async (request) => {
      if (!value.repository_ids.length)
        throw new DomainError('INVALID_NATIVE_INPUT', 'A System needs at least one repository');
      const system = this.createSystemRecord(
        request,
        value.repository_ids,
        value.name,
        value.description,
        actor,
      );
      await this.event('system.created', actor, { system_id: system.id });
      return { system };
    });
  }

  createObjectiveRecord(request, system, statement, scope, actor) {
    const objective = {
      id: 'objective_' + request.id.slice(8),
      system_id: system.id,
      statement: statement || null,
      scope,
      source: statement
        ? { basis: 'declared', actor }
        : { basis: 'unknown', origin: 'future-creation' },
      status: 'open',
      created_by: actor,
      created_at: now(),
    };
    this.state.objectives.push(objective);
    return objective;
  }

  async createObjective(input, actor) {
    const value = {
      system_id: bounded(input.system_id, 'System identity', 200),
      statement: bounded(input.statement, 'Objective', 2000),
      scope: nameList(input.scope, 'Scope', true),
      request_id: input.request_id,
    };
    return this.request('objective.create', value, actor, async (request) => {
      const objective = this.createObjectiveRecord(
        request,
        this.system(value.system_id),
        value.statement,
        value.scope,
        actor,
      );
      await this.event('objective.created', actor, {
        objective_id: objective.id,
        system_id: objective.system_id,
      });
      return { objective };
    });
  }

  async canonicalVector(system, ids) {
    const vector = [];
    for (const entry of system.repository_refs.filter((ref) => ids.includes(ref.repo_id))) {
      const repo = this.state.repositories.find((repository) => repository.id === entry.repo_id);
      if (!repo)
        throw new DomainError(
          'REPOSITORY_NOT_READY',
          'Push an initial commit or finish import before creating a Future',
          409,
        );
      const commit = await this.engine.git.ref(repo, entry.ref);
      const facts = await this.engine.git.facts(repo, commit, commit);
      if (facts.head !== commit || !objectId.test(commit) || !objectId.test(facts.tree))
        throw new DomainError(
          'INVALID_GIT_FACTS',
          'Git did not establish an immutable baseline',
          503,
        );
      vector.push({ repo_id: repo.id, ref: entry.ref, commit, tree: facts.tree });
    }
    // Collection is not an atomic transaction across repositories. Known movement
    // is a failed observation, never an implicitly rebased baseline.
    for (const entry of vector)
      if ((await this.engine.git.ref(this.engine.repo(entry.repo_id), entry.ref)) !== entry.commit)
        throw new DomainError(
          'CANONICAL_CHANGED',
          'Canonical refs moved while observing the baseline',
          409,
        );
    return vector.sort((a, b) => a.repo_id.localeCompare(b.repo_id));
  }

  async createFuture(input, actor) {
    const producer = input.producer ?? { kind: 'unknown' };
    if (!producer || typeof producer !== 'object' || Array.isArray(producer))
      throw new DomainError('INVALID_NATIVE_INPUT', 'Producer must be metadata');
    const value = {
      system_id: bounded(input.system_id, 'System identity', 200, true),
      objective_id: bounded(input.objective_id, 'Objective identity', 200, true),
      name: bounded(input.name, 'Future name', 100, true),
      statement: bounded(input.statement, 'Objective', 2000, true),
      repository_ids: nameList(input.repository_ids, 'Repositories', true),
      producer: {
        kind: bounded(producer.kind, 'Producer kind', 100),
        ...(producer.id === undefined
          ? {}
          : { id: bounded(producer.id, 'Producer identity', 200) }),
      },
      request_id: input.request_id,
    };
    return this.request('future.create', value, actor, async (request) => {
      let objective = value.objective_id ? this.objective(value.objective_id) : null;
      if (objective && objective.status !== 'open')
        throw new DomainError('OBJECTIVE_CLOSED', 'This Objective is closed', 409);
      let system = value.system_id
        ? this.system(value.system_id)
        : objective
          ? this.system(objective.system_id)
          : null;
      if (objective && objective.system_id !== system.id)
        throw new DomainError(
          'OBJECTIVE_SYSTEM_MISMATCH',
          'The Objective belongs to another System',
          409,
        );
      if (!system) {
        if (!value.repository_ids.length)
          throw new DomainError('INVALID_NATIVE_INPUT', 'Choose a System or repository');
        system = this.state.systems.find(
          (item) =>
            item.repository_refs.length === value.repository_ids.length &&
            item.repository_refs.every((ref) => value.repository_ids.includes(ref.repo_id)),
        );
        if (!system) {
          system = this.createSystemRecord(
            request,
            value.repository_ids,
            value.repository_ids.join(', ').slice(0, 100),
            '',
            actor,
          );
          await this.event('system.created', actor, { system_id: system.id });
        }
      }
      const ids = value.repository_ids.length
        ? value.repository_ids
        : system.repository_refs.map((ref) => ref.repo_id);
      if (ids.some((id) => !system.repository_refs.some((ref) => ref.repo_id === id)))
        throw new DomainError(
          'INVALID_NATIVE_INPUT',
          'Future repositories must belong to the System',
        );
      const baseline = await this.canonicalVector(system, ids);
      if (!objective) {
        objective = this.createObjectiveRecord(request, system, value.statement, [], actor);
        await this.event('objective.created', actor, {
          objective_id: objective.id,
          system_id: system.id,
        });
      }
      const future = {
        id: 'future_' + request.id.slice(8),
        system_id: system.id,
        objective_id: objective.id,
        name: value.name || value.statement.slice(0, 100) || 'Work on ' + system.name,
        producer: value.producer,
        provenance_state: value.producer.kind === 'unknown' ? 'unknown' : 'declared',
        baseline_refs: baseline,
        repositories: await Promise.all(
          baseline.map(async (entry) => ({
            canonical_repo_id: entry.repo_id,
            repo_id:
              entry.repo_id.slice(0, 40) +
              '--' +
              (await hash({ request_id: request.id, repo_id: entry.repo_id })).slice(0, 40),
            ref: entry.ref,
            remote: null,
            status: 'prepared',
          })),
        ),
        status: 'preparing',
        creation_request_id: request.id,
        current_revision_id: null,
        version: 1,
        created_by: actor,
        created_at: now(),
      };
      if (
        new Set(future.repositories.map((repo) => repo.repo_id)).size !== future.repositories.length
      )
        throw new DomainError(
          'FORK_NAME_COLLISION',
          'Isolated repository identities are not unique',
          409,
        );
      this.state.futures.push(future);
      request.future_id = future.id;
      await this.save();
      for (const repository of future.repositories) {
        const source = baseline.find((entry) => entry.repo_id === repository.canonical_repo_id);
        const info = await this.effect(request, 'repositoryFork', {
          id: repository.repo_id,
          source,
          description: future.name,
        });
        this.observeFork(repository, source, info, request.id);
      }
      future.status = future.repositories.every((repo) => repo.status === 'ready')
        ? 'active'
        : 'preparing';
      await this.event('future.created', actor, {
        future_id: future.id,
        objective_id: objective.id,
        baseline_refs: baseline,
      });
      const revision = future.status === 'active' ? await this.observe(future, actor) : null;
      return { future, revision };
    });
  }

  observeFork(repository, baseline, info, operationId) {
    if (!['importing', 'forking'].includes(info.status) && info.operation_id !== operationId)
      throw new DomainError(
        'RECOVERY_REQUIRED',
        'Fork ownership differs from its prepared operation',
        409,
      );
    const observed = providerInfo(info, repository.repo_id, repository.ref);
    if (
      observed.status === 'ready' &&
      (observed.head !== baseline.commit || observed.tree !== baseline.tree)
    )
      throw new DomainError(
        'FORK_BASELINE_MISMATCH',
        'Fork differs from the captured baseline',
        409,
      );
    Object.assign(repository, { remote: observed.remote, status: observed.status });
  }

  async observeFuture(id, input, actor) {
    const value = { id, expected_version: input.expected_version, request_id: input.request_id };
    return this.request('future.observe', value, actor, async () => {
      const future = this.future(id);
      if (input.expected_version !== future.version)
        throw new DomainError('FUTURE_STALE', 'The Future changed before observation', 409);
      if (future.status === 'abandoned')
        throw new DomainError('FUTURE_ABANDONED', 'This Future is abandoned', 409);
      if (future.status === 'recovery_required')
        throw new DomainError('RECOVERY_REQUIRED', 'Reconcile repository creation first', 409);
      if (future.status === 'preparing') {
        for (const repository of future.repositories) {
          if (repository.status === 'ready') continue;
          const info = await this.provider('repositoryInfo')({
            id: repository.repo_id,
            ref: repository.ref,
          });
          this.observeFork(
            repository,
            future.baseline_refs.find((entry) => entry.repo_id === repository.canonical_repo_id),
            info,
            future.creation_request_id,
          );
        }
        if (future.repositories.some((repository) => repository.status !== 'ready'))
          throw new DomainError(
            'FUTURE_NOT_READY',
            'Isolated repositories are still being provisioned',
            409,
          );
      }
      const previous = future.current_revision_id;
      const revision = await this.observe(future, actor);
      return { future, revision, changed: previous !== revision.id };
    });
  }

  async observe(future, actor) {
    const repository_heads = [],
      tree_hashes = [],
      affected_scope = [];
    for (const repository of future.repositories) {
      const baseline = future.baseline_refs.find(
        (entry) => entry.repo_id === repository.canonical_repo_id,
      );
      const descriptor = {
        id: repository.repo_id,
        canonical_repo: repository.canonical_repo_id,
        canonical_ref: repository.ref,
      };
      const commit = await this.engine.git.ref(descriptor, repository.ref);
      const facts = await this.engine.git.facts(descriptor, commit, baseline.commit);
      if (
        facts.head !== commit ||
        !objectId.test(commit) ||
        !objectId.test(facts.tree) ||
        !Array.isArray(facts.scope)
      )
        throw new DomainError(
          'INVALID_GIT_FACTS',
          'Git did not establish an immutable Future state',
          503,
        );
      repository_heads.push({
        repo_id: repository.canonical_repo_id,
        source_repo_id: repository.repo_id,
        ref: repository.ref,
        commit,
      });
      tree_hashes.push({ repo_id: repository.canonical_repo_id, tree: facts.tree });
      affected_scope.push({
        repo_id: repository.canonical_repo_id,
        paths: [...new Set(facts.scope)].sort(),
      });
    }
    for (const entry of repository_heads)
      if ((await this.engine.git.ref({ id: entry.source_repo_id }, entry.ref)) !== entry.commit)
        throw new DomainError('FUTURE_CHANGED', 'Future refs moved during observation', 409);
    for (const repository of future.repositories) repository.status = 'ready';
    const previous = future.current_revision_id ? this.revision(future.current_revision_id) : null;
    if (previous && (await hash(previous.repository_heads)) === (await hash(repository_heads))) {
      if (future.status !== 'active') {
        future.status = 'active';
        future.version++;
      }
      return previous;
    }
    const data = {
      future_id: future.id,
      previous_revision_id: previous?.id ?? null,
      repository_heads,
      tree_hashes,
      baseline_refs: future.baseline_refs,
      affected_scope,
      producer: future.producer,
      context_snapshot: null,
      provenance_state: future.provenance_state,
    };
    // Observation time is metadata, not identity; the predecessor distinguishes A→B→A.
    const revision = await record('future_revision', {
      ...data,
      id: 'future_revision_' + (await hash(data)),
      created_at: now(),
    });
    this.state.futureRevisions.push(revision);
    future.current_revision_id = revision.id;
    future.status = 'active';
    future.version++;
    await this.event('future.revised', actor, {
      future_id: future.id,
      revision_id: revision.id,
      previous_revision_id: previous?.id ?? null,
    });
    return revision;
  }

  async abandonFuture(id, input, actor) {
    return this.request(
      'future.abandon',
      {
        id,
        expected_version: input.expected_version,
        request_id: input.request_id,
      },
      actor,
      async () => {
        const future = this.future(id);
        if (input.expected_version !== future.version)
          throw new DomainError('FUTURE_STALE', 'The Future changed before abandonment', 409);
        future.status = 'abandoned';
        future.version++;
        await this.event('future.abandoned', actor, {
          future_id: id,
          revision_id: future.current_revision_id,
        });
        return { future };
      },
    );
  }

  async recoverRequest(id, input, actor) {
    return this.request(
      'repository.recover',
      { id, request_id: input.request_id },
      actor,
      async () => {
        const original = this.object('nativeRequests', id, 'REQUEST_NOT_FOUND');
        if (original.status === 'applied') return structuredClone(original.result);
        if (!['prepared', 'recovery_required'].includes(original.status))
          throw new DomainError(
            'RECOVERY_NOT_REQUIRED',
            'This operation does not need reconciliation',
            409,
          );
        if (!original.effects.length) {
          if (
            !['repository.refresh', 'future.observe', 'repository.recover'].includes(
              original.operation,
            )
          )
            throw new DomainError(
              'RECOVERY_REQUIRED',
              'No authoritative repository effect identifies this operation',
              409,
            );
          original.status = 'failed';
          original.error = {
            code: 'READ_NOT_COMPLETED',
            message: 'The observation was interrupted; retry using current state',
            status: 409,
          };
          await this.event('native.request.reconciled', actor, {
            request_id: original.id,
            outcome: 'no_repository_effect',
          });
          return {
            request: { id: original.id, status: 'failed', retryable: true },
            outcome: 'no_repository_effect',
          };
        }
        for (const effect of original.effects) {
          const ref = effect.input.ref ?? effect.input.source.ref;
          const info = await this.provider('repositoryInfo')({ id: effect.input.id, ref });
          if (info.operation_id !== original.id)
            throw new DomainError(
              'RECOVERY_REQUIRED',
              'Existing repository ownership does not match this operation',
              409,
            );
          providerInfo(info, effect.input.id, ref);
          effect.result = structuredClone(info);
          effect.status = 'observed';
        }
        let result;
        if (original.operation === 'repository.register') {
          const value = original.input;
          const info = original.effects.at(-1).result;
          if (value.mode === 'import' && info.status === 'empty')
            throw new DomainError(
              'RECOVERY_REQUIRED',
              'An empty repository does not establish that import succeeded',
              409,
            );
          const repository = this.registerObserved(info, value.id, value.ref, value.description);
          result = { repository, request: { id: original.id, status: 'applied' } };
        } else if (original.operation === 'future.create') {
          const future = this.future(original.future_id);
          for (const repository of future.repositories) {
            const effect = original.effects.find((item) => item.input.id === repository.repo_id);
            // A partial creation has no inferred success or rollback. Missing
            // repositories require a separately inspected retry, not blind replay.
            if (!effect)
              throw new DomainError(
                'RECOVERY_REQUIRED',
                'Some isolated repositories have not been created',
                409,
              );
            this.observeFork(
              repository,
              future.baseline_refs.find((entry) => entry.repo_id === repository.canonical_repo_id),
              effect.result,
              original.id,
            );
          }
          const abandoned = future.status === 'abandoned';
          if (!abandoned)
            future.status = future.repositories.every((repo) => repo.status === 'ready')
              ? 'active'
              : 'preparing';
          const revision = abandoned
            ? future.current_revision_id
              ? this.revision(future.current_revision_id)
              : null
            : future.status === 'active'
              ? await this.observe(future, actor)
              : null;
          result = { future, revision };
        } else
          throw new DomainError(
            'RECOVERY_REQUIRED',
            'This operation has no repository reconciliation strategy',
            409,
          );
        original.result = structuredClone(result);
        original.status = 'applied';
        await this.event('repository.recovered', actor, {
          request_id: original.id,
          future_id: original.future_id ?? null,
        });
        return result;
      },
    );
  }

  /** Native push ingress uses Git freshness; event timestamps never select latest state. */
  async observeRepositoryPush(event, actor) {
    actorIdentity(actor);
    if (!event || typeof event !== 'object')
      throw new DomainError('INVALID_EVENT', 'A Git push is required');
    const id = event.source_repo ?? event.repo;
    const future = this.state.futures.find((item) =>
      item.repositories.some((repo) => repo.repo_id === id),
    );
    const repository = this.repositories().find((repo) => repo.id === id);
    const nativeCanonical = this.state.nativeRepositories.some((repo) => repo.id === id);
    if (!future && (!repository || !nativeCanonical)) return { handled: false };
    const binding = future?.repositories.find((repo) => repo.repo_id === id);
    const ref = binding?.ref ?? repository.canonical_ref;
    if (
      typeof event.ref !== 'string' ||
      !event.ref.startsWith('refs/') ||
      event.ref.length > 255 ||
      typeof event.after !== 'string' ||
      !objectId.test(event.after) ||
      (event.before !== undefined &&
        event.before !== null &&
        (typeof event.before !== 'string' || !objectId.test(event.before)))
    )
      throw new DomainError(
        'INVALID_EVENT',
        'Git push requires bounded refs and immutable before/after object IDs',
      );
    if (future?.status === 'abandoned')
      return { handled: true, ignored: true, reason: 'FUTURE_ABANDONED' };
    if (event.ref !== ref) {
      if (!future) return { handled: false };
      const data = {
        repo: id,
        ref: event.ref,
        before: event.before ?? null,
        after: event.after ?? null,
        basis: 'unknown',
      };
      const duplicate = this.state.nativeEvents.some(
        (item) =>
          item.type === 'io.klocgit.repository.ref_untracked' &&
          item.data.repo === data.repo &&
          item.data.ref === data.ref &&
          item.data.before === data.before &&
          item.data.after === data.after,
      );
      if (!duplicate) {
        await this.event('repository.ref_untracked', actor, data);
        await this.save();
      }
      return { handled: true, ignored: true, reason: 'UNTRACKED_REF', duplicate };
    }
    let observed;
    try {
      observed = await this.engine.git.ref({ id }, ref);
    } catch (error) {
      if (error.code !== 'REF_NOT_FOUND') throw error;
      if (!/^0{40,64}$/.test(event.after)) throw error;
      if (binding) {
        if (binding.status === 'unavailable' && future.status === 'unavailable')
          return { handled: true, deleted: true, duplicate: true };
        binding.status = 'unavailable';
        future.status = 'unavailable';
        future.version++;
      } else {
        const native = this.state.nativeRepositories.find((repo) => repo.id === id);
        if (native?.status === 'unavailable')
          return { handled: true, deleted: true, duplicate: true };
        if (native) native.status = 'unavailable';
        const canonical = this.state.repositories.find((repo) => repo.id === id);
        if (canonical) canonical.unavailable = true;
      }
      await this.event('repository.ref_unavailable', actor, {
        repo: id,
        ref,
        previous: event.before ?? null,
      });
      await this.save();
      return { handled: true, deleted: true };
    }
    if (observed !== event.after)
      return { handled: true, ignored: true, reason: 'OUT_OF_ORDER_EVENT', head: observed };
    if (future) {
      if (future.status === 'abandoned')
        return { handled: true, ignored: true, reason: 'FUTURE_ABANDONED' };
      if (future.status === 'recovery_required')
        return { handled: true, reason: 'RECOVERY_REQUIRED' };
      if (future.status === 'preparing') return { handled: true, reason: 'FUTURE_NOT_READY' };
      const before = future.current_revision_id;
      const revision = await this.observe(future, actor);
      if (binding) binding.status = 'ready';
      await this.save();
      return {
        handled: true,
        future_id: future.id,
        revision_id: revision.id,
        duplicate: revision.id === before,
      };
    }
    const info = await this.provider('repositoryInfo')({ id, ref });
    if (
      repository.status === 'ready' &&
      repository.head === info.commit &&
      repository.tree === info.tree
    )
      return {
        handled: true,
        canonical: true,
        duplicate: true,
        repository: structuredClone(repository),
      };
    const result = this.registerObserved(info, id, ref, repository.description);
    await this.event('canonical.changed', actor, {
      repo: id,
      head: result.head,
      tree: result.tree,
    });
    await this.save();
    return { handled: true, canonical: true, repository: structuredClone(result) };
  }

  view(actor) {
    if (actor !== undefined) actorIdentity(actor);
    const repositories = this.repositories();
    const recovery = this.state.nativeRequests.filter((request) =>
      ['prepared', 'recovery_required'].includes(request.status),
    );
    return structuredClone({
      systems: this.state.systems.map((system) => ({
        ...system,
        repository_ids: system.repository_refs.map((ref) => ref.repo_id),
        repository_refs: system.repository_refs.map((ref) => ({
          ...ref,
          ...(() => {
            const repo = repositories.find((entry) => entry.id === ref.repo_id);
            return { status: repo?.status ?? 'unavailable', remote: repo?.remote ?? null };
          })(),
        })),
      })),
      objectives: this.state.objectives,
      futures: this.state.futures,
      futureRevisions: this.state.futureRevisions,
      repositories,
      requests: this.state.nativeRequests.map(
        ({ input: _input, effects: _effects, result: _result, ...request }) => request,
      ),
      attention: { kind: recovery.length ? 'recovery' : 'nothing', count: recovery.length },
    });
  }
}
