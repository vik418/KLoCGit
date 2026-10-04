import { hash, record, DomainError } from './hash.mjs';

// Deliberately small and deterministic. This is one explicit task schema, not a
// semantic interpreter: it cannot manufacture questions from arbitrary prose.
const PARAMETER = 'retry_failed_response';
const SCHEMA = 'retry-response-v1';
const timestamp = (value) => value ?? new Date().toISOString();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
// Advice can inform a choice; it cannot remove a choice or force an answer.
const allowedAnswers = (constraint) =>
  constraint.kind === 'checkable' ? constraint.allowed_values : [false, true];

function requireActor(actor) {
  if (typeof actor !== 'string' || !actor.trim())
    throw new DomainError(
      'UNAUTHENTICATED',
      'Context declarations require an authenticated actor',
      401,
    );
}

function requireAnswer(value, allowed) {
  if (typeof value !== 'boolean' || !allowed.includes(value))
    throw new DomainError(
      'INVALID_CONTEXT_ANSWER',
      'The retry answer must be an allowed boolean value',
    );
}

function repository(repositories, id) {
  const found = repositories.find((repo) => repo.id === id);
  if (!found)
    throw new DomainError('REPO_NOT_FOUND', 'Context repositories must be registered', 404);
  return found;
}

function hasExplicitScope(scope) {
  return (
    Array.isArray(scope) &&
    scope.length > 0 &&
    scope.every((value) => typeof value === 'string' && value.length > 0)
  );
}

function hasAllowedBooleanValues(values) {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === 'boolean') &&
    new Set(values).size === values.length
  );
}

function requireTaskInput(input) {
  if (!input || input.schema !== SCHEMA) {
    throw new DomainError(
      'CONTEXT_SCHEMA_UNSUPPORTED',
      'Only the explicit retry-response-v1 task schema can ask a context question',
    );
  }
  if (
    typeof input.statement !== 'string' ||
    !input.statement.trim() ||
    !hasExplicitScope(input.scope)
  ) {
    throw new DomainError(
      'INVALID_CONTEXT_TASK',
      'A task statement and explicit affected scope are required',
    );
  }
  const parameters = input.parameters;
  if (
    parameters !== undefined &&
    (!parameters ||
      typeof parameters !== 'object' ||
      Array.isArray(parameters) ||
      Object.keys(parameters).some((key) => key !== PARAMETER))
  ) {
    throw new DomainError(
      'INVALID_CONTEXT_TASK',
      'The explicit retry schema accepts only the retry_failed_response parameter',
    );
  }
}

function requireContextAdapter(repositories, git) {
  if (!Array.isArray(repositories) || !git?.ref || !git?.file) {
    throw new DomainError(
      'INVALID_CONTEXT_ADAPTER',
      'Registered repositories and immutable Git reads are required',
    );
  }
}

function validatePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '..' || part === '.' || !part)
  ) {
    throw new DomainError(
      'INVALID_CONTEXT_PATH',
      'Context source must be a repository-relative file path',
    );
  }
}

function requireSourceBranch(ref) {
  if (
    typeof ref !== 'string' ||
    !/^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(ref) ||
    ref.includes('..')
  ) {
    throw new DomainError('INVALID_REF', 'Context retrieval requires a valid branch ref');
  }
}

function requireImmutableCommit(commit) {
  if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new DomainError(
      'INVALID_COMMIT',
      'Context retrieval must resolve an immutable commit ID',
    );
  }
}

