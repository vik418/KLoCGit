import { DomainError, record } from './hash.mjs';

export const ACCESS_ROLES = Object.freeze([
  'reader',
  'producer',
  'reviewer',
  'maintainer',
  'admin',
]);
export const DEFAULT_ACCESS_LIMITS = Object.freeze({
  members: 200,
  grants: 1000,
  repositories: 100,
  pending_runs: 100,
  request_bytes: 1_000_000,
});
const rolePermissions = {
  reader: ['read'],
  producer: ['read', 'produce'],
  reviewer: ['read', 'review'],
  maintainer: ['read', 'produce', 'review', 'maintain'],
  admin: ['read', 'produce', 'review', 'maintain', 'admin'],
};
const operations = Object.freeze({
  'workspace.read': 'read',
  'repository.read': 'read',
  'repository.create': 'maintain',
  'repository.update': 'maintain',
  'repository.fork': 'produce',
  'proposal.create': 'produce',
  'task.prepare': 'produce',
  'task.resolve': 'produce',
  'mr.create': 'produce',
  'mr.update': 'produce',
  'review.write': 'review',
  'review.dismiss': 'maintain',
  'policy.write': 'admin',
  'validation.run': 'produce',
  'decision.prepare': 'review',
  'decision.resolve': 'maintain',
  'queue.enqueue': 'maintain',
  'queue.process': 'maintain',
  'analysis.run': 'review',
  'recovery.run': 'admin',
  'audit.read': 'maintain',
  'export.read': 'maintain',
  'access.manage': 'admin',
  'ingress.write': 'produce',
});
const globalOperations = new Set(['repository.create', 'recovery.run']);
const internalOperations = new Set([
  'ingress.write',
  'analysis.run',
  'queue.process',
  'recovery.run',
]);

function actorId(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new DomainError('UNAUTHENTICATED', 'A trusted actor identity is required', 401);
  return value;
}
function trusted(principal) {
  actorId(principal?.actor_id);
  if (
    !['human', 'service', 'internal'].includes(principal.kind) ||
    (principal.kind === 'human' && !['owner-token', 'oidc'].includes(principal.auth_method)) ||
    (principal.kind === 'service' &&
      !(
        (principal.auth_method === 'ingest-token' && principal.actor_id === 'git-ingress') ||
        (principal.auth_method === 'evaluator-hmac' && principal.actor_id.startsWith('evaluator:'))
      )) ||
    (principal.kind === 'internal' &&
      (principal.auth_method !== 'internal' ||
        !['coordinator', 'merge-queue-coordinator', 'artifacts-ingress'].includes(
          principal.actor_id,
        )))
  )
    throw new DomainError('UNAUTHENTICATED', 'A trusted principal is required', 401);
  return principal;
}
function permissionSet(roles) {
  return new Set(roles.flatMap((role) => rolePermissions[role] ?? []));
}
function validRoles(roles) {
  if (
    !Array.isArray(roles) ||
    roles.length > ACCESS_ROLES.length ||
    roles.some((role) => !ACCESS_ROLES.includes(role)) ||
    new Set(roles).size !== roles.length
  )
    throw new DomainError('INVALID_ACCESS_POLICY', 'Roles must be a unique list of known roles');
  return [...roles].sort();
}
function quotaLimits(input, prior) {
  if (input === undefined) return { ...prior };
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new DomainError('INVALID_ACCESS_POLICY', 'Limits must be an object');
  const limits = { ...prior };
  for (const [name, value] of Object.entries(input)) {
    if (
      !Object.hasOwn(DEFAULT_ACCESS_LIMITS, name) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > DEFAULT_ACCESS_LIMITS[name]
    )
      throw new DomainError(
        'INVALID_ACCESS_POLICY',
        'Limits must stay within the published maximums',
      );
    limits[name] = value;
  }
  return limits;
}

