import { DomainError, hash } from '../core/hash.mjs';

const roots = [
  '/api/context',
  '/api/discovery',
  '/api/decision-groups',
  '/api/evaluators',
  '/api/evaluation-runs',
  '/api/session',
  '/api/access',
  '/api/provenance',
];

export function ownsNativeServicePath(path) {
  return (
    roots.some((root) => path === root || path.startsWith(root + '/')) ||
    /^\/api\/objectives\/[^/]+\/context$/.test(path) ||
    /^\/api\/systems\/[^/]+\/context\/export$/.test(path) ||
    /^\/api\/candidates\/[^/]+\/(evaluations|declarations)$/.test(path) ||
    path === '/api/events/export'
  );
}

/** Actor-only calls remain available to trusted owner code, never HTTP identities. */
export function nativePrincipal(engine, actor, principal) {
  if (principal) {
    if (principal.actor_id !== actor)
      throw new DomainError('UNAUTHENTICATED', 'Actor must match the authenticated principal', 401);
    return principal;
  }
  if (!engine.access) return null;
  if (actor !== engine.state.workspace.owner_id)
    throw new DomainError('UNAUTHENTICATED', 'An authenticated principal is required', 401);
  return { actor_id: actor, kind: 'human', auth_method: 'owner-token' };
}

function pick(input, keys) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]),
  );
}

function methodIs(actual, expected) {
  if (actual !== expected)
    throw new DomainError('METHOD_NOT_ALLOWED', 'The endpoint does not support that method', 405);
}

function service(engine, name) {
  if (!engine[name])
    throw new DomainError('SERVICE_UNAVAILABLE', 'The native service is unavailable', 503);
  return engine[name];
}

function repositories(engine, ...values) {
  return engine.access
    ? [...new Set(values.flatMap((value) => engine.access.resourceRepositories(value)))]
    : [];
}

function authorize(engine, principal, operation, ...values) {
  if (engine.access) engine.access.require(principal, operation, repositories(engine, ...values));
}

function header(headers, name) {
  return headers?.get?.(name) ?? headers?.[name] ?? null;
}

function project(engine, principal, value) {
  return engine.access ? engine.access.projectNative(value, principal) : value;
}

/** Present immutable trace records without assigning certainty to producer rationale. */
function tracePresentation(engine, trace) {
  const records = [],
    links = [];
  const add = (kind, value, basis, statement) => {
    if (!records.some((entry) => entry.kind === kind && entry.id === value.id))
      records.push({ ...value, kind, basis, ...(statement ? { statement } : {}) });
  };
  const link = (fromKind, fromId, toKind, toId, type, basis) => {
    if (fromId && toId)
      links.push({
        from: { kind: fromKind, id: fromId },
        to: { kind: toKind, id: toId },
        type,
        basis,
      });
  };
  for (const revision of trace.revisions) {
    add(
      'revision',
      revision,
      'observed',
      'Exact Git revision; producer intent is recorded separately.',
    );
    const future = engine.native.future(revision.future_id);
    const objective = engine.native.objective(future.objective_id);
    add('objective', objective, objective.source?.basis ?? 'unknown', objective.statement);
    link(
      'objective',
      objective.id,
      'revision',
      revision.id,
      'requested_outcome',
      objective.source?.basis ?? 'unknown',
    );
    link('snapshot', revision.snapshot_id, 'revision', revision.id, 'context', 'observed');
  }
  for (const selection of trace.selections) {
    add(
      'selection',
      selection,
      'observed',
      'Selected Git material; semantic dependency closure is not established.',
    );
    const source = engine.state.selections.find((entry) => entry.id === selection.id);
    link('revision', source.future_revision_id, 'selection', selection.id, 'selection', 'observed');
  }
  for (const candidate of trace.candidates) {
    add('candidate', candidate, 'observed', 'An exact composed Git state.');
    for (const selectionId of engine.state.candidateStates.find(
      (entry) => entry.id === candidate.id,
    ).selection_ids)
      link('selection', selectionId, 'candidate', candidate.id, 'composition', 'observed');
  }
  for (const decision of trace.decisions) {
    add('decision', decision, 'declared', decision.rationale);
    const source = engine.state.nativeDecisions.find((entry) => entry.id === decision.id);
    link('candidate', source.candidate_id, 'decision', decision.id, 'resolution', 'declared');
  }
  for (const snapshot of trace.snapshots) {
    add(
      'snapshot',
      snapshot,
      'observed',
      'Context references and explicit answers or assumptions.',
    );
    link(
      'preparation',
      snapshot.preparation_id,
      'snapshot',
      snapshot.id,
      'context_snapshot',
      'observed',
    );
  }
  for (const preparation of trace.preparations) {
    add('preparation', preparation, 'observed', 'Pinned retrieved context.');
    for (const item of preparation.items) {
      add('context-item', item, item.basis, item.value?.statement);
      link('context-item', item.id, 'preparation', preparation.id, 'retrieved_context', item.basis);
    }
  }
  return { version: 0, records, links, code_provenance: trace.code_provenance };
}

