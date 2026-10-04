import { DomainError } from '../core/hash.mjs';
import { getCapabilities } from '../core/capabilities.mjs';

const REVIEW_FIELDS = [
  'action',
  'body',
  'review_id',
  'expected_revision_id',
  'expected_version',
  'request_id',
];

function pickFields(value, names) {
  return Object.fromEntries(
    names
      .filter((key) => Object.prototype.hasOwnProperty.call(value ?? {}, key))
      .map((key) => [key, value[key]]),
  );
}

function policyInput(value) {
  return pickFields(value, ['minApprovals', 'allowSelfApproval', 'requiredChecks']);
}

function ownsWorkflowPath(path) {
  return (
    path === '/api/capabilities' ||
    path === '/api/merge-requests' ||
    path.startsWith('/api/merge-requests/') ||
    path === '/api/merge-queue' ||
    path.startsWith('/api/merge-queue/') ||
    path === '/api/reviews/prepare' ||
    path === '/api/reverts/prepare' ||
    /^\/api\/repositories\/[^/]+\/policy$/.test(path)
  );
}

function requireService(engine, key) {
  if (!engine[key]) {
    throw new DomainError(
      'WORKFLOW_UNAVAILABLE',
      'The requested coordination workflow is unavailable',
      503,
    );
  }
  return engine[key];
}

function currentMergeRequest(engine, id, input) {
  const request = requireService(engine, 'mr').get(id);
  if (
    input.expected_revision_id !== undefined &&
    input.expected_revision_id !== request.revision_id
  ) {
    throw new DomainError(
      'MERGE_REQUEST_STALE',
      'The merge request revision changed. Review the current request.',
      409,
    );
  }
  if (
    input.expected_version !== undefined &&
    ![request.version, request.event_id, request.version_id].includes(input.expected_version)
  ) {
    throw new DomainError(
      'MERGE_REQUEST_STALE',
      'The merge request changed. Review its current version.',
      409,
    );
  }
  if (!request.revision_id) {
    throw new DomainError(
      'REVISION_NOT_FOUND',
      'The merge request needs an ingested immutable revision',
      409,
    );
  }
  return request;
}

function handleMergeRequestCollection(engine, { method, input, actor }) {
  const mr = requireService(engine, 'mr');
  if (method === 'GET') return { mergeRequests: mr.list() };
  if (method === 'POST') {
    return mr.open(
      pickFields(input, [
        'repo',
        'source_ref',
        'source_repo',
        'target_ref',
        'title',
        'description',
        'draft',
        'request_id',
      ]),
      actor,
    );
  }
  return null;
}

async function reviewBatch(engine, input, actor) {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) {
    throw new DomainError(
      'INVALID_MR_INPUT',
      'Supply between one and 100 exact merge-request reviews',
    );
  }
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new DomainError('INVALID_MR_INPUT', 'Each batch review must be a JSON object');
    }
    return pickFields(item, ['mr_id', ...REVIEW_FIELDS]);
  });
  return { mergeRequests: await requireService(engine, 'mr').reviewBatch(items, actor) };
}

async function handleMergeRequest(engine, id, action, { method, input, actor }) {
  const mr = requireService(engine, 'mr');
  if (method === 'GET' && !action) return mr.get(id);
  if (method !== 'POST') return null;

  switch (action) {
    case 'transition': {
      const value = pickFields(input, [
        'action',
        'title',
        'description',
        'expected_version',
        'request_id',
      ]);
      if (input.policy) value.policy = policyInput(input.policy);
      return mr.transition(id, value, actor);
    }
    case 'reviews':
      return mr.review(id, pickFields(input, REVIEW_FIELDS), actor);
    case 'comments':
      return mr.comment(
        id,
        pickFields(input, [
          'action',
          'body',
          'file',
          'line',
          'thread_id',
          'expected_revision_id',
          'expected_version',
          'request_id',
        ]),
        actor,
      );
    case 'checks':
      return mr.check(
        id,
        pickFields(input, [
          'name',
          'status',
          'details',
          'url',
          'expected_revision_id',
          'expected_version',
          'request_id',
        ]),
        actor,
      );
    case 'dependencies':
      return mr.dependencies(
        id,
        pickFields(input, ['dependency_ids', 'expected_version', 'request_id']),
        actor,
      );
    case 'prepare': {
      const snapshot = currentMergeRequest(engine, id, input);
      return engine.prepareReview(
        {
          ...pickFields(input, ['title', 'request_id']),
          revision_ids: [snapshot.revision_id],
        },
        actor,
      );
    }
    case 'validate': {
      const snapshot = currentMergeRequest(engine, id, input);
      const validation = await engine.validateRevision(snapshot.revision_id, { actor });
      return { mergeRequest: mr.get(id), validation };
    }
    default:
      return null;
  }
}