/** Redact credential fields and credentials embedded in URLs; retain audit originals. */
export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /secret|password|credential|authorization|cookie|(^|_)token($|_)|(^|_)(api_key|private_key|signing_key)($|_)|prompt|private.?context/i.test(
          key,
        )
          ? '[redacted]'
          : redactSensitive(item),
      ]),
    );
  }
  if (typeof value !== 'string') return value;
  if (/^Bearer\s/i.test(value) || /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
    return '[redacted]';
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol)) return value;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()])
      if (/secret|token|password|credential|auth|signature|key/i.test(key))
        url.searchParams.delete(key);
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Repository authorization over persisted metadata. Call mutations within
 * Engine.serial(). Principals must come from a transport's authentication
 * boundary, never JSON input. No code or evidence records are deleted by quotas.
 */
export class AccessControl {
  constructor(engine) {
    this.engine = engine;
  }

  get state() {
    if (this.engine.accessPersistenceFailed)
      throw new DomainError(
        'ACCESS_POLICY_UNAVAILABLE',
        'Reload durable metadata before accepting further authorized requests',
        503,
      );
    const owner = actorId(this.engine.state.workspace.owner_id);
    const policy = this.engine.state.access;
    if (policy && (policy.schema_version !== 1 || policy.owner_id !== owner))
      throw new DomainError(
        'ACCESS_POLICY_UNAVAILABLE',
        'Owner identity or policy schema changed; reconcile explicitly',
        503,
      );
    return (
      policy ?? {
        schema_version: 1,
        version: 0,
        owner_id: owner,
        members: [],
        grants: [],
        limits: { ...DEFAULT_ACCESS_LIMITS },
        version_id: null,
      }
    );
  }

  repositoryIds() {
    return [
      ...new Set([
        ...(this.engine.state.repositories ?? []).map((repo) => repo.id),
        ...(this.engine.state.nativeRepositories ?? []).map((repo) => repo.id),
      ]),
    ];
  }

  roles(principal, repoId = null) {
    trusted(principal);
    if (principal.kind !== 'human') return [];
    if (principal.actor_id === this.state.owner_id) return ['admin'];
    return [
      ...new Set(
        this.state.grants
          .filter(
            (grant) =>
              grant.actor_id === principal.actor_id &&
              (grant.repo_id === null || grant.repo_id === repoId),
          )
          .flatMap((grant) => grant.roles),
      ),
    ].sort();
  }

  isWorkspaceAdmin(principal) {
    return permissionSet(this.roles(principal)).has('admin');
  }

  visibleRepositories(principal) {
    trusted(principal);
    return this.repositoryIds().filter((id) =>
      permissionSet(this.roles(principal, id)).has('read'),
    );
  }

  require(principal, operation, repoIds = []) {
    trusted(principal);
    if (this.engine.accessPersistenceFailed)
      throw new DomainError(
        'ACCESS_POLICY_UNAVAILABLE',
        'Reload durable metadata before accepting further authorized requests',
        503,
      );
    const permission = operations[operation];
    if (!permission)
      throw new DomainError('FORBIDDEN', 'The operation has no authorization policy', 403);
    if (!Array.isArray(repoIds) || repoIds.some((id) => typeof id !== 'string' || !id))
      throw new DomainError('INVALID_RESOURCE_SCOPE', 'Supply explicit repository identities');
    const repos = [...new Set(repoIds)];
    if (principal.kind === 'internal') {
      if (!internalOperations.has(operation))
        throw new DomainError('FORBIDDEN', 'Internal workers cannot perform this operation', 403);
      return principal.actor_id;
    }
    if (principal.kind === 'service') {
      if (
        operation !== 'ingress.write' ||
        principal.auth_method !== 'ingest-token' ||
        !repos.length
      )
        throw new DomainError(
          'FORBIDDEN',
          'Ingress credentials cannot authorize user operations',
          403,
        );
    } else if (operation === 'workspace.read') {
      const member =
        principal.actor_id === this.state.owner_id ||
        this.state.members.some((member) => member.actor_id === principal.actor_id);
      if (!member) throw new DomainError('FORBIDDEN', 'Workspace membership is required', 403);
      return principal.actor_id;
    } else if (!repos.length || globalOperations.has(operation)) {
      if (!permissionSet(this.roles(principal)).has(permission))
        throw new DomainError('FORBIDDEN', 'A workspace role is required for this operation', 403);
      return principal.actor_id;
    }
    for (const id of repos) {
      if (principal.kind === 'human' && !permissionSet(this.roles(principal, id)).has(permission))
        throw new DomainError(
          'FORBIDDEN',
          'The repository role does not allow this operation',
          403,
        );
      if (!this.repositoryIds().includes(id))
        throw new DomainError('REPO_NOT_FOUND', 'Repository not found', 404);
    }
    return principal.actor_id;
  }