function parseConstraint(content) {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new DomainError(
      'INVALID_CONTEXT_SOURCE',
      'Retry context must be a JSON constraint or decision document',
    );
  }
  const isDocument = value && typeof value === 'object' && !Array.isArray(value);
  const hasIdentity =
    isDocument &&
    typeof value.id === 'string' &&
    value.id &&
    Number.isInteger(value.version) &&
    value.version >= 1;
  const describesRetryConstraint =
    isDocument &&
    typeof value.statement === 'string' &&
    value.parameter === PARAMETER &&
    ['checkable', 'advisory'].includes(value.kind);
  if (
    !hasIdentity ||
    !describesRetryConstraint ||
    !hasAllowedBooleanValues(value.allowed_values) ||
    !hasExplicitScope(value.validity_scope)
  ) {
    throw new DomainError(
      'INVALID_CONTEXT_SOURCE',
      'Retry context requires a versioned constraint, allowed boolean values, kind and validity scope',
    );
  }
  if (own(value, 'decision_answer')) requireAnswer(value.decision_answer, allowedAnswers(value));
  // A retrieved answer must be backed by an explicit decision record. A boolean
  // appearing somewhere in repository prose is not considered a reliable answer.
  if (
    own(value, 'decision_answer') &&
    (typeof value.decision_id !== 'string' || !value.decision_id)
  ) {
    throw new DomainError(
      'INVALID_CONTEXT_SOURCE',
      'A retrieved answer must reference an existing decision ID',
    );
  }
  return value;
}

async function createContextSnapshot(preparation, resolution, createdAt) {
  const { task, source, constraint, question } = preparation;
  const retrieved = await record('context_item', {
    type: 'constraint',
    value: constraint.value,
    basis: 'retrieved',
    source: {
      source_id: source.id,
      repo: source.repo,
      commit: source.commit,
      path: source.path,
      content_hash: source.content_hash,
    },
    validity_scope: constraint.value.validity_scope,
  });
  const items = [retrieved, resolution.item];
  const assumptionIds = resolution.assumption ? [resolution.item.id] : [];
  return record('ctx', {
    task_id: task.id,
    schema: SCHEMA,
    items,
    constraints: [constraint.id],
    sources: [source],
    questions: question ? [question.id] : [],
    answer_ref: resolution.assumption ? null : resolution.item.id,
    assumption_refs: assumptionIds,
    parameter_values: { [PARAMETER]: resolution.value },
    validity_scope: task.scope,
    created_at: createdAt,
  });
}

async function createProducerAuthorization(task, snapshot, resolution, createdAt) {
  return record('producer_authorization', {
    task_id: task.id,
    context_version: snapshot.id,
    parameter_values: snapshot.parameter_values,
    basis: resolution.item.basis,
    answer_ref: snapshot.answer_ref,
    unresolved_assumption_refs: snapshot.assumption_refs,
    requires_human_review: resolution.assumption,
    created_at: createdAt,
  });
}

async function createResolvedPreparation(preparation, resolution, createdAt) {
  const { task, source, constraint, question } = preparation;
  const snapshot = await createContextSnapshot(preparation, resolution, createdAt);
  const authorization = await createProducerAuthorization(task, snapshot, resolution, createdAt);
  return record('context_preparation', {
    task,
    source,
    constraint,
    question: question ?? null,
    status: resolution.assumption ? 'ready_with_assumption' : 'ready',
    snapshot,
    authorization,
  });
}

/**
 * Read one exact cross-repository constraint before authorizing a producer.
 * git needs ref(repo, ref) and file(repo, immutableCommit, relativePath).
 * No repository code is executed and no task prose is semantically interpreted.
 *
 * @param {object} input
 * @param {{schema: 'retry-response-v1', statement: string, target_repo: string,
 *   scope: string[], context_source: {repo: string, ref?: string, path: string},
 *   parameters?: {retry_failed_response?: boolean}}} input.task
 * @param {object[]} input.repositories Registered repository descriptors.
 * @param {{ref: Function, file: Function}} input.git Immutable Git read adapter.
 * @param {string} input.actor Authenticated identity supplied by the caller.
 * @param {string} [input.created_at] Timestamp supplied by the trusted caller.
 */