/**
 * Shared native service dispatch. Permissions cover every repository referenced
 * by a response, including context imported from outside the target System.
 */
export async function handleNativeServiceRequest(
  engine,
  { method, url, input = {}, actor, principal, requestHeaders },
) {
  const path = url.pathname;
  if (path === '/api/session') {
    methodIs(method, 'GET');
    return service(engine, 'access').session(principal);
  }
  if (path === '/api/access') {
    const access = service(engine, 'access');
    if (method === 'GET') return access.policy(principal, url.searchParams.get('repo_id'));
    methodIs(method, 'POST');
    return access.update(pick(input, ['expected_version', 'changes', 'limits']), principal);
  }

  const prepare = path.match(/^\/api\/objectives\/([^/]+)\/context$/);
  if (prepare) {
    methodIs(method, 'POST');
    const objective = engine.native.objective(prepare[1]);
    authorize(engine, principal, 'proposal.create', objective);
    authorize(engine, principal, 'repository.read', objective, { sources: input.sources ?? [] });
    return project(
      engine,
      principal,
      await service(engine, 'objectiveContext').prepare(
        objective.id,
        pick(input, ['sources', 'hypothesis', 'request_id']),
        actor,
      ),
    );
  }
  if (path === '/api/context/search') {
    methodIs(method, 'GET');
    const systemId = url.searchParams.get('system_id');
    const context = service(engine, 'objectiveContext');
    const contextData = context.export(systemId);
    authorize(engine, principal, 'repository.read', engine.native.system(systemId), contextData);
    return project(engine, principal, {
      results: context.search({
        system_id: systemId,
        query: url.searchParams.get('query'),
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      }),
    });
  }
  const exportContext = path.match(/^\/api\/systems\/([^/]+)\/context\/export$/);
  if (exportContext) {
    methodIs(method, 'GET');
    const contextData = service(engine, 'objectiveContext').export(exportContext[1]);
    authorize(
      engine,
      principal,
      'export.read',
      engine.native.system(exportContext[1]),
      contextData,
    );
    return project(engine, principal, contextData);
  }
  const contextRecord = path.match(/^\/api\/context\/([^/]+)(?:\/(resolve))?$/);
  if (contextRecord) {
    const context = service(engine, 'objectiveContext');
    const preparation = context.object('nativeContextPreparations', contextRecord[1]);
    const objective = engine.native.objective(preparation.objective_id);
    authorize(engine, principal, 'repository.read', objective, preparation);
    if (!contextRecord[2]) {
      methodIs(method, 'GET');
      return project(engine, principal, await context.review(preparation.id));
    }
    methodIs(method, 'POST');
    authorize(engine, principal, 'proposal.create', objective);
    return project(
      engine,
      principal,
      await context.resolve(
        preparation.id,
        pick(input, ['expected_basis_hash', 'mode', 'answers', 'rationale', 'request_id']),
        actor,
      ),
    );
  }
  const provenance = path.match(/^\/api\/provenance\/([^/]+)\/([^/]+)$/);
  if (provenance) {
    methodIs(method, 'GET');
    const trace = service(engine, 'objectiveContext').trace({
      kind: provenance[1],
      id: provenance[2],
      repo_id: url.searchParams.get('repo_id'),
    });
    authorize(
      engine,
      principal,
      'repository.read',
      trace,
      { repo_id: url.searchParams.get('repo_id') },
      provenance[1] === 'objective' ? engine.native.objective(provenance[2]) : {},
    );
    return project(engine, principal, tracePresentation(engine, trace));
  }

  if (path === '/api/discovery') {
    const graph = service(engine, 'futuresGraph');
    if (method === 'GET') {
      if (engine.access) engine.access.require(principal, 'workspace.read');
      return project(engine, principal, graph.view());
    }
    methodIs(method, 'POST');
    // Analysis may inspect complete candidate dependency vectors. Restrict its
    // input scope explicitly; never infer authorization from a selected label.
    authorize(
      engine,
      principal,
      'analysis.run',
      input.system_id
        ? engine.native.system(input.system_id)
        : { repository_ids: engine.access?.repositoryIds() ?? [] },
    );
    authorize(engine, principal, 'repository.read', {
      repository_ids: engine.access?.repositoryIds() ?? [],
    });
    return project(
      engine,
      principal,
      await graph.analyze(pick(input, ['system_id', 'request_id', 'max_comparisons']), actor),
    );
  }
  if (path === '/api/discovery/relationships') {
    methodIs(method, 'POST');
    const from = engine.native.revision(input.from_revision);
    const to = engine.native.revision(input.to_revision);
    authorize(engine, principal, 'review.write', from, to);
    return project(
      engine,
      principal,
      await service(engine, 'futuresGraph').addRelationship(
        pick(input, ['from_revision', 'to_revision', 'type', 'statement', 'request_id']),
        actor,
      ),
    );
  }
  const group = path.match(/^\/api\/decision-groups\/([^/]+)(?:\/(review|resolve))?$/);
  if (group) {
    const graph = service(engine, 'futuresGraph');
    const value = graph.view().decisionGroups.find((entry) => entry.id === group[1]);
    if (!value) throw new DomainError('NOT_FOUND', 'Decision group not found', 404);
    authorize(engine, principal, 'repository.read', value, {
      repository_ids: engine.access?.repositoryIds() ?? [],
    });
    if (!group[2] || group[2] === 'review') {
      methodIs(method, 'GET');
      return project(engine, principal, await graph.review(value.id));
    }
    methodIs(method, 'POST');
    authorize(engine, principal, 'decision.resolve', value, { candidate_id: input.candidate_id });
    return project(
      engine,
      principal,
      await graph.resolve(
        value.id,
        pick(input, [
          'request_id',
          'decision_basis_hash',
          'expected_heads',
          'rationale',
          'dispositions',
          'candidate_id',
          'candidate_basis_hash',
        ]),
        actor,
      ),
    );
  }

  if (path === '/api/evaluators') {
    const evaluators = service(engine, 'evaluators');
    if (method === 'GET') {
      if (engine.access) engine.access.require(principal, 'workspace.read');
      return project(engine, principal, evaluators.view());
    }
    methodIs(method, 'POST');
    authorize(engine, principal, 'policy.write', { repo_ids: input.repo_ids });
    return project(
      engine,
      principal,
      await evaluators.register(
        pick(input, [
          'key',
          'repo_ids',
          'mode',
          'config_hash',
          'service_id',
          'required_checks',
          'required',
          'enabled',
          'timeout_ms',
          'cost_units',
        ]),
        actor,
        principal,
      ),
    );
  }
  const candidate = path.match(/^\/api\/candidates\/([^/]+)\/(evaluations|declarations)$/);
  if (candidate) {
    const evaluators = service(engine, 'evaluators');
    const value = engine.pipeline.object('candidateStates', candidate[1]);
    authorize(engine, principal, 'repository.read', value);
    if (candidate[2] === 'evaluations') {
      methodIs(method, 'GET');
      return project(engine, principal, await evaluators.review(value.id));
    }
    methodIs(method, 'POST');
    authorize(engine, principal, 'proposal.create', value);
    return project(
      engine,
      principal,
      await evaluators.declaration(value.id, pick(input, ['summary']), actor),
    );
  }
  if (path === '/api/evaluation-runs') {
    const evaluators = service(engine, 'evaluators');
    if (method === 'GET') {
      if (engine.access) engine.access.require(principal, 'workspace.read');
      return project(engine, principal, { runs: evaluators.view().runs });
    }
    methodIs(method, 'POST');
    const value = engine.pipeline.object('candidateStates', input.candidate_id);
    const profile = evaluators.object('evaluatorProfiles', input.profile_id);
    authorize(engine, principal, 'validation.run', value, profile);
    if (engine.access) {
      const requestHash = await hash({ actor, request_id: input.request_id });
      const allRuns = evaluators.view().runs;
      const active = allRuns.filter(
        (run) =>
          Date.parse(run.expires_at) > evaluators.clock() &&
          !['passing', 'failed', 'cancelled', 'skipped'].includes(evaluators.latest(run.id)?.state),
      );
      engine.access.assertQuota(
        'pending_runs',
        active.length,
        allRuns.some((run) => run.request_hash === requestHash) ? 0 : 1,
      );
    }
    return project(
      engine,
      principal,
      await evaluators.run(value.id, pick(input, ['profile_id', 'request_id']), actor),
    );
  }
  const run = path.match(/^\/api\/evaluation-runs\/([^/]+)(?:\/(dispatch|report|cancel))?$/);
  if (run) {
    const evaluators = service(engine, 'evaluators');
    if (run[2] === 'report') {
      methodIs(method, 'POST');
      const serviceId = header(requestHeaders, 'x-klocgit-evaluator-service');
      if (
        principal?.kind !== 'service' ||
        principal.auth_method !== 'evaluator-hmac' ||
        principal.actor_id !== 'evaluator:' + serviceId
      )
        throw new DomainError(
          'UNAUTHENTICATED_EVALUATOR',
          'An authenticated evaluator callback is required',
          401,
        );
      // Preserve the exact signed body. The evaluator validates its issued pins,
      // service scope, HMAC, terminal state and duplicate callback identity.
      const result = await evaluators.report(run[1], input, {
        service_id: serviceId,
        signature: header(requestHeaders, 'x-klocgit-evaluator-signature'),
      });
      return {
        run_id: result.run.id,
        event_id: result.event.id,
        state: result.event.state,
        duplicate: result.duplicate === true,
      };
    }
    const value = evaluators.object('evaluationRuns', run[1]);
    authorize(engine, principal, run[2] ? 'validation.run' : 'repository.read', value);
    if (!run[2]) {
      methodIs(method, 'GET');
      return project(engine, principal, {
        run: value,
        event: evaluators.latest(value.id),
        validity: await evaluators.validity(value),
      });
    }
    methodIs(method, 'POST');
    const result =
      run[2] === 'dispatch'
        ? await evaluators.dispatch(value.id)
        : await evaluators.cancel(value.id, pick(input, ['reason']), actor);
    return project(engine, principal, result);
  }
  if (path === '/api/events/export') {
    methodIs(method, 'GET');
    const systemId = url.searchParams.get('system_id');
    const system = systemId ? engine.native.system(systemId) : null;
    const repos = system ? repositories(engine, system) : (engine.access?.repositoryIds() ?? []);
    if (engine.access) engine.access.require(principal, 'export.read', repos);
    const events = (engine.state.nativeEvents ?? []).filter((event) => {
      if (!system) return true;
      const eventRepos = repositories(engine, event);
      return eventRepos.length && eventRepos.every((id) => repos.includes(id));
    });
    return project(engine, principal, { events: structuredClone(events) });
  }
  throw new DomainError('NOT_FOUND', 'Native service endpoint not found', 404);
}