  session(principal) {
    trusted(principal);
    const state = this.state;
    return {
      actor_id: principal.actor_id,
      kind: principal.kind,
      auth_method: principal.auth_method,
      member:
        principal.kind === 'human' &&
        (principal.actor_id === state.owner_id ||
          state.members.some((member) => member.actor_id === principal.actor_id)),
      workspace_roles: this.roles(principal),
      repository_roles: this.visibleRepositories(principal).map((repo_id) => ({
        repo_id,
        roles: this.roles(principal, repo_id),
      })),
      access_version: state.version,
    };
  }

  policy(principal, repoId = null) {
    this.require(principal, 'access.manage', repoId === null ? [] : [repoId]);
    const state = structuredClone(this.state);
    if (repoId === null) return state;
    return {
      schema_version: state.schema_version,
      version: state.version,
      version_id: state.version_id,
      repo_id: repoId,
      grants: state.grants.filter((grant) => grant.repo_id === repoId),
    };
  }

  assertQuota(name, count, additional = 1) {
    const maximum = this.state.limits[name];
    if (
      !Number.isSafeInteger(maximum) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(additional) ||
      additional < 0
    )
      throw new DomainError(
        'INVALID_QUOTA',
        'Quota accounting requires nonnegative bounded counts',
      );
    if (count + additional > maximum)
      throw new DomainError(
        'WORKSPACE_QUOTA_EXCEEDED',
        'The workspace limit has been reached',
        429,
        {
          quota: name,
          limit: maximum,
        },
      );
  }

