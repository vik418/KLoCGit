import { DomainError, hash, record, stable } from './hash.mjs';
import { validationPassed } from './evidence.mjs';

const oid = /^(?!0{40}$)[a-f0-9]{40}$/;
const terminal = new Set(['passing', 'failed', 'cancelled', 'skipped']);
const acceptedStates = new Set(['running', ...terminal]);
const defaults = {
  max_active_runs: 20,
  max_runs_per_day: 200,
  max_units_per_day: 500,
  max_payload_bytes: 65536,
  max_checks: 100,
  max_reports: 20,
  max_callbacks_per_run: 100,
  max_timeout_ms: 86400000,
};

function fail(code, message, status = 400) {
  throw new DomainError(code, message, status);
}
function identity(value, label = 'Actor') {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    fail('UNAUTHENTICATED', label + ' identity is required', 401);
  return value;
}
function names(value, label, maximum = 100, allowEmpty = false) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && !value.length) ||
    value.length > maximum ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 200) ||
    new Set(value).size !== value.length
  )
    fail('INVALID_EVALUATOR', label + ' must be a bounded unique list');
  return [...value].sort();
}
function digest(value, label) {
  if (typeof value !== 'string' || !value || value.length > 200)
    fail('INVALID_EVALUATOR', label + ' must identify immutable configuration');
  return value;
}
function vector(value) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).length > 100 ||
    Object.entries(value).some(
      ([key, commit]) => !key || key.length > 200 || !oid.test(commit ?? ''),
    )
  )
    fail('INVALID_CANDIDATE', 'Exact repository commit vectors are required');
  return structuredClone(value);
}
function boundedText(value, limit = 1000) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

/**
 * Evaluations preserve immutable inputs and append lifecycle observations.
 * Credentials stay in the trusted adapter configuration, outside persisted state.
 * External services sign a platform-issued run and its full input vector; producer
 * reports remain declared observations and never satisfy integration policy.
 *
 * Mutating calls must run through Engine.serial() at the transport boundary.
 * Built-in dispatch retains that boundary until its bounded trusted runner returns;
 * external evaluations release it between signed callbacks and cancellations.
 */
