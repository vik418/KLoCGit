import { DomainError, hash, record } from './hash.mjs';
import { observationRef, refPage, gitObjectId } from './git-refs.mjs';
import {
  repositoryId,
  repositoryRef,
  repositoryDescription,
  repositoryImportSource,
  RepositoryPreflightError,
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
    'nativeRefObservations',
    'nativeRetentions',
  ])
    state[key] ??= [];
  state.nativeRefStates ??= {};
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
  async readRef(repo, ref) {
    observationRef(ref);
    const value = typeof this.engine.git.readRef === 'function'
      ? await this.engine.git.readRef(repo, ref)
      : await this.engine.git.ref(repo, ref).then((commit) => ({
          ref, kind: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
          object_id: commit, object_type: 'commit', commit, available_for_future: true,
        }));
    if (!value || value.ref !== ref || !gitObjectId.test(value.object_id) ||
        !['commit', 'tag', 'tree', 'blob'].includes(value.object_type) ||
        (value.commit !== null && !gitObjectId.test(value.commit)) ||
        value.available_for_future !== gitObjectId.test(value.commit))
      throw new DomainError('INVALID_GIT_FACTS', 'Git returned invalid ref facts', 503);
    return { ref, kind: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
      object_id: value.object_id, object_type: value.object_type,
      commit: value.commit, available_for_future: value.available_for_future };
  }

  /** Expose ordinary refs without changing the repository's canonical branch. */
  async listRepositoryRefs(id, input = {}, actor) {
    actorIdentity(actor);
    const page = refPage(input);
    const isolated = this.state.futures.flatMap((future) => future.repositories)
      .find((repo) => repo.repo_id === id);
    if (!isolated) this.getRepository(id);
    const result = await this.provider('listRefs')({ id, ...(isolated ? { canonical_repo: isolated.canonical_repo_id } : {}) }, page);
    if (!result || !Array.isArray(result.refs) || result.refs.length > page.limit ||
        typeof result.has_more !== 'boolean' ||
        (result.next_cursor !== null && typeof result.next_cursor !== 'string'))
      throw new DomainError('INVALID_GIT_FACTS', 'Git returned an invalid ref page', 503);
    let previous = page.cursor;
    for (const entry of result.refs) {
      observationRef(entry.ref);
      if (entry.ref <= previous || !gitObjectId.test(entry.object_id) ||
          !['commit', 'tag', 'tree', 'blob', 'unknown'].includes(entry.object_type) ||
          (entry.commit !== null && !gitObjectId.test(entry.commit)) ||
          ![true, false, null].includes(entry.available_for_future))
        throw new DomainError('INVALID_GIT_FACTS', 'Git returned invalid ref metadata', 503);
      previous = entry.ref;
    }
    if (result.has_more && result.next_cursor !== result.refs.at(-1)?.ref)
      throw new DomainError('INVALID_GIT_FACTS', 'Git returned an inconsistent ref cursor', 503);
    return { repo_id: id, ...result };
  }

  async rememberRef(repoId, ref, value, actor) {
    const key = repoId + ':' + ref;
    const previous = this.state.nativeRefObservations.find(
      (entry) => entry.id === this.state.nativeRefStates[key],
    );
    const facts = { repo_id: repoId, ref, status: value ? value.available_for_future ? 'ready' : 'unsupported' : 'missing',
      object_id: value?.object_id ?? null, object_type: value?.object_type ?? null,
      commit: value?.commit ?? null, basis: 'observed' };
    if (previous && await hash(previous.facts) === await hash(facts)) return previous;
    const observed = await record('ref_observation', {
      facts, previous_observation_id: previous?.id ?? null, created_at: now(),
    });
    this.state.nativeRefObservations.push(observed);
    this.state.nativeRefStates[key] = observed.id;
    await this.event('repository.ref_observed', actor, { ...facts, observation_id: observed.id });
    return observed;
  }

  async retainRef(repo, value, actor, retry = false) {
    const subject = { source_repo_id: repo.id, archive_repo_id: repo.canonical_repo ?? repo.id,
      object_ids: [...new Set([value.object_id, value.commit].filter(Boolean))].sort() };
    const key = await hash(subject);
    const previous = this.state.nativeRetentions.filter((entry) => entry.subject_hash === key).at(-1);
    if (previous && (previous.status === 'retained' || !retry)) return previous;
    let status = 'pending', refs = [], reason = 'RETENTION_UNAVAILABLE';
    if (typeof this.engine.git.retainObservation === 'function') {
      try {
        const result = await this.engine.git.retainObservation(repo, subject.object_ids);
        if (result?.source_repo_id !== subject.source_repo_id || result?.archive_repo_id !== subject.archive_repo_id ||
            !Array.isArray(result.objects) || result.objects.length !== subject.object_ids.length ||
            result.objects.some((entry) => !subject.object_ids.includes(entry.object_id) ||
              entry.ref !== 'refs/klocgit/observations/' + repo.id + '/' + entry.object_id) ||
            new Set(result.objects.map((entry) => entry.object_id)).size !== subject.object_ids.length)
          throw new DomainError('INVALID_RETENTION_RESULT', 'Archive object receipt differs from immutable inputs', 503);
        status = 'retained';
        refs = result.objects;
        reason = null;
      } catch (error) {
        // A failed archive must not prevent ordinary Git ingestion or claim durable object retention.
        reason = typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'RETENTION_UNAVAILABLE';
      }
    }
    if (previous?.status === status && previous.reason === reason) return previous;
    const retention = await record('retention', { subject, subject_hash: key, status, refs, reason, created_at: now() });
    this.state.nativeRetentions.push(retention);
    await this.event('repository.retention_observed', actor, { source_repo_id: repo.id, retention_id: retention.id, status, reason });
    return retention;
  }

  /** Retry archival of exact historical objects; this never advances a canonical branch. */
  async retainRevision(id, input, actor) {
    return this.request('revision.retain', { revision_id: id, request_id: input.request_id }, actor, async () => {
      const revision = this.revision(id);
      const retentions = [];
      for (const head of revision.repository_heads)
        retentions.push(await this.retainRef({ id: head.source_repo_id, canonical_repo: head.repo_id },
          { object_id: head.object_id ?? head.commit, commit: head.commit }, actor, true));
      const future = this.future(revision.future_id);
      if (future.current_revision_id === id)
        for (let index = 0; index < future.repositories.length; index++)
          future.repositories[index].retention_state = retentions[index].status;
      return { revision_id: id, retentions };
    });
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
    const safeRetry = [
      'repository.refresh',
      'future.observe',
      'revision.retain',
      'repository.recover',
      'selection.create',
      'candidate.create',
      'candidate.validate',
    ].includes(operation);
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
      const uncertain = request.effects.some((effect) => effect.dispatch_state !== 'not_started');
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
    repositoryDescription(input.description);
    const effect = {
      method,
      input: structuredClone(input),
      status: 'prepared',
      dispatch_state: 'not_started',
    };
    request.effects.push(effect);
    await this.save();
    // Persist dispatch before the call. Remote absence cannot rule out an
    // in-flight operation after this point, including a lost response.
    effect.dispatch_state = 'issued';
    await this.save();
    let info;
    try {
      info = await invoke({ ...input, operation_id: request.id });
    } catch (error) {
      if (error instanceof RepositoryPreflightError) {
        effect.dispatch_state = 'not_started';
        effect.status = 'rejected';
        await this.save();
      }
      throw error;
    }
    effect.result = structuredClone(info);
    effect.status = 'observed';
    await this.save();
    return info;
  }

  async registerObserved(info, id, ref, description = '') {
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
      if (canonical) {
        // Reconcile from the previous head before a native projection hides the transition.
        await this.engine.observeCanonical(canonical, observed.head, observed.tree);
        Object.assign(canonical, observed, {
          baseline: canonical.baseline ?? observed.head,
        });
      } else
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
    if (value.source?.branch && value.source.branch !== value.ref.slice(11))
      throw new DomainError(
        'IMPORT_REF_MISMATCH',
        'Import branch must match the requested repository ref',
        422,
      );
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
      const repository = await this.registerObserved(info, value.id, value.ref, value.description);
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
        const observed = await this.registerObserved(
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
      ...(input.context_snapshot_id === undefined ? {} : { context_snapshot_id: input.context_snapshot_id === null ? null : bounded(input.context_snapshot_id, 'Context snapshot', 200) }),
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
      const context = this.engine.objectiveContext
        ? await this.engine.objectiveContext.bindFuture(objective, value.context_snapshot_id ?? null)
        : { context_snapshot: null, context_binding_state: 'unknown', context_assumption_refs: [] };
      if (!this.engine.objectiveContext && value.context_snapshot_id)
        throw new DomainError('CONTEXT_UNAVAILABLE', 'Objective context is unavailable', 503);
      const future = {
        ...context,
        context_snapshot_id: context.context_snapshot ?? null,
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
    let refs;
    if (input.repository_refs !== undefined) {
      if (!Array.isArray(input.repository_refs) || !input.repository_refs.length || input.repository_refs.length > 100)
        throw new DomainError('INVALID_NATIVE_INPUT', 'Choose 1 to 100 repository refs');
      refs = input.repository_refs.map((entry) => ({
        repo_id: bounded(entry?.repo_id, 'Isolated repository identity', 100),
        ref: observationRef(entry?.ref),
      }));
      if (new Set(refs.map((entry) => entry.repo_id)).size !== refs.length)
        throw new DomainError('INVALID_NATIVE_INPUT', 'Choose one ref per isolated repository');
      refs.sort((a, b) => a.repo_id.localeCompare(b.repo_id));
    }
    const value = { id, expected_version: input.expected_version, request_id: input.request_id,
      ...(refs ? { repository_refs: refs } : {}),
      ...(input.context_snapshot_id === undefined ? {} : { context_snapshot_id: input.context_snapshot_id === null ? null : bounded(input.context_snapshot_id, 'Context snapshot', 200) }),
    };
    return this.request('future.observe', value, actor, async () => {
      const future = this.future(id);
      if (value.expected_version !== future.version)
        throw new DomainError('FUTURE_STALE', 'The Future changed before observation', 409);
      if (refs?.some((entry) => !future.repositories.some((repo) => repo.repo_id === entry.repo_id)))
        throw new DomainError('INVALID_NATIVE_INPUT', 'Selected refs must belong to this Future');
      if (future.status === 'abandoned')
        throw new DomainError('FUTURE_ABANDONED', 'This Future is abandoned', 409);
      if (future.status === 'recovery_required')
        throw new DomainError('RECOVERY_REQUIRED', 'Reconcile repository creation first', 409);
      if (future.status === 'preparing') {
        for (const repository of future.repositories) {
          if (repository.status === 'ready') continue;
          const info = await this.provider('repositoryInfo')({
            id: repository.repo_id,
            canonical_repo: repository.canonical_repo_id,
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
          throw new DomainError('FUTURE_NOT_READY', 'Isolated repositories are still being provisioned', 409);
      }
      let context = null;
      if (value.context_snapshot_id !== undefined) {
        if (!this.engine.objectiveContext && value.context_snapshot_id)
          throw new DomainError('CONTEXT_UNAVAILABLE', 'Objective context is unavailable', 503);
        context = this.engine.objectiveContext
          ? await this.engine.objectiveContext.bindFuture(this.objective(future.objective_id), value.context_snapshot_id)
          : { context_snapshot: null, context_binding_state: 'unknown', context_assumption_refs: [] };
      }
      const previous = future.current_revision_id;
      const revision = await this.observe(future, actor, refs, context);
      return { future, revision, changed: previous !== revision?.id, unavailable: future.status === 'unavailable' };
    });
  }

  async observe(future, actor, refs = [], context = null) {
    const selected = future.repositories.map((repository) => ({
      ...repository, ref: refs?.find((entry) => entry.repo_id === repository.repo_id)?.ref ?? repository.ref,
    }));
    const repository_heads = [], tree_hashes = [], affected_scope = [], observed = [];
    let unavailable = false;
    for (const repository of selected) {
      const baseline = future.baseline_refs.find((entry) => entry.repo_id === repository.canonical_repo_id);
      const descriptor = { id: repository.repo_id, canonical_repo: repository.canonical_repo_id, canonical_ref: repository.ref };
      let value;
      try {
        value = await this.readRef(descriptor, repository.ref);
      } catch (error) {
        if (error.code !== 'REF_NOT_FOUND') throw error;
        value = null;
      }
      observed.push({ repository, value });
      if (!value?.available_for_future) {
        unavailable = true;
        repository.status = 'unavailable';
        continue;
      }
      const facts = await this.engine.git.facts(descriptor, value.commit, baseline.commit);
      if (facts.head !== value.commit || !objectId.test(facts.tree) || !Array.isArray(facts.scope))
        throw new DomainError('INVALID_GIT_FACTS', 'Git did not establish an immutable Future state', 503);
      repository_heads.push({ repo_id: repository.canonical_repo_id, source_repo_id: repository.repo_id,
        ref: repository.ref, commit: value.commit, object_id: value.object_id, object_type: value.object_type });
      tree_hashes.push({ repo_id: repository.canonical_repo_id, tree: facts.tree });
      affected_scope.push({ repo_id: repository.canonical_repo_id, paths: [...new Set(facts.scope)].sort() });
      repository.status = 'ready';
    }
    // Both tag objects and peeled commits are pinned. Event time cannot establish freshness.
    for (const entry of observed) {
      let current;
      try {
        current = await this.readRef({ id: entry.repository.repo_id, canonical_repo: entry.repository.canonical_repo_id }, entry.repository.ref);
      } catch (error) {
        if (error.code !== 'REF_NOT_FOUND') throw error;
        current = null;
      }
      if (await hash(current) !== await hash(entry.value))
        throw new DomainError('FUTURE_CHANGED', 'Future refs moved during observation', 409);
    }
    const previous = future.current_revision_id ? this.revision(future.current_revision_id) : null;
    const changedRefs = selected.some((entry, index) => entry.ref !== future.repositories[index].ref);
    for (const entry of observed) await this.rememberRef(entry.repository.repo_id, entry.repository.ref, entry.value, actor);
    selected.forEach((entry, index) => Object.assign(future.repositories[index], { ref: entry.ref, status: entry.status }));
    if (context) Object.assign(future, context, { context_snapshot_id: context.context_snapshot ?? null });
    if (unavailable) {
      if (future.status !== 'unavailable' || changedRefs) future.version++;
      future.status = 'unavailable';
      return previous;
    }
    const contextFields = {
      context_snapshot: future.context_snapshot ?? null,
      context_snapshot_id: future.context_snapshot_id ?? future.context_snapshot ?? null,
      context_binding_state: future.context_binding_state ?? 'unknown',
      context_assumption_refs: future.context_assumption_refs ?? [],
    };
    if (previous && await hash(previous.repository_heads) === await hash(repository_heads) &&
        (previous.context_snapshot ?? null) === contextFields.context_snapshot &&
        await hash(previous.context_assumption_refs ?? []) === await hash(contextFields.context_assumption_refs)) {
      if (future.status !== 'active') { future.status = 'active'; future.version++; }
      return previous;
    }
    const retentions = [];
    for (const entry of observed) {
      const retention = await this.retainRef({ id: entry.repository.repo_id, canonical_repo: entry.repository.canonical_repo_id }, entry.value, actor);
      retentions.push(retention.id);
      future.repositories.find((repo) => repo.repo_id === entry.repository.repo_id).retention_state = retention.status;
    }
    const data = {
      retention_ids: retentions,
      future_id: future.id, previous_revision_id: previous?.id ?? null, repository_heads, tree_hashes,
      baseline_refs: future.baseline_refs, affected_scope, producer: future.producer,
      ...contextFields, provenance_state: future.provenance_state,
    };
    // The predecessor distinguishes rewinds; observation time is metadata, not identity.
    const revision = await record('future_revision', {
      ...data, id: 'future_revision_' + await hash(data), created_at: now(),
    });
    this.state.futureRevisions.push(revision);
    future.current_revision_id = revision.id;
    future.status = 'active';
    future.version++;
    await this.event('future.revised', actor, {
      future_id: future.id, revision_id: revision.id, previous_revision_id: previous?.id ?? null,
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
        const readOnly = ['repository.refresh', 'future.observe', 'repository.recover'].includes(
          original.operation,
        );
        const repositoryMutation = ['repository.register', 'future.create'].includes(
          original.operation,
        );
        if (
          (!original.effects.length && readOnly) ||
          (repositoryMutation &&
            original.effects.every((effect) => effect.dispatch_state === 'not_started'))
        ) {
          // All repository writes pass through effect(), including fork creation.
          // An empty journal proves no Git mutation, even if metadata is partial.
          original.status = 'failed';
          original.error = {
            code: readOnly ? 'READ_NOT_COMPLETED' : 'NO_REPOSITORY_EFFECT',
            message: readOnly
              ? 'The observation was interrupted; retry using current state'
              : 'No repository mutation was issued; submit a new request',
            status: 409,
          };
          if (original.future_id && this.future(original.future_id).status !== 'abandoned')
            this.future(original.future_id).status = 'failed';
          await this.event('native.request.reconciled', actor, {
            request_id: original.id,
            outcome: 'no_repository_effect',
          });
          return {
            request: { id: original.id, status: 'failed', retryable: true },
            outcome: 'no_repository_effect',
          };
        }
        if (!original.effects.length)
          throw new DomainError(
            'RECOVERY_REQUIRED',
            'No authoritative repository effect identifies this operation',
            409,
          );
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
          const repository = await this.registerObserved(
            info,
            value.id,
            value.ref,
            value.description,
          );
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

  /** Push payloads are hints; exact authoritative reads gate every durable observation. */
  async observeRepositoryPush(event, actor) {
    actorIdentity(actor);
    if (!event || typeof event !== 'object')
      throw new DomainError('INVALID_EVENT', 'A Git push is required');
    const id = event.source_repo ?? event.repo;
    const future = this.state.futures.find((item) => item.repositories.some((repo) => repo.repo_id === id));
    const repository = this.repositories().find((repo) => repo.id === id);
    const nativeCanonical = this.state.nativeRepositories.some((repo) => repo.id === id);
    if (!future && (!repository || !nativeCanonical)) return { handled: false };
    const binding = future?.repositories.find((repo) => repo.repo_id === id);
    const selectedRef = binding?.ref ?? repository.canonical_ref;
    if (typeof event.ref !== 'string' || !event.ref.startsWith('refs/') || event.ref.length > 255 ||
        typeof event.after !== 'string' || !objectId.test(event.after) ||
        (event.before !== undefined && event.before !== null &&
          (typeof event.before !== 'string' || !objectId.test(event.before))))
      throw new DomainError('INVALID_EVENT', 'Git push requires bounded refs and immutable before/after object IDs');
    if (future?.status === 'abandoned')
      return { handled: true, ignored: true, reason: 'FUTURE_ABANDONED' };
    if (!/^refs\/(heads|tags)\//.test(event.ref))
      return future ? { handled: true, ignored: true, reason: 'INTERNAL_REF' } : { handled: false };
    try { observationRef(event.ref); } catch {
      throw new DomainError('INVALID_EVENT', 'Push ref is not a valid branch or tag');
    }
    // Canonical work branches still enter the compatibility ingestion path.
    if (!future && event.ref !== selectedRef && event.ref.startsWith('refs/heads/'))
      return { handled: false };
    let observed;
    try {
      observed = await this.readRef({ id, ...(binding ? { canonical_repo: binding.canonical_repo_id } : {}) }, event.ref);
    } catch (error) {
      if (error.code !== 'REF_NOT_FOUND') throw error;
      observed = null;
    }
    const deleted = /^0{40,64}$/.test(event.after);
    if ((observed ? observed.object_id !== event.after : !deleted))
      return { handled: true, ignored: true, reason: 'OUT_OF_ORDER_EVENT', head: observed?.commit ?? null };
    if (event.ref !== selectedRef) {
      const previous = this.state.nativeRefStates[id + ':' + event.ref];
      const observation = await this.rememberRef(id, event.ref, observed, actor);
      await this.save();
      return { handled: true, ignored: true, reason: 'UNTRACKED_REF', duplicate: previous === observation.id,
        observation_id: observation.id, deleted, available_for_future: observed?.available_for_future ?? false };
    }
    if (future) {
      if (future.status === 'recovery_required') return { handled: true, reason: 'RECOVERY_REQUIRED' };
      if (future.status === 'preparing') return { handled: true, reason: 'FUTURE_NOT_READY' };
      const before = future.current_revision_id;
      const version = future.version;
      const revision = await this.observe(future, actor);
      await this.save();
      return { handled: true, future_id: future.id, revision_id: revision?.id ?? null,
        duplicate: revision?.id === before && future.version === version,
        ...(deleted ? { deleted: true } : {}),
        ...(future.status === 'unavailable' ? { unavailable: true } : {}) };
    }
    if (!observed) {
      const native = this.state.nativeRepositories.find((repo) => repo.id === id);
      if (native?.status === 'unavailable')
        return { handled: true, deleted: true, duplicate: true };
      await this.rememberRef(id, event.ref, null, actor);
      if (native) native.status = 'unavailable';
      const canonical = this.state.repositories.find((repo) => repo.id === id);
      if (canonical) canonical.unavailable = true;
      await this.event('repository.ref_unavailable', actor, { repo: id, ref: event.ref, previous: event.before ?? null });
      await this.save();
      return { handled: true, deleted: true };
    }
    const info = await this.provider('repositoryInfo')({ id, ref: selectedRef });
    providerInfo(info, id, selectedRef);
    if (info.status !== 'ready' || info.commit !== observed.commit)
      return { handled: true, ignored: true, reason: 'OUT_OF_ORDER_EVENT', head: info.status === 'ready' ? info.commit : null };
    if (repository.status === 'ready' && repository.head === info.commit && repository.tree === info.tree)
      return { handled: true, canonical: true, duplicate: true, repository: structuredClone(repository) };
    await this.rememberRef(id, event.ref, observed, actor);
    const result = await this.registerObserved(info, id, selectedRef, repository.description);
    await this.event('canonical.changed', actor, { repo: id, head: result.head, tree: result.tree });
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
      refObservations: this.state.nativeRefObservations,
      retentions: this.state.nativeRetentions,
      repositories,
      requests: this.state.nativeRequests.map(
        ({ input: _input, effects: _effects, result: _result, ...request }) => request,
      ),
      attention: { kind: recovery.length ? 'recovery' : 'nothing', count: recovery.length },
    });
  }
}