export async function prepareTaskContext({ task: input, repositories, git, actor, created_at }) {
  requireActor(actor);
  const createdAt = timestamp(created_at);
  requireTaskInput(input);
  requireContextAdapter(repositories, git);
  repository(repositories, input.target_repo);
  const requested = input.context_source;
  if (!requested || requested.repo === input.target_repo)
    throw new DomainError(
      'CROSS_REPO_CONTEXT_REQUIRED',
      'This context flow requires a source in another registered repository',
    );
  const sourceRepo = repository(repositories, requested.repo);
  validatePath(requested.path);
  const ref = requested.ref ?? sourceRepo.canonical_ref;
  requireSourceBranch(ref);
  const commit = await git.ref(sourceRepo, ref);
  requireImmutableCommit(commit);
  const content = await git.file(sourceRepo, commit, requested.path);
  if (typeof content !== 'string')
    throw new DomainError(
      'CONTEXT_SOURCE_NOT_FOUND',
      'The constraint file is unavailable at the captured commit',
      404,
    );
  const parsed = parseConstraint(content);
  if (!input.scope.every((scope) => parsed.validity_scope.includes(scope)))
    throw new DomainError(
      'CONTEXT_SCOPE_MISMATCH',
      'The retrieved constraint must cover the explicitly affected task scope',
    );
  const source = await record('context_source', {
    repo: sourceRepo.id,
    ref_seen: ref,
    commit,
    path: requested.path,
    content_hash: await hash(content),
    hash_format: 'sha256-stable-json-v1',
  });
  const constraint = await record('retrieved_constraint', { value: parsed, source_ref: source.id });
  const task = await record('context_task', {
    statement: input.statement,
    schema: SCHEMA,
    target_repo: input.target_repo,
    scope: [...input.scope],
    parameters: input.parameters ?? {},
    context_source: { repo: requested.repo, ref, path: requested.path },
    actor,
    created_at: createdAt,
  });
  const preparation = { task, source, constraint };
  if (own(input.parameters, PARAMETER)) {
    const value = input.parameters[PARAMETER];
    requireAnswer(value, allowedAnswers(parsed));
    if (own(parsed, 'decision_answer') && parsed.decision_answer !== value)
      throw new DomainError(
        'CONTEXT_DECISION_CONFLICT',
        'The declared answer conflicts with the retrieved decision and requires explicit review',
        409,
      );
    const item = await record('context_item', {
      type: 'parameter',
      value: { name: PARAMETER, value },
      basis: 'declared',
      source: { actor, task_id: task.id, created_at: createdAt },
      validity_scope: task.scope,
    });
    return createResolvedPreparation(preparation, { value, item, assumption: false }, createdAt);
  }
  if (own(parsed, 'decision_answer')) {
    const value = parsed.decision_answer;
    const item = await record('context_item', {
      type: 'parameter',
      value: { name: PARAMETER, value },
      basis: 'retrieved',
      source: {
        source_id: source.id,
        decision_id: parsed.decision_id,
        repo: source.repo,
        commit: source.commit,
        path: source.path,
      },
      validity_scope: task.scope,
    });
    return createResolvedPreparation(preparation, { value, item, assumption: false }, createdAt);
  }
  if (allowedAnswers(parsed).length === 1) {
    const value = allowedAnswers(parsed)[0];
    const item = await record('context_item', {
      type: 'parameter',
      value: { name: PARAMETER, value },
      basis: 'retrieved',
      source: {
        source_id: source.id,
        constraint_id: constraint.id,
        repo: source.repo,
        commit: source.commit,
        path: source.path,
      },
      validity_scope: task.scope,
    });
    return createResolvedPreparation(preparation, { value, item, assumption: false }, createdAt);
  }
  const question = await record('context_question', {
    task_id: task.id,
    source_ref: source.id,
    constraint_ref: constraint.id,
    parameter: PARAMETER,
    statement:
      'Should the client retry a failed response after the service may already have accepted the request?',
    options: [
      { value: false, label: 'Do not retry failed responses' },
      { value: true, label: 'Retry failed responses' },
    ],
    material_effect:
      'Changes retry behavior and whether a request can produce repeated side effects.',
    validity_scope: task.scope,
    created_at: createdAt,
  });
  return record('context_preparation', {
    ...preparation,
    question,
    status: 'needs_clarification',
    snapshot: null,
    authorization: null,
  });
}