export class Evaluators {
  constructor(engine, { services = {}, clock = () => Date.now(), limits = {} } = {}) {
    this.engine = engine;
    this.services = services;
    this.clock = clock;
    this.limits = { ...defaults, ...limits };
    for (const [key, value] of Object.entries(this.limits))
      if (!(key in defaults) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key])
        fail('INVALID_EVALUATOR_LIMIT', 'Evaluator limits can only tighten platform limits');
  }

  get state() {
    for (const key of [
      'evaluatorProfiles',
      'evaluatorBindings',
      'evaluationRuns',
      'evaluationEvents',
      'declaredReports',
    ])
      this.engine.state[key] ??= [];
    return this.engine.state;
  }

  object(collection, id) {
    const result = this.state[collection].find((item) => item.id === id);
    if (!result) fail('NOT_FOUND', 'Evaluation object not found', 404);
    return result;
  }

  candidate(id) {
    return this.engine.pipeline.object('candidateStates', id);
  }

  bindings() {
    const current = new Map();
    for (const binding of this.state.evaluatorBindings) current.set(binding.key, binding);
    return [...current.values()];
  }

  /**
   * Register an operator-owned configuration revision. Transport authorization
   * must restrict this endpoint to repository policy administrators.
   */
  async register(input, actor, principal = null) {
    identity(actor);
    const key = digest(input.key, 'Evaluator key');
    const repoIds = names(input.repo_ids, 'Repositories');
    repoIds.forEach((id) => this.engine.repo(id));
    if (this.engine.access) {
      if (principal?.actor_id !== actor)
        fail('UNAUTHENTICATED', 'Authenticated policy administrator is required', 401);
      await this.engine.access.require(principal, 'policy.write', repoIds);
    }
    if (!['builtin', 'external'].includes(input.mode))
      fail('INVALID_EVALUATOR', 'Use a trusted built-in or external evaluator');
    const requiredChecks = names(
      input.required_checks ?? [],
      'Required checks',
      this.limits.max_checks,
      input.mode === 'builtin',
    );
    const timeout = input.timeout_ms ?? 900000;
    const units = input.cost_units ?? 1;
    if (
      !Number.isSafeInteger(timeout) ||
      timeout < 1000 ||
      timeout > this.limits.max_timeout_ms ||
      !Number.isSafeInteger(units) ||
      units < 1 ||
      units > this.limits.max_units_per_day
    )
      fail('INVALID_EVALUATOR', 'Bounded timeout and evaluation units are required');
    const serviceId = input.mode === 'external' ? digest(input.service_id, 'Service') : null;
    if (serviceId) this.service(serviceId, repoIds);
    const profile = await record('evaluator-profile', {
      key,
      repo_ids: repoIds,
      mode: input.mode,
      config_hash: digest(input.config_hash, 'Evaluator configuration'),
      service_id: serviceId,
      required_checks: requiredChecks,
      required: input.required !== false,
      enabled: input.enabled !== false,
      timeout_ms: timeout,
      cost_units: units,
    });
    const current = this.bindings().find((binding) => binding.key === key);
    if (current?.profile_id === profile.id) return { profile, binding: current };
    const binding = await record('evaluator-binding', {
      key,
      profile_id: profile.id,
      previous: current?.id ?? null,
      actor,
      created_at: new Date(this.clock()).toISOString(),
    });
    if (!this.state.evaluatorProfiles.some((entry) => entry.id === profile.id))
      this.state.evaluatorProfiles.push(profile);
    this.state.evaluatorBindings.push(binding);
    await this.engine.audit('evaluator.configured', actor, {
      profile_id: profile.id,
      binding_id: binding.id,
    });
    await this.engine.save(this.state);
    return { profile, binding };
  }

  service(id, repoIds) {
    const service = this.services[id];
    if (
      !service ||
      typeof service.secret !== 'string' ||
      service.secret.length < 16 ||
      !Array.isArray(service.repo_ids) ||
      typeof service.key_id !== 'string' ||
      !service.key_id ||
      service.key_id.length > 200 ||
      repoIds.some((repo) => !service.repo_ids.includes(repo))
    )
      fail('EVALUATOR_SERVICE_UNAVAILABLE', 'A scoped trusted evaluator service is required', 503);
    return service;
  }

  latest(runId) {
    return this.state.evaluationEvents.filter((event) => event.run_id === runId).at(-1);
  }

  async pins(candidate, profile) {
    const repositories = candidate.repositories
      .map((repo) => ({ repo_id: repo.repo_id, commit: repo.commit, tree: repo.tree }))
      .sort((a, b) => a.repo_id.localeCompare(b.repo_id));
    if (
      !repositories.length ||
      repositories.length > 100 ||
      repositories.some((repo) => !oid.test(repo.commit ?? '') || !oid.test(repo.tree ?? ''))
    )
      fail('INVALID_CANDIDATE', 'Candidate commits and trees must be immutable');
    return {
      candidate_id: candidate.id,
      repositories,
      canonical_heads: vector(candidate.base_heads),
      dependency_heads: vector({
        ...candidate.base_heads,
        ...Object.fromEntries(repositories.map((repo) => [repo.repo_id, repo.commit])),
      }),
      constraint_versions: this.state.constraints
        .filter((constraint) => constraint.active)
        .map((constraint) => constraint.id)
        .sort(),
      validation_config_hash: digest(
        this.engine.git.configHash,
        'Trusted validation configuration',
      ),
      evaluator_profile_id: profile.id,
      evaluator_config_hash: profile.config_hash,
      service_id: profile.service_id,
      service_key_id: profile.service_id
        ? this.service(profile.service_id, profile.repo_ids).key_id
        : null,
    };
  }

  async validity(run, { sources = true, canonical_heads = null } = {}) {
    const reasons = [];
    const candidate = this.candidate(run.candidate_id);
    const profile = this.object('evaluatorProfiles', run.profile_id);
    const binding = this.bindings().find((entry) => entry.key === profile.key);
    if (binding?.profile_id !== profile.id || !profile.enabled)
      reasons.push('Evaluator configuration changed or is disabled.');
    try {
      if ((await hash(await this.pins(candidate, profile))) !== run.pins_hash)
        reasons.push('Candidate, constraint, dependency or validation inputs changed.');
    } catch (error) {
      if (error.code !== 'EVALUATOR_SERVICE_UNAVAILABLE') throw error;
      reasons.push('Trusted evaluator service is unavailable.');
    }
    const expectedHeads = canonical_heads ? vector(canonical_heads) : run.pins.canonical_heads;
    if (
      stable(Object.keys(expectedHeads).sort()) !==
      stable(Object.keys(run.pins.canonical_heads).sort())
    )
      fail('INVALID_EVALUATION_BASE', 'Recovery must preserve the complete dependency vector');
    for (const [repoId, commit] of Object.entries(expectedHeads)) {
      const repo = this.engine.repo(repoId);
      if (repo.unavailable || repo.head !== commit)
        reasons.push('Canonical dependency changed or is unavailable.');
    }
    if (sources && !(await this.engine.pipeline.sourceValidity(candidate.selection_ids)))
      reasons.push('Selected Future revision changed.');
    if (this.clock() >= Date.parse(run.expires_at)) reasons.push('Evaluation validity expired.');
    return { state: reasons.length ? 'stale' : 'current', reasons };
  }

  admission(profile) {
    const start = this.clock() - 86400000;
    const recent = this.state.evaluationRuns.filter((run) => Date.parse(run.created_at) >= start);
    const active = this.state.evaluationRuns.filter((run) => {
      const state = this.latest(run.id)?.state;
      return !terminal.has(state) && this.clock() < Date.parse(run.expires_at);
    });
    // Count current runs after request deduplication; historical completions use no slot.
    this.engine.access?.assertQuota('pending_runs', active.length);
    if (
      active.length >= this.limits.max_active_runs ||
      recent.length >= this.limits.max_runs_per_day ||
      recent.reduce((total, run) => total + run.cost_units, 0) + profile.cost_units >
        this.limits.max_units_per_day
    )
      fail('EVALUATION_BUDGET_EXCEEDED', 'Evaluation admission budget is exhausted', 429);
  }

  /** Persist a pending run before evaluation. A rerun always has a new identity. */
  async run(candidateId, input, actor) {
    identity(actor);
    const requestId = digest(input.request_id, 'Request');
    const profile = this.object('evaluatorProfiles', input.profile_id);
    const candidate = this.candidate(candidateId);
    const requestHash = await hash({ actor, request_id: requestId });
    const previous = this.state.evaluationRuns.find((run) => run.request_hash === requestHash);
    if (previous) {
      if (previous.candidate_id !== candidateId || previous.profile_id !== profile.id)
        fail('IDEMPOTENCY_CONFLICT', 'Evaluation request has different inputs', 409);
      return { run: previous, event: this.latest(previous.id) };
    }
    const binding = this.bindings().find((entry) => entry.key === profile.key);
    if (binding?.profile_id !== profile.id || !profile.enabled)
      fail('EVALUATOR_STALE', 'Use the current enabled evaluator configuration', 409);
    if (!candidate.repositories.every((repo) => profile.repo_ids.includes(repo.repo_id)))
      fail('EVALUATOR_SCOPE_MISMATCH', 'Evaluator must cover every candidate repository', 403);
    if (profile.mode === 'external') this.service(profile.service_id, profile.repo_ids);
    await this.engine.syncHeads();
    const pins = await this.pins(candidate, profile);
    if (
      Object.entries(pins.canonical_heads).some(([repo, head]) => {
        const current = this.engine.repo(repo);
        return current.head !== head || current.unavailable;
      }) ||
      !(await this.engine.pipeline.sourceValidity(candidate.selection_ids))
    )
      fail('CANDIDATE_STALE', 'Recompose from current source and canonical versions', 409);
    this.admission(profile);
    for (const repo of candidate.repositories) {
      const facts = await this.engine.git.facts(
        this.engine.repo(repo.repo_id),
        repo.commit,
        repo.commit,
      );
      if (facts.head !== repo.commit || facts.tree !== repo.tree)
        fail('CANDIDATE_TREE_MISMATCH', 'Git does not establish the candidate tree', 409);
    }
    const created = this.clock();
    const run = await record('evaluation', {
      request_hash: requestHash,
      candidate_id: candidateId,
      profile_id: profile.id,
      pins,
      pins_hash: await hash(pins),
      cost_units: profile.cost_units,
      actor,
      created_at: new Date(created).toISOString(),
      expires_at: new Date(created + profile.timeout_ms).toISOString(),
    });
    this.state.evaluationRuns.push(run);
    const event = await this.append(run, 'pending', actor);
    await this.engine.save(this.state);
    return { run, event };
  }

  async append(run, state, actor, extra = {}) {
    const event = await record('evaluation-event', {
      run_id: run.id,
      pins_hash: run.pins_hash,
      previous: this.latest(run.id)?.id ?? null,
      state,
      actor,
      created_at: new Date(this.clock()).toISOString(),
      ...extra,
    });
    this.state.evaluationEvents.push(event);
    await this.engine.audit('evaluation.' + state, actor, {
      run_id: run.id,
      event_id: event.id,
    });
    return event;
  }

  /** Delegate to the existing sandboxed adapter; this module never runs commands. */
  async dispatch(runId) {
    const run = this.object('evaluationRuns', runId);
    const profile = this.object('evaluatorProfiles', run.profile_id);
    if (profile.mode !== 'builtin')
      fail('EXTERNAL_EVALUATOR_REQUIRED', 'Deliver the issued run to its trusted service', 409);
    if (this.latest(run.id)?.state !== 'pending')
      fail('EVALUATION_NOT_PENDING', 'Evaluation has already started or completed', 409);
    await this.engine.syncHeads();
    if ((await this.validity(run)).state !== 'current')
      fail('EVALUATION_STALE', 'Evaluation inputs changed before execution', 409);
    await this.append(run, 'running', 'platform-owned evaluator');
    await this.engine.save(this.state);
    const evidence = [];
    let failed = false;
    try {
      for (const repository of run.pins.repositories) {
        const entry = await this.engine.validate(
          run.candidate_id + ':' + repository.repo_id,
          this.engine.repo(repository.repo_id),
          repository.tree,
          repository.commit,
          run.pins.canonical_heads,
          run.pins.dependency_heads,
        );
        evidence.push(entry);
        const checks = entry.result?.checks ?? [];
        if (
          !checks.length ||
          !validationPassed(entry) ||
          !profile.required_checks.every((id) =>
            checks.some((check) => (check.id ?? check.name) === id && check.passed === true),
          )
        )
          failed = true;
      }
    } catch {
      // Exceptions can include credentials or process output. Persist only a
      // bounded failure category, leaving operational logs at the trusted runner.
      failed = true;
    }
    if (this.latest(run.id)?.state === 'cancelled')
      return { run, event: this.latest(run.id), evidence };
    const event = await this.append(
      run,
      failed ? 'failed' : 'passing',
      'platform-owned evaluator',
      {
        evidence_ids: evidence.map((entry) => entry.id),
        claim: 'Only the listed finite checks on the pinned trees are established.',
      },
    );
    await this.engine.save(this.state);
    return { run, event, evidence };
  }

  async signature(runId, body, serviceId) {
    const run = this.object('evaluationRuns', runId);
    const profile = this.object('evaluatorProfiles', run.profile_id);
    if (profile.mode !== 'external' || profile.service_id !== serviceId)
      fail('UNAUTHENTICATED_EVALUATOR', 'Evaluation belongs to another service', 401);
    const service = this.service(serviceId, profile.repo_ids);
    const bytes = new TextEncoder().encode(stable({ run_id: runId, body }));
    if (bytes.length > this.limits.max_payload_bytes)
      fail('REPORT_TOO_LARGE', 'Evaluation report exceeds its byte budget', 413);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(service.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    return { bytes, key, run, profile };
  }

  normalizeResult(body, profile) {
    const checks = body.result?.checks;
    if (
      !Array.isArray(checks) ||
      checks.length > this.limits.max_checks ||
      checks.some((check) => !check || typeof check !== 'object' || Array.isArray(check)) ||
      new Set(checks.map((check) => check.id)).size !== checks.length ||
      checks.some(
        (check) =>
          typeof check.id !== 'string' ||
          !check.id ||
          check.id.length > 200 ||
          !['passing', 'failed', 'skipped'].includes(check.state),
      )
    )
      fail('INVALID_EVALUATION_REPORT', 'Bounded, uniquely identified check results are required');
    const normalized = checks.map((check) => ({
      id: check.id,
      state: check.state,
      passed: check.state === 'passing',
      summary: boundedText(check.summary),
    }));
    const reports = body.result?.reports ?? [];
    if (!Array.isArray(reports) || reports.length > this.limits.max_reports)
      fail('INVALID_EVALUATION_REPORT', 'Report metadata exceeds its count budget');
    const metadata = reports.map((report) => {
      if (!report || typeof report !== 'object' || Array.isArray(report))
        fail('INVALID_EVALUATION_REPORT', 'Structured report metadata is required');
      if (!['junit', 'sarif', 'benchmark', 'deployment'].includes(report.format))
        fail('INVALID_EVALUATION_REPORT', 'Unsupported report format');
      const counts = {};
      for (const key of ['tests', 'failures', 'errors', 'skipped', 'findings'])
        if (report[key] !== undefined) {
          if (!Number.isSafeInteger(report[key]) || report[key] < 0 || report[key] > 10000000)
            fail('INVALID_EVALUATION_REPORT', 'Report counts must be bounded nonnegative integers');
          counts[key] = report[key];
        }
      if (report.artifact_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(report.artifact_sha256))
        fail('INVALID_EVALUATION_REPORT', 'Artifact digest must be SHA-256');
      return {
        format: report.format,
        ...counts,
        ...(report.artifact_sha256 ? { artifact_sha256: report.artifact_sha256 } : {}),
      };
    });
    const passing =
      normalized.length > 0 &&
      normalized.every((check) => check.state === 'passing') &&
      profile.required_checks.every((id) =>
        normalized.some((check) => check.id === id && check.passed),
      ) &&
      metadata.every(
        (report) => !(report.failures > 0 || report.errors > 0 || report.findings > 0),
      );
    if (body.state === 'passing' && !passing)
      fail('INVALID_EVALUATION_REPORT', 'Passing requires every required independent check');
    return { passed: body.state === 'passing' && passing, checks: normalized, reports: metadata };
  }

  deployment(value, run) {
    if (value === undefined || value === null) return null;
    const target = run.pins.repositories.find((repo) => repo.repo_id === value.repo_id);
    if (
      !target ||
      value.commit !== target.commit ||
      value.tree !== target.tree ||
      typeof value.version !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(value.version) ||
      typeof value.url !== 'string' ||
      value.url.length > 2048
    )
      fail(
        'INVALID_EVALUATION_REPORT',
        'Deployment must pin an exact repository, tree and version',
      );
    let url;
    try {
      url = new URL(value.url);
    } catch {
      fail('INVALID_EVALUATION_REPORT', 'Deployment URL must be HTTPS');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      fail('INVALID_EVALUATION_REPORT', 'Deployment URLs must not carry credentials or query data');
    return {
      repo_id: target.repo_id,
      commit: target.commit,
      tree: target.tree,
      version: value.version,
      url: url.href,
      basis: 'observed',
      source: 'trusted evaluator service',
      claim: 'The service observed this deployment; klocgit did not provision it.',
    };
  }

  /**
   * Accept a callback signed by its configured repository-scoped service.
   * The signature covers stable({ run_id, body }); transport supplies credentials
   * separately from body. Duplicate event IDs cannot overwrite prior reports.
   */
  async report(runId, body, authentication = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      fail('INVALID_EVALUATION_REPORT', 'A structured evaluation callback is required');
    if (!/^[a-f0-9]{64}$/.test(authentication.signature ?? ''))
      fail('UNAUTHENTICATED_EVALUATOR', 'A trusted service signature is required', 401);
    const { bytes, key, run, profile } = await this.signature(
      runId,
      body,
      authentication.service_id,
    );
    if (this.service(profile.service_id, profile.repo_ids).key_id !== run.pins.service_key_id)
      fail('EVALUATOR_STALE', 'Evaluator credential version changed', 409);
    const signature = new Uint8Array(
      authentication.signature.match(/../g).map((value) => parseInt(value, 16)),
    );
    if (!(await crypto.subtle.verify('HMAC', key, signature, bytes)))
      fail('UNAUTHENTICATED_EVALUATOR', 'Evaluator signature is invalid', 401);
    if (
      body.run_id !== run.id ||
      body.pins_hash !== run.pins_hash ||
      (await hash(body.pins)) !== run.pins_hash
    )
      fail('EVALUATION_INPUT_MISMATCH', 'Callback must identify every issued immutable input', 409);
    const eventId = digest(body.event_id, 'Callback');
    const payloadHash = await hash(body);
    const prior = this.state.evaluationEvents.find(
      (event) => event.run_id === run.id && event.callback_id === eventId,
    );
    if (prior) {
      if (prior.payload_hash !== payloadHash)
        fail('IDEMPOTENCY_CONFLICT', 'Callback identity has conflicting contents', 409);
      return { run, event: prior, duplicate: true };
    }
    if (
      this.state.evaluationEvents.filter((event) => event.run_id === run.id && event.callback_id)
        .length >= this.limits.max_callbacks_per_run
    )
      fail('REPORT_BUDGET_EXCEEDED', 'Evaluation callback count budget is exhausted', 429);
    if (!acceptedStates.has(body.state))
      fail('INVALID_EVALUATION_REPORT', 'Unsupported callback state');
    if (terminal.has(this.latest(run.id)?.state))
      fail('EVALUATION_COMPLETE', 'Completed evaluations cannot accept a different callback', 409);
    if (this.clock() >= Date.parse(run.expires_at))
      fail('EVALUATION_EXPIRED', 'Evaluation callback deadline passed', 409);
    const result = body.state === 'running' ? null : this.normalizeResult(body, profile);
    const actor = 'evaluator-service:' + authentication.service_id;
    const evidence = result
      ? await record('evaluation-evidence', {
          subject_ref: run.candidate_id,
          run_id: run.id,
          profile_id: profile.id,
          type: 'evaluator-observation',
          config_hash: run.pins.validation_config_hash,
          constraint_versions: run.pins.constraint_versions,
          validity_heads: run.pins.canonical_heads,
          pins: run.pins,
          pins_hash: run.pins_hash,
          state: body.state,
          result,
          deployment: this.deployment(body.deployment, run),
          basis: 'observed',
          source: actor,
          created_at: new Date(this.clock()).toISOString(),
          claim: 'The trusted service reports only these checks for the exact pinned inputs.',
        })
      : null;
    if (evidence) this.state.evidence.push(evidence);
    const event = await this.append(run, body.state, actor, {
      callback_id: eventId,
      payload_hash: payloadHash,
      evidence_ids: evidence ? [evidence.id] : [],
    });
    await this.engine.save(this.state);
    return { run, event, evidence };
  }

  async cancel(runId, input, actor) {
    identity(actor);
    const run = this.object('evaluationRuns', runId);
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000)
      fail('INVALID_CANCELLATION', 'Record a bounded cancellation reason');
    const current = this.latest(run.id);
    if (current?.state === 'cancelled') return { run, event: current };
    if (terminal.has(current?.state))
      fail('EVALUATION_COMPLETE', 'Completed evaluations cannot be cancelled', 409);
    const event = await this.append(run, 'cancelled', actor, {
      reason: input.reason.trim(),
      claim: 'The result is ineligible; this does not claim that external execution stopped.',
    });
    await this.engine.save(this.state);
    return { run, event };
  }

  /** Retain producer observations separately, with no authority to pass policy. */
  async declaration(candidateId, input, actor) {
    identity(actor);
    const candidate = this.candidate(candidateId);
    if (new TextEncoder().encode(stable(input)).length > this.limits.max_payload_bytes)
      fail('REPORT_TOO_LARGE', 'Declared report exceeds its byte budget', 413);
    const declared = await record('declared-report', {
      candidate_id: candidate.id,
      basis: 'declared',
      actor,
      summary: boundedText(input.summary),
      created_at: new Date(this.clock()).toISOString(),
      claim: 'Producer observation; independent trusted validation remains required.',
    });
    this.state.declaredReports.push(declared);
    await this.engine.save(this.state);
    return { report: declared };
  }

  async review(candidateId, options = {}) {
    this.candidate(candidateId);
    await this.engine.syncHeads();
    const runs = [];
    for (const run of this.state.evaluationRuns.filter(
      (entry) => entry.candidate_id === candidateId,
    )) {
      const event = this.latest(run.id);
      const validity = await this.validity(run, options);
      runs.push({
        run,
        event,
        validity,
        state: validity.state === 'stale' ? 'stale' : event.state,
      });
    }
    return { candidate_id: candidateId, runs };
  }

  /** Include this snapshot in the reviewed decision basis before any Git write. */
  async eligibility(candidateId, options = {}) {
    const candidate = this.candidate(candidateId);
    const reviewed = await this.review(candidateId, options);
    const bindings = this.bindings().filter((binding) => {
      const profile = this.object('evaluatorProfiles', binding.profile_id);
      return (
        profile.enabled &&
        profile.required &&
        candidate.repositories.some((repo) => profile.repo_ids.includes(repo.repo_id))
      );
    });
    const reasons = [];
    const selected = [];
    for (const binding of bindings) {
      const profile = this.object('evaluatorProfiles', binding.profile_id);
      const latest = reviewed.runs.filter((entry) => entry.run.profile_id === profile.id).at(-1);
      selected.push({ binding, run: latest?.run ?? null, event: latest?.event ?? null });
      if (!candidate.repositories.every((repo) => profile.repo_ids.includes(repo.repo_id)))
        reasons.push('Required evaluator does not cover the candidate repository vector.');
      if (!latest || latest.state !== 'passing')
        reasons.push('The latest required evaluation is not current and passing.');
    }
    return {
      configured: bindings.length > 0,
      passing: bindings.length > 0 && reasons.length === 0,
      runs: reviewed.runs,
      reasons,
      basis: { candidate_id: candidateId, required_evaluations: selected },
    };
  }

  view() {
    return structuredClone({
      profiles: this.state.evaluatorProfiles,
      bindings: this.bindings(),
      runs: this.state.evaluationRuns,
      events: this.state.evaluationEvents,
      declarations: this.state.declaredReports,
    });
  }
}