function handleMergeQueue(engine, path, { method, input, actor }) {
  if (path === '/api/merge-queue') {
    const queue = requireService(engine, 'queue');
    if (method === 'GET') return { mergeQueue: queue.list() };
    if (method === 'POST') {
      return queue.enqueue(
        pickFields(input, [
          'request_id',
          'component_id',
          'alternative_id',
          'basis_hash',
          'expected_canonical_head',
          'rationale',
          'mr_basis_hash',
        ]),
        actor,
      );
    }
  }
  if (path === '/api/merge-queue/process' && method === 'POST') {
    return requireService(engine, 'queue').process(pickFields(input, ['request_id']), actor);
  }
  const cancel = path.match(/^\/api\/merge-queue\/([^/]+)\/cancel$/);
  if (cancel && method === 'POST') {
    return requireService(engine, 'queue').cancel(
      cancel[1],
      pickFields(input, ['request_id']),
      actor,
    );
  }
  return null;
}

function handleRepositoryPolicy(engine, repo, { method, input, actor }) {
  const mr = requireService(engine, 'mr');
  if (method === 'GET') return mr.getPolicy(repo);
  if (method === 'POST') {
    return mr.setPolicy(
      repo,
      {
        ...pickFields(input, ['expected_version', 'request_id']),
        policy: policyInput(input.policy),
      },
      actor,
    );
  }
  return null;
}

/**
 * Provider-neutral routing only. The caller owns authentication, serialization
 * and persistence. Producers never select audit actors or trusted check sources.
 * Returns a domain result, or null when another dispatcher owns the route.
 */
export async function handleWorkflowRequest(engine, { method, url, input = {}, actor }) {
  const parsed = url instanceof URL ? url : new URL(url, 'http://coordination.internal');
  const path = parsed.pathname;
  if (!ownsWorkflowPath(path)) return null;
  if (typeof actor !== 'string' || !actor.trim()) {
    throw new DomainError(
      'UNAUTHENTICATED',
      'An authenticated coordination actor is required',
      401,
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('INVALID_REQUEST', 'Workflow input must be a JSON object');
  }
  const request = { method, input, actor };

  if (path === '/api/capabilities') {
    if (method !== 'GET')
      throw new DomainError('METHOD_NOT_ALLOWED', 'Capabilities are read-only', 405);
    return getCapabilities();
  }
  if (path === '/api/merge-requests') return handleMergeRequestCollection(engine, request);
  if (path === '/api/merge-requests/reviews/batch' && method === 'POST') {
    return reviewBatch(engine, input, actor);
  }
  const mergeRequest = path.match(
    /^\/api\/merge-requests\/([^/]+)(?:\/(transition|reviews|comments|checks|dependencies|prepare|validate))?$/,
  );
  if (mergeRequest) return handleMergeRequest(engine, mergeRequest[1], mergeRequest[2], request);
  if (path === '/api/merge-queue' || path.startsWith('/api/merge-queue/')) {
    return handleMergeQueue(engine, path, request);
  }
  if (path === '/api/reviews/prepare' && method === 'POST') {
    return engine.prepareReview(pickFields(input, ['revision_ids', 'title', 'request_id']), actor);
  }
  if (path === '/api/reverts/prepare' && method === 'POST') {
    return engine.prepareRevert(
      pickFields(input, [
        'repo',
        'target_commit',
        'decision_id',
        'mainline',
        'title',
        'rationale',
        'request_id',
      ]),
      actor,
    );
  }
  const repository = path.match(/^\/api\/repositories\/([^/]+)\/policy$/);
  if (repository) return handleRepositoryPolicy(engine, repository[1], request);
  return null;
}