  async update(input, principal) {
    trusted(principal);
    if (principal.kind !== 'human')
      throw new DomainError(
        'FORBIDDEN',
        'Only individually granted principals can change membership',
        403,
      );
    const prior = this.state;
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !Array.isArray(input.changes) ||
      input.changes.length > 100 ||
      (!input.changes.length && input.limits === undefined)
    )
      throw new DomainError(
        'INVALID_ACCESS_POLICY',
        'Supply up to 100 grant changes or a limits update',
      );
    if (input.expected_version !== prior.version)
      throw new DomainError(
        'ACCESS_POLICY_STALE',
        'Membership changed; review the current policy',
        409,
        {
          current_version: prior.version,
        },
      );
    if (input.limits !== undefined) this.require(principal, 'access.manage');
    const limits = quotaLimits(input.limits, prior.limits);
    const grants = structuredClone(prior.grants);
    const changes = [];
    const seen = new Set();
    for (const change of input.changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change))
        throw new DomainError('INVALID_ACCESS_POLICY', 'Each grant change must be an object');
      const target = actorId(change.actor_id);
      const repoId = change.repo_id ?? null;
      this.require(principal, 'access.manage', repoId === null ? [] : [repoId]);
      if (target === prior.owner_id)
        throw new DomainError(
          'OWNER_ROLE_IMMUTABLE',
          'The bootstrap owner cannot be changed through grants',
          409,
        );
      const roles = validRoles(change.roles);
      const key = JSON.stringify([target, repoId]);
      if (seen.has(key))
        throw new DomainError(
          'INVALID_ACCESS_POLICY',
          'A grant scope can change only once per update',
        );
      seen.add(key);
      if (target === principal.actor_id) {
        const oldPermissions = permissionSet(this.roles(principal, repoId));
        if ([...permissionSet(roles)].some((permission) => !oldPermissions.has(permission)))
          throw new DomainError(
            'SELF_ESCALATION',
            'An actor cannot grant themselves new privileges',
            403,
          );
      }
      const index = grants.findIndex(
        (grant) => grant.actor_id === target && grant.repo_id === repoId,
      );
      const before = index < 0 ? [] : grants[index].roles;
      if (index >= 0) grants.splice(index, 1);
      if (roles.length) grants.push({ actor_id: target, repo_id: repoId, roles });
      if (JSON.stringify(before) !== JSON.stringify(roles))
        changes.push({ actor_id: target, repo_id: repoId, before, after: roles });
    }
    grants.sort((a, b) => {
      const left = JSON.stringify([a.actor_id, a.repo_id]);
      const right = JSON.stringify([b.actor_id, b.repo_id]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const memberIds = [...new Set(grants.map((grant) => grant.actor_id))].sort();
    if (memberIds.length + 1 > limits.members || grants.length > limits.grants)
      throw new DomainError(
        'WORKSPACE_QUOTA_EXCEEDED',
        'Membership or grant quota would be exceeded',
        429,
      );
    if (!changes.length && JSON.stringify(limits) === JSON.stringify(prior.limits))
      return structuredClone(prior);
    const createdAt = new Date().toISOString();
    const version = await record('access', {
      schema_version: 1,
      version: prior.version + 1,
      owner_id: prior.owner_id,
      grants,
      limits,
      previous: prior.version_id,
      actor: principal.actor_id,
      created_at: createdAt,
    });
    const next = {
      schema_version: 1,
      version: version.version,
      version_id: version.id,
      owner_id: prior.owner_id,
      grants,
      limits,
      members: memberIds.map((actor_id) => ({
        actor_id,
        created_at:
          prior.members.find((member) => member.actor_id === actor_id)?.created_at ?? createdAt,
      })),
    };
    // Roll back in-memory metadata if persistence fails; the transport must
    // report failure, and a later request must reload durable state on crash.
    const previousVersions = this.engine.state.accessVersions;
    const auditLength = this.engine.state.audit.length;
    const previousPolicy = this.engine.state.access;
    try {
      this.engine.state.accessVersions = [...(previousVersions ?? []), version];
      this.engine.state.access = next;
      for (const change of changes) {
        const removed = change.before.filter((role) => !change.after.includes(role));
        const added = change.after.filter((role) => !change.before.includes(role));
        if (removed.length)
          await this.engine.audit('access.revoked', principal.actor_id, {
            ...change,
            roles: removed,
            policy_version: version.id,
          });
        if (added.length)
          await this.engine.audit('access.granted', principal.actor_id, {
            ...change,
            roles: added,
            policy_version: version.id,
          });
      }
      if (JSON.stringify(limits) !== JSON.stringify(prior.limits))
        await this.engine.audit('access.limits-updated', principal.actor_id, {
          before: prior.limits,
          after: limits,
          policy_version: version.id,
        });
      await this.engine.save(this.engine.state);
      return structuredClone(next);
    } catch (error) {
      this.engine.state.access = previousPolicy;
      this.engine.state.accessVersions = previousVersions;
      this.engine.state.audit.splice(auditLength);
      // A storage error may leave the durable result uncertain. Do not continue
      // authorizing from the rollback projection; reload/restart the coordinator.
      this.engine.accessPersistenceFailed = true;
      throw error;
    }
  }

  canonicalRepository(id) {
    const fork = (this.engine.state.forks ?? []).find((entry) => entry.id === id);
    if (fork) return fork.repo;
    for (const future of this.engine.state.futures ?? []) {
      const binding = (future.repositories ?? []).find((entry) => entry.repo_id === id);
      if (binding) return binding.canonical_repo_id;
    }
    return id;
  }

  /** Scope comes from persisted objects, never a producer-supplied authorization label. */
  resourceRepositories(value, visited = new Set(), index = null) {
    index ??= new Map();
    if (!index.size) {
      for (const collection of Object.values(this.engine.state)) {
        if (!Array.isArray(collection)) continue;
        for (const item of collection) {
          const id = item?.id ?? item?.task?.id;
          if (typeof id === 'string') index.set(id, [...(index.get(id) ?? []), item]);
        }
      }
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return [];
    visited.add(value);
    const found = new Set();
    const referenced = [];
    const collect = (item) => {
      if (!item || typeof item !== 'object') return;
      if (Array.isArray(item)) {
        item.forEach(collect);
        return;
      }
      for (const [key, child] of Object.entries(item)) {
        if (
          [
            'repo',
            'repo_id',
            'canonical_repo',
            'canonical_repo_id',
            'target_repo',
            'source_repo',
            'source_repo_id',
          ].includes(key) &&
          typeof child === 'string' &&
          child
        )
          found.add(this.canonicalRepository(child));
        if (['repository_ids', 'repo_ids'].includes(key) && Array.isArray(child))
          child
            .filter((id) => typeof id === 'string')
            .forEach((id) => found.add(this.canonicalRepository(id)));
        if (
          [
            'canonical_heads',
            'dependency_heads',
            'validity_heads',
            'evaluation_heads',
            'base_heads',
            'expected_heads',
          ].includes(key) &&
          child &&
          typeof child === 'object' &&
          !Array.isArray(child)
        )
          Object.keys(child).forEach((id) => found.add(this.canonicalRepository(id)));
        if (typeof child === 'string' && index.has(child)) referenced.push({ key, id: child });
        if (Array.isArray(child))
          for (const id of child)
            if (typeof id === 'string' && index.has(id)) referenced.push({ key, id });
        if (child && typeof child === 'object') collect(child);
      }
    };
    if (typeof value.id === 'string') {
      const canonical = this.canonicalRepository(value.id);
      if (this.repositoryIds().includes(canonical)) found.add(canonical);
    }
    collect(value);
    // A code record can pin context or evidence in another repository. Finding
    // its direct code scope must not stop authorization of those immutable inputs.
    const follow = referenced.filter(
      ({ key }) =>
        key === 'id' ||
        /^(from|to|dependency|selection)(_|$)/.test(key) ||
        /(?:_id|_ids|_ref|_refs|_snapshot|_version)$/.test(key) ||
        ['context_snapshot', 'context_version'].includes(key),
    );
    for (const { id } of follow)
      for (const item of index.get(id) ?? [])
        this.resourceRepositories(item, visited, index).forEach((repo) => found.add(repo));
    return [...found].sort();
  }

  readable(principal, value) {
    const repos = this.resourceRepositories(value);
    if (!repos.length) return false;
    try {
      this.require(principal, 'repository.read', repos);
      return true;
    } catch {
      return false;
    }
  }

  /** Conservative read projection: unscoped records never escape a restricted view. */
  project(view, principal) {
    this.require(principal, 'workspace.read');
    const output = redactSensitive(view);
    const globalReader = permissionSet(this.roles(principal)).has('read');
    if (globalReader) {
      output.visibility = { scope: 'workspace' };
      output.audit = this.redactAudit(principal, view.audit ?? []);
      if (!this.isWorkspaceAdmin(principal)) {
        delete output.access;
        delete output.accessVersions;
      }
      return output;
    }
    const projectContainer = (container) => {
      const result = {};
      for (const [key, items] of Object.entries(container ?? {})) {
        if (Array.isArray(items))
          result[key] = items.filter((item) => this.readable(principal, item)).map(redactSensitive);
        else if (key === 'context' || key === 'evaluators' || key === 'discovery')
          result[key] = projectContainer(items);
      }
      return result;
    };
    const result = projectContainer(view);
    result.version = view.version;
    result.workspace = {
      id: view.workspace.id,
      name: view.workspace.name,
      mode: view.workspace.mode,
      description: view.workspace.description,
      producers: [],
    };
    result.nativeState = projectContainer(view.nativeState);
    const nativeRevisionIds = new Set(
      (result.nativeState.futureRevisions ?? []).map((entry) => entry.id),
    );
    const nativeDiscovery = view.nativeState?.discovery;
    if (nativeDiscovery) {
      const visibleIds = (key) =>
        (nativeDiscovery[key] ?? []).filter((id) => nativeRevisionIds.has(id));
      const groups = (result.nativeState.decisionGroups ?? []).filter(
        (group) => group.status === 'open',
      );
      const ungrouped = visibleIds('ungrouped_revision_ids');
      const candidateIds = new Set((result.nativeState.candidates ?? []).map((entry) => entry.id));
      result.nativeState.discovery = {
        analysis_candidate_ids: (nativeDiscovery.analysis_candidate_ids ?? []).filter((id) =>
          candidateIds.has(id),
        ),
        ungrouped_revision_ids: ungrouped,
        unknown_revision_ids: visibleIds('unknown_revision_ids'),
        classified_revision_ids: visibleIds('classified_revision_ids'),
        blocking_decision_count: groups.length,
        conventional_review_count: ungrouped.length,
        human_attention_count: groups.length + ungrouped.length,
        comparisons: null,
        possible_comparisons: null,
        comparisons_avoided: null,
        validation_runs: null,
        compositions: null,
        diagnostics: [],
      };
    }
    result.nativeState.attention = {
      kind: (result.nativeState.requests ?? []).some((request) =>
        ['prepared', 'recovery_required'].includes(request.status),
      )
        ? 'recovery'
        : 'nothing',
      count: (result.nativeState.requests ?? []).filter((request) =>
        ['prepared', 'recovery_required'].includes(request.status),
      ).length,
    };
    result.visibility = {
      scope: 'repositories',
      repository_ids: this.visibleRepositories(principal),
    };
    result.workspace.producers = [
      ...new Set(
        (result.proposals ?? [])
          .map((proposal) => proposal.producer)
          .filter((producer) => typeof producer === 'string'),
      ),
    ];
    result.audit = this.redactAudit(principal, view.audit ?? []);
    delete result.access;
    delete result.accessVersions;
    const revisions = result.revisions ?? [];
    const activeIds = new Set(
      revisions.filter((revision) => !revision.stale).map((revision) => revision.id),
    );
    const components = result.decisionComponents ?? [];
    const open = components.filter((component) => component.actionable);
    result.discovery = {
      ungrouped_revision_ids: (view.discovery?.ungrouped_revision_ids ?? []).filter((id) =>
        activeIds.has(id),
      ),
      conventional_review_ids: (view.discovery?.conventional_review_ids ?? []).filter((id) =>
        activeIds.has(id),
      ),
      diagnostics: [],
    };
    const settled = new Set((result.dispositions ?? []).map((entry) => entry.revision_id));
    const covered = new Set(
      open.flatMap((component) => [
        ...(component.revision_ids ?? []),
        ...(component.supplemental_revision_ids ?? []),
      ]),
    );
    const conventionalIds = new Set(result.discovery.conventional_review_ids);
    for (const id of activeIds)
      if (!settled.has(id) && !covered.has(id) && (this.engine.mr?.analysisEligible?.(id) ?? true))
        conventionalIds.add(id);
    result.discovery.conventional_review_ids = [...conventionalIds];
    const conventional = conventionalIds.size;
    result.summary = {
      proposals: activeIds.size,
      decisionsRequired: open.length + conventional,
      contextAnswersRecorded: (result.tasks ?? []).filter(
        (task) => task.question && task.authorization,
      ).length,
      pendingClarifications: (result.tasks ?? []).filter(
        (task) => task.question && !task.authorization,
      ).length,
      initialDecisions: components.length,
      graphDecisions: components.length,
      conventionalReview: conventional,
      compressionRatio: activeIds.size ? (components.length + conventional) / activeIds.size : 0,
      independentWork: result.discovery.ungrouped_revision_ids.length,
      comparisonsAvoided: null,
      traceableRationale: activeIds.size
        ? revisions.filter(
            (revision) => activeIds.has(revision.id) && revision.provenance_state !== 'unknown',
          ).length / activeIds.size
        : 0,
      mergeRequestsOpen: (result.mergeRequests ?? []).filter((request) => request.status === 'open')
        .length,
      queuePending: (result.mergeQueue ?? []).filter((entry) =>
        ['queued', 'blocked', 'needs_review', 'recovery_required'].includes(entry.status),
      ).length,
      humanReverts: (result.operations ?? []).filter(
        (operation) =>
          operation.status === 'applied' &&
          (result.decisions ?? []).some(
            (decision) =>
              decision.id === operation.decision_id && decision.operation_kind === 'revert',
          ),
      ).length,
      staleEvidence: (result.evidence ?? []).filter(
        (evidence) => evidence.validity?.status === 'stale',
      ).length,
    };
    result.analysis = {
      status: view.analysis?.status,
      analyzer: view.analysis?.analyzer,
      semantic: view.analysis?.semantic,
    };
    return result;
  }

  authorizeNative({ method, url, input = {}, principal }) {
    const path = url.pathname;
    if (method === 'GET') {
      const id = path.split('/').filter(Boolean)[2];
      if (id) {
        const repos = this.resourceRepositories({ id });
        if (repos.length) this.require(principal, 'repository.read', repos);
        else this.require(principal, 'repository.read');
      } else this.require(principal, 'workspace.read');
      return;
    }
    let repos = this.resourceRepositories(input);
    let operation = 'access.manage';
    if (path === '/api/repositories') {
      operation = 'repository.create';
      this.assertQuota(
        'repositories',
        this.repositoryIds().length,
        this.repositoryIds().includes(input.id) ? 0 : 1,
      );
    } else if (/^\/api\/repositories\/[^/]+\/refresh$/.test(path)) {
      repos = [path.split('/')[3]];
      operation = 'repository.update';
    } else if (path === '/api/systems') {
      repos = input.repository_ids ?? [];
      operation = 'repository.update';
    } else if (path === '/api/objectives') {
      repos = this.resourceRepositories({ id: input.system_id });
      operation = 'proposal.create';
    } else if (path === '/api/futures' || /^\/api\/objectives\/[^/]+\/futures$/.test(path)) {
      const objectiveId = path.startsWith('/api/objectives/')
        ? path.split('/')[3]
        : input.objective_id;
      repos = input.repository_ids?.length
        ? input.repository_ids
        : this.resourceRepositories({ id: objectiveId || input.system_id });
      operation = 'repository.fork';
    } else if (/^\/api\/futures\/[^/]+\/(observe|abandon)$/.test(path)) {
      const future = this.engine.native.future(path.split('/')[3]);
      repos = this.resourceRepositories(future);
      operation =
        path.endsWith('/abandon') && future.created_by !== principal.actor_id
          ? 'repository.update'
          : 'proposal.create';
    } else if (path === '/api/selections') {
      repos = this.resourceRepositories({ id: input.future_revision_id });
      operation = 'proposal.create';
    } else if (path === '/api/candidates') {
      this.require(principal, 'repository.read', this.repositoryIds());
      operation = 'proposal.create';
    } else if (/^\/api\/candidates\/[^/]+\/(validate|promote)$/.test(path)) {
      repos = this.resourceRepositories({ id: path.split('/')[3] });
      operation = path.endsWith('/promote') ? 'decision.resolve' : 'validation.run';
    } else if (/^\/api\/promotions\/[^/]+\/settle$/.test(path)) {
      repos = this.resourceRepositories({ id: path.split('/')[3] });
      operation = 'decision.resolve';
    } else if (/^\/api\/repository-requests\/[^/]+\/recover$/.test(path)) {
      repos = this.resourceRepositories({ id: path.split('/')[3] });
      operation = 'repository.update';
    } else if (
      path.startsWith('/api/evaluator-profiles') ||
      path.startsWith('/api/evaluator-bindings')
    ) {
      repos = input.repo_ids ?? repos;
      operation = 'policy.write';
    } else if (path.startsWith('/api/evaluation-runs') && !path.endsWith('/report')) {
      const id = path.split('/')[3];
      if (id) repos = this.resourceRepositories({ id });
      operation = 'validation.run';
    } else if (/^\/api\/objectives\/[^/]+\/context$/.test(path)) {
      const target = this.resourceRepositories({ id: path.split('/')[3] });
      this.require(principal, 'proposal.create', target);
      this.require(principal, 'repository.read', repos.length ? repos : target);
      return;
    } else if (/^\/api\/context\/[^/]+\/resolve$/.test(path)) {
      repos = this.resourceRepositories({ id: path.split('/')[3] });
      operation = 'proposal.create';
    }
    // Future service routes must acquire an explicit policy before scoped actors
    // can mutate them. The delegated service applies its own finer checks too.
    this.require(principal, operation, repos);
  }

  projectNative(value, principal) {
    if (permissionSet(this.roles(principal)).has('read')) return redactSensitive(value);
    // Preserve scalar state and ref pagination when every pinned input is
    // readable. Mixed collections still need filtering item by item below.
    if (this.readable(principal, value)) return redactSensitive(value);
    if (Array.isArray(value))
      return value.filter((item) => this.readable(principal, item)).map(redactSensitive);
    const result = {};
    for (const [key, item] of Object.entries(value ?? {})) {
      if (Array.isArray(item)) result[key] = this.projectNative(item, principal);
      else if (item && typeof item === 'object' && this.readable(principal, item))
        result[key] = redactSensitive(item);
    }
    if (value?.attention) {
      const pending = (result.requests ?? []).filter((request) =>
        ['prepared', 'recovery_required'].includes(request.status),
      );
      result.attention = { kind: pending.length ? 'recovery' : 'nothing', count: pending.length };
    }
    return result;
  }

  /** Shared conventional workflow authorization before any delegated mutation. */
  authorizeWorkflow({ method, url, input = {}, principal }) {
    const path = url.pathname;
    if (path === '/api/capabilities') {
      this.require(principal, 'workspace.read');
      return true;
    }
    if (path === '/api/merge-requests') {
      if (method === 'GET') this.require(principal, 'workspace.read');
      else this.require(principal, 'mr.create', [input.repo]);
      return true;
    }
    if (path === '/api/merge-requests/reviews/batch') {
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100)
        throw new DomainError('INVALID_MR_INPUT', 'Supply a bounded list of merge request reviews');
      const repos = (input.items ?? []).flatMap((item) =>
        this.resourceRepositories(this.engine.mr.get(item.mr_id)),
      );
      this.require(principal, 'review.write', repos);
      return true;
    }
    const mr = path.match(/^\/api\/merge-requests\/([^/]+)(?:\/([^/]+))?$/);
    if (mr) {
      const repos = this.resourceRepositories(this.engine.mr.get(mr[1]));
      const action = mr[2];
      let operation = method === 'GET' ? 'repository.read' : 'mr.update';
      if (action === 'reviews' || action === 'comments')
        operation = ['dismiss', 'undismiss'].includes(input.action)
          ? 'review.dismiss'
          : 'review.write';
      if (action === 'prepare') operation = 'decision.prepare';
      if (action === 'validate' || action === 'checks') operation = 'validation.run';
      this.require(principal, operation, repos);
      if (input.policy !== undefined) this.require(principal, 'policy.write', repos);
      return true;
    }
    const policy = path.match(/^\/api\/repositories\/([^/]+)\/policy$/);
    if (policy) {
      this.require(principal, method === 'GET' ? 'repository.read' : 'policy.write', [policy[1]]);
      return true;
    }
    if (path === '/api/reviews/prepare') {
      if (
        !Array.isArray(input.revision_ids) ||
        !input.revision_ids.length ||
        input.revision_ids.length > 100
      )
        throw new DomainError('INVALID_RESOLUTION', 'Supply a bounded list of revisions');
      const repos = (input.revision_ids ?? []).map((id) => this.engine.revision(id).repo);
      this.require(principal, 'decision.prepare', repos);
      return true;
    }
    if (path === '/api/reverts/prepare') {
      this.require(principal, 'decision.resolve', [input.repo]);
      return true;
    }
    if (path === '/api/merge-queue') {
      if (method === 'GET') this.require(principal, 'workspace.read');
      else
        this.require(
          principal,
          'queue.enqueue',
          this.resourceRepositories(this.engine.component(input.component_id)),
        );
      return true;
    }
    if (path === '/api/merge-queue/process') {
      this.require(principal, 'queue.process', this.repositoryIds());
      return true;
    }
    const cancel = path.match(/^\/api\/merge-queue\/([^/]+)\/cancel$/);
    if (cancel) {
      const entry = this.engine.queue.list().find((item) => item.id === cancel[1]);
      if (!entry) throw new DomainError('QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found', 404);
      this.require(principal, 'queue.enqueue', this.resourceRepositories(entry));
      return true;
    }
    return false;
  }

  redactAudit(principal, records = this.engine.state.audit) {
    trusted(principal);
    const workspaceAdmin = this.isWorkspaceAdmin(principal);
    return records
      .filter((entry) => {
        if (workspaceAdmin) return true;
        const repos = this.resourceRepositories(entry.data ?? {});
        if (!repos.length) return false;
        try {
          this.require(principal, 'audit.read', repos);
          return true;
        } catch {
          return false;
        }
      })
      .map((entry) => redactSensitive(entry));
  }
}
