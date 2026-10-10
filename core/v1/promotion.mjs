/** Durable authorization and recovery for a single canonical Git ref. */
import {
  V1Error,
  assertSchemaVersion,
  assertIdempotencyKey,
  parseDigest,
  parseObjectId,
  operationId,
} from './conventions.mjs';
import { Candidate, Decision, copyJsonData, gitOid, gitRef } from './domain.mjs';
import { coordinationScope } from './coordination.mjs';
import { digestCanonical } from './encoding.mjs';
import { resolveDecision, verifyDecisionBasis } from './decisions.mjs';
import { gitSnapshot } from './git-store.mjs';

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function requestSnapshot(input) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  const fields = [
    'schema_version',
    'tenant_id',
    'system_id',
    'repo_id',
    'ref',
    'decision_id',
    'basis_digest',
    'candidate_digest',
    'expected_oid',
    'idempotency_key',
  ];
  valid(
    Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)),
  );
  for (const key of ['tenant_id', 'system_id', 'repo_id'])
    valid(typeof value[key] === 'string' && value[key].trim().length > 0);
  gitRef(value.ref);
  gitOid(value.expected_oid);
  parseObjectId(value.decision_id, 'decision');
  parseDigest(value.basis_digest, 'decision-basis');
  parseDigest(value.candidate_digest, 'object-candidate');
  assertIdempotencyKey(value.idempotency_key);
  return freeze(value);
}

const terminalStates = ['APPLIED', 'REJECTED', 'OBSERVED_TARGET', 'EXTERNAL_MOVEMENT'];

/** Validate content identity; copied self IDs never prove an unchanged Candidate. */
export async function verifyCandidateContent(input) {
  const candidate = Candidate(input);
  const projection = { ...candidate };
  delete projection.id;
  delete projection.digest;
  if ((await digestCanonical('object-candidate', projection)) !== candidate.digest)
    throw new V1Error('INTEGRITY_MISMATCH');
  return candidate;
}

function receipt(record) {
  return freeze({
    schema_version: 1,
    operation_id: record.id,
    state: record.state,
    decision_id: record.request.decision_id,
    target_oid: record.target_commit_oid,
    observed_oid: record.observed_oid,
    write_acknowledged: record.state === 'APPLIED',
    failure_code: record.failure_code,
  });
}

/**
 * Decisions and policy inputs share this ref's authoritative transaction.
 * basisProvider.current must read current metadata through the supplied tx;
 * cached projections or producer-supplied authorization are not valid providers.
 * observeSnapshot reads exact Git commit/tree identity outside untrusted execution.
 */
export class PromotionService {
  constructor({ store, gitStore, observeSnapshot, basisProvider, policyEvaluator, authorize }) {
    valid(typeof store?.transaction === 'function');
    valid(
      typeof gitStore?.observe_ref === 'function' &&
        typeof gitStore?.compare_and_swap_ref === 'function',
    );
    valid(typeof observeSnapshot === 'function' && typeof basisProvider?.current === 'function');
    valid(typeof authorize === 'function');
    valid(
      typeof policyEvaluator?.required_analysis === 'function' &&
        typeof policyEvaluator?.can_resolve === 'function',
    );
    this.store = store;
    this.git = gitStore;
    this.observeSnapshot = observeSnapshot;
    this.current = basisProvider.current.bind(basisProvider);
    this.policy = Object.freeze({
      required_analysis: policyEvaluator.required_analysis.bind(policyEvaluator),
      can_resolve: policyEvaluator.can_resolve.bind(policyEvaluator),
    });
    this.authorize = authorize;
  }

  async context(input, options, action) {
    const request = requestSnapshot(input);
    const configuration = freeze(copyJsonData(options));
    valid(
      configuration &&
        Object.keys(configuration).length === 1 &&
        Object.hasOwn(configuration, 'principal'),
    );
    const principal = configuration.principal;
    if (!principal || typeof principal.actor_id !== 'string' || !principal.actor_id.trim())
      throw new V1Error('UNAUTHENTICATED');
    if ((await this.authorize(principal, freeze({ ...request, action }))) !== true)
      throw new V1Error('FORBIDDEN');
    const scope = coordinationScope({
      schema_version: 1,
      tenant_id: request.tenant_id,
      system_id: request.system_id,
      kind: 'REF',
      resource_id: { repo_id: request.repo_id, ref: request.ref },
    });
    const resource_id = await digestCanonical('canonical-resource', scope);
    const id = await operationId({
      tenant_id: request.tenant_id,
      resource_id,
      action: 'canonical.promote',
      idempotency_key: request.idempotency_key,
    });
    const request_digest = await digestCanonical('promotion-request', {
      request,
      actor_id: principal.actor_id,
    });
    return freeze({ request, principal, scope, id, request_digest });
  }