function requireUnansweredQuestion(preparation) {
  if (
    preparation?.status !== 'needs_clarification' ||
    !preparation.question ||
    preparation.authorization
  )
    throw new DomainError(
      'CONTEXT_ALREADY_RESOLVED',
      'Only an unanswered context question can be resolved',
      409,
    );
}

/**
 * Answer the single question with a boolean declaration. The caller supplies
 * authenticated actor identity and, when specified, the declaration timestamp.
 */
export async function answerTaskContext(preparation, { value, actor, created_at }) {
  requireUnansweredQuestion(preparation);
  requireActor(actor);
  requireAnswer(value, allowedAnswers(preparation.constraint.value));
  const createdAt = timestamp(created_at);
  const item = await record('context_item', {
    type: 'parameter',
    value: { name: PARAMETER, value },
    basis: 'declared',
    source: {
      actor,
      task_id: preparation.task.id,
      question_id: preparation.question.id,
      created_at: createdAt,
    },
    validity_scope: preparation.task.scope,
  });
  return createResolvedPreparation(preparation, { value, item, assumption: false }, createdAt);
}

/**
 * Producers need not wait indefinitely: an explicit, auditable assumption can
 * authorize code while retaining the unresolved question for human review.
 * Elapsed time never counts as an answer, and no automatic timeout chooses one.
 */
export async function assumeTaskContext(preparation, { value, rationale, actor, created_at }) {
  requireUnansweredQuestion(preparation);
  requireActor(actor);
  requireAnswer(value, allowedAnswers(preparation.constraint.value));
  if (typeof rationale !== 'string' || !rationale.trim())
    throw new DomainError(
      'ASSUMPTION_RATIONALE_REQUIRED',
      'An explicit assumption requires a rationale',
    );
  const createdAt = timestamp(created_at);
  const item = await record('context_item', {
    type: 'assumption',
    value: { name: PARAMETER, assumed_value: value, rationale },
    basis: 'declared',
    truth_state: 'unresolved',
    source: {
      actor,
      task_id: preparation.task.id,
      question_id: preparation.question.id,
      created_at: createdAt,
    },
    validity_scope: preparation.task.scope,
  });
  return createResolvedPreparation(preparation, { value, item, assumption: true }, createdAt);
}

/** IDs travel with Git code; full retrieved content and task prose stay metadata. */
export async function contextProvenance(preparation) {
  if (!preparation?.snapshot || !preparation.authorization)
    throw new DomainError(
      'PRODUCER_NOT_AUTHORIZED',
      'Resolve the question or explicitly record an assumption before producing code',
      409,
    );
  const { task, snapshot, authorization } = preparation;
  const gitTrailers = [
    `Decision-Task: ${task.id}`,
    `Decision-Context: ${snapshot.id}`,
    `Decision-Authorization: ${authorization.id}`,
    ...(snapshot.answer_ref ? [`Decision-Answer: ${snapshot.answer_ref}`] : []),
    ...snapshot.assumption_refs.map((id) => `Decision-Assumption: ${id}`),
  ];
  return record('context_provenance', {
    metadata: {
      context_version: snapshot.id,
      context_snapshot_id: snapshot.id,
      context_task_id: task.id,
      context_answer_ref: snapshot.answer_ref,
      context_authorization_ref: authorization.id,
      context_assumption_refs: snapshot.assumption_refs,
    },
    git_trailers: gitTrailers,
    artifact: {
      version: 1,
      task_id: task.id,
      context_version: snapshot.id,
      context_snapshot_id: snapshot.id,
      authorization_ref: authorization.id,
      answer_ref: snapshot.answer_ref,
      assumption_refs: snapshot.assumption_refs,
      sources: snapshot.sources,
      parameter_values: snapshot.parameter_values,
      requires_human_review: authorization.requires_human_review,
    },
  });
}