  async authorizeState(tx, context) {
    const { request, scope, principal } = context;
    if (
      (await this.authorize(principal, freeze({ ...request, action: 'canonical.promote' }))) !==
      true
    )
      throw new V1Error('FORBIDDEN');
    const stored = await tx.get('decision:' + request.decision_id);
    if (!stored) throw new V1Error('NOT_FOUND');
    const decision = Decision(stored);
    if (decision.id !== request.decision_id) throw new V1Error('INTEGRITY_MISMATCH');
    const state = freeze(
      copyJsonData(await this.current(tx, freeze({ scope, request, principal }))),
    );
    const basis = await verifyDecisionBasis(state.basis);
    const candidate = await verifyCandidateContent(state.candidate);
    // This operation owns one ref. Coordinated multi-repository acceptance
    // requires a separate operation journal and exact SystemRevision.
    if (
      Object.keys(basis.canonical_ref_oids).length !== 1 ||
      Object.values(basis.canonical_ref_oids).some((refs) => Object.keys(refs).length !== 1) ||
      Object.keys(candidate.repo_tree_oids).length !== 1
    ) {
      throw new V1Error('UNSUPPORTED_CAPABILITY');
    }
    if (basis.digest !== request.basis_digest) throw new V1Error('STALE_BASIS');
    if (
      candidate.digest !== request.candidate_digest ||
      !basis.candidate_digests.includes(candidate.digest)
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    if (basis.canonical_ref_oids[request.repo_id]?.[request.ref] !== request.expected_oid)
      throw new V1Error('STALE_BASIS');
    gitOid(state.target_commit_oid, request.expected_oid.length);
    const snapshot = gitSnapshot(
      await this.observeSnapshot(request.repo_id, state.target_commit_oid),
    );
    if (
      snapshot.repo_id !== request.repo_id ||
      snapshot.commit_oid !== state.target_commit_oid ||
      snapshot.tree_oid !== candidate.repo_tree_oids[request.repo_id]
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    const authorizedDecision = await resolveDecision(decision, basis, {
      policyEvaluator: this.policy,
      subject: state.subject,
      effects: state.effects,
      expectedBasisDigest: request.basis_digest,
      resolution: {
        candidate_digest: candidate.digest,
        actor_id: principal.actor_id,
        operation_id: context.id,
      },
    });
    if ((await this.git.observe_ref(request.repo_id, request.ref)) !== request.expected_oid)
      throw new V1Error('STALE_BASIS');
    return freeze({
      authorized_decision: authorizedDecision,
      target_commit_oid: snapshot.commit_oid,
      tree_oid: snapshot.tree_oid,
    });
  }

  matchRequest(record, context) {
    if (record.request_digest !== context.request_digest) throw new V1Error('IDEMPOTENCY_CONFLICT');
    return record;
  }

  async finish(tx, record, state, { observed_oid = null, failure_code = null } = {}) {
    const next = { ...record, state, observed_oid, failure_code };
    await tx.put('promotion:' + record.id, next);
    if (terminalStates.includes(state)) await tx.delete('canonical:active-promotion');
    if (['APPLIED', 'OBSERVED_TARGET'].includes(state)) {
      const current = Decision(await tx.get('decision:' + record.request.decision_id));
      // Recovery restores a prepared transition only while its source snapshot
      // remains current; it never overwrites a later review or stale transition.
      if (current.state === 'RESOLVABLE' && current.basis.digest === record.request.basis_digest)
        await tx.put('decision:' + current.id, record.authorized_decision);
    }
    return next;
  }

  async promote(input, options) {
    const context = await this.context(input, options, 'canonical.promote');
    const prepared = await this.store.transaction(context.scope, async (tx) => {
      const existing = await tx.get('promotion:' + context.id);
      if (existing) return { owner: false, record: this.matchRequest(existing, context) };
      if (await tx.get('canonical:active-promotion')) throw new V1Error('OUTCOME_UNKNOWN');
      const authorization = await this.authorizeState(tx, context);
      const record = {
        schema_version: 1,
        id: context.id,
        request_digest: context.request_digest,
        request: context.request,
        actor_id: context.principal.actor_id,
        state: 'PREPARED',
        observed_oid: null,
        failure_code: null,
        ...authorization,
      };
      await tx.put('promotion:' + context.id, record);
      await tx.put('canonical:active-promotion', { schema_version: 1, operation_id: context.id });
      return { owner: true, record };
    });
    if (!prepared.owner) return this.result(prepared.record);
    // The prepared journal has committed before any write can begin.
    let outcome;
    try {
      outcome = await this.store.transaction(context.scope, async (tx) => {
        const record = this.matchRequest(await tx.get('promotion:' + context.id), context);
        if (record.state !== 'PREPARED') return record;
        const active = await tx.get('canonical:active-promotion');
        if (active?.operation_id !== record.id) throw new V1Error('OUTCOME_UNKNOWN');
        let authorization;
        try {
          authorization = await this.authorizeState(tx, context);
          if (
            authorization.target_commit_oid !== record.target_commit_oid ||
            authorization.tree_oid !== record.tree_oid
          )
            throw new V1Error('INTEGRITY_MISMATCH');
        } catch (error) {
          return this.finish(tx, record, 'REJECTED', {
            failure_code: error instanceof V1Error ? error.code : 'PROVIDER_UNAVAILABLE',
          });
        }
        if (record.target_commit_oid === context.request.expected_oid)
          return this.finish(tx, record, 'OBSERVED_TARGET', {
            observed_oid: record.target_commit_oid,
          });
        try {
          const updated = await this.git.compare_and_swap_ref(
            context.request.ref,
            context.request.expected_oid,
            record.target_commit_oid,
            { idempotency_key: context.request.idempotency_key },
          );
          if (updated !== true)
            return this.finish(tx, record, 'REJECTED', { failure_code: 'STALE_BASIS' });
          return this.finish(tx, record, 'APPLIED', { observed_oid: record.target_commit_oid });
        } catch {
          return this.finish(tx, record, 'UNKNOWN', { failure_code: 'OUTCOME_UNKNOWN' });
        }
      });
    } catch {
      // A storage failure after Git success leaves the committed PREPARED record.
      // Replaying that write cannot establish its outcome; recovery reads Git.
      throw new V1Error('OUTCOME_UNKNOWN');
    }
    return this.result(outcome);
  }

  result(record) {
    if (record.state === 'REJECTED') throw new V1Error(record.failure_code);
    if (!terminalStates.includes(record.state)) throw new V1Error('OUTCOME_UNKNOWN');
    return receipt(record);
  }

  async reconcile(input, options) {
    const context = await this.context(input, options, 'canonical.reconcile');
    const outcome = await this.store.transaction(context.scope, async (tx) => {
      const stored = await tx.get('promotion:' + context.id);
      if (!stored) throw new V1Error('NOT_FOUND');
      const record = this.matchRequest(stored, context);
      if (terminalStates.includes(record.state)) return record;
      const active = await tx.get('canonical:active-promotion');
      if (active?.operation_id !== record.id) throw new V1Error('OUTCOME_UNKNOWN');
      const observed = await this.git.observe_ref(context.request.repo_id, context.request.ref);
      if (observed === record.target_commit_oid && observed !== context.request.expected_oid) {
        const snapshot = gitSnapshot(await this.observeSnapshot(context.request.repo_id, observed));
        if (
          snapshot.repo_id !== context.request.repo_id ||
          snapshot.commit_oid !== observed ||
          snapshot.tree_oid !== record.tree_oid
        )
          throw new V1Error('INTEGRITY_MISMATCH');
        // This establishes authorized state is present, not which writer installed it.
        return this.finish(tx, record, 'OBSERVED_TARGET', { observed_oid: observed });
      }
      if (observed !== context.request.expected_oid)
        return this.finish(tx, record, 'EXTERNAL_MOVEMENT', { observed_oid: observed });
      // The unchanged ref cannot prove an earlier remote write has stopped.
      // Keep the operation blocked until an observation can settle it.
      return this.finish(tx, record, 'UNKNOWN', {
        observed_oid: observed,
        failure_code: 'OUTCOME_UNKNOWN',
      });
    });
    return this.result(outcome);
  }
}
