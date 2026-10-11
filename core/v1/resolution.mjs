/** Persist a reviewed choice. Canonical Git promotion remains a separate CAS operation. */
import {
  V1Error,
  assertSchemaVersion,
  assertIdempotencyKey,
  parseDigest,
  parseObjectId,
  operationId,
} from './conventions.mjs';
import { Decision, copyJsonData } from './domain.mjs';
import { coordinationScope, coordinationKey } from './coordination.mjs';
import { digestCanonical, encodeCanonical } from './encoding.mjs';
import { makeResolvable, resolveDecision, verifyDecisionBasis } from './decisions.mjs';
import { verifyCandidateContent } from './promotion.mjs';
import { verifyEvidence } from './evidence.mjs';

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

function same(left, right) {
  const bytes = encodeCanonical(left),
    other = encodeCanonical(right);
  return bytes.length === other.length && bytes.every((byte, index) => byte === other[index]);
}

async function trustedCall(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof V1Error) throw error;
    throw new V1Error('PROVIDER_UNAVAILABLE');
  }
}

function snapshot(input) {
  const request = copyJsonData(input);
  assertSchemaVersion(request);
  const fields = [
    'schema_version',
    'scope',
    'decision_id',
    'basis_digest',
    'candidate_digest',
    'canonical_ref_oids',
    'idempotency_key',
    'trace_id',
  ];
  valid(
    Object.keys(request).length === fields.length &&
      fields.every((key) => Object.hasOwn(request, key)),
  );
  request.scope = coordinationScope(request.scope);
  parseObjectId(request.decision_id, 'decision');
  parseDigest(request.basis_digest, 'decision-basis');
  parseDigest(request.candidate_digest, 'object-candidate');
  assertIdempotencyKey(request.idempotency_key);
  valid(
    typeof request.trace_id === 'string' &&
      request.trace_id.trim() &&
      request.trace_id.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(request.trace_id),
  );
  valid(
    request.canonical_ref_oids &&
      typeof request.canonical_ref_oids === 'object' &&
      !Array.isArray(request.canonical_ref_oids),
  );
  return freeze(request);
}

/**
 * basisProvider.current reads authoritative inputs through tx. It supplies the
 * selected Candidate and all reviewed Evidence payload bindings, not a cache.
 * Payload pins happen outside the Decision transaction; failed attempts may
 * retain extra payloads but can never leave accepted history unprotected.
 */
export class ResolutionService {
  constructor({
    store,
    basisProvider,
    policyEvaluator,
    observeRef,
    payloadStore,
    authorize,
    max_evidence,
  }) {
    valid(typeof store?.transaction === 'function' && typeof basisProvider?.current === 'function');
    valid(
      typeof observeRef === 'function' &&
        typeof payloadStore?.pin === 'function' &&
        typeof authorize === 'function',
    );
    valid(
      typeof policyEvaluator?.required_analysis === 'function' &&
        typeof policyEvaluator?.can_resolve === 'function',
    );
    valid(Number.isSafeInteger(max_evidence) && max_evidence > 0);
    Object.assign(this, {
      store,
      current: basisProvider.current.bind(basisProvider),
      observeRef,
      payloadStore,
      authorize,
      max_evidence,
      policy: Object.freeze({
        required_analysis: policyEvaluator.required_analysis.bind(policyEvaluator),
        can_resolve: policyEvaluator.can_resolve.bind(policyEvaluator),
      }),
    });
  }

  async #authorize(context, action, resource = {}) {
    if (
      (await trustedCall(() =>
        this.authorize(
          context.principal,
          freeze({
            ...context.request.scope,
            decision_id: context.request.decision_id,
            action,
            ...resource,
          }),
        ),
      )) !== true
    )
      throw new V1Error('FORBIDDEN');
  }

  async #context(input, options) {
    const request = snapshot(input);
    const captured = freeze(copyJsonData(options));
    valid(captured && Object.keys(captured).length === 1 && Object.hasOwn(captured, 'principal'));
    if (typeof captured.principal?.actor_id !== 'string' || !captured.principal.actor_id.trim())
      throw new V1Error('UNAUTHENTICATED');
    const context = { request, principal: captured.principal };
    await this.#authorize(context, 'decision.resolve');
    const id = await operationId({
      tenant_id: request.scope.tenant_id,
      resource_id: await coordinationKey(request.scope),
      action: 'decision.resolve',
      idempotency_key: request.idempotency_key,
    });
    const { trace_id, ...binding } = request;
    valid(trace_id);
    const request_digest = await digestCanonical('resolution-request', {
      request: binding,
      actor_id: captured.principal.actor_id,
    });
    return freeze({ ...context, id, request_digest });
  }

  async #existing(tx, context) {
    const record = await tx.get('resolution:' + context.id);
    if (!record) return null;
    if (record.request_digest !== context.request_digest) throw new V1Error('IDEMPOTENCY_CONFLICT');
    return Decision(record.decision);
  }

  async #checked(tx, context) {
    await this.#authorize(context, 'decision.resolve');
    const { request } = context;
    const stored = await tx.get('decision:' + request.decision_id);
    if (!stored) throw new V1Error('NOT_FOUND');
    const decision = Decision(stored);
    if (decision.id !== request.decision_id) throw new V1Error('INTEGRITY_MISMATCH');
    if (decision.state === 'STALE') throw new V1Error('STALE_BASIS');
    if (!['REVIEWABLE', 'RESOLVABLE'].includes(decision.state)) throw new V1Error('CONFLICT');
    const state = freeze(copyJsonData(await trustedCall(() => this.current(tx, context))));
    const basis = await verifyDecisionBasis(state.basis);
    if (
      basis.digest !== request.basis_digest ||
      decision.basis.digest !== basis.digest ||
      !same(basis.canonical_ref_oids, request.canonical_ref_oids)
    )
      throw new V1Error('STALE_BASIS');
    const candidate = await verifyCandidateContent(state.candidate);
    if (
      candidate.digest !== request.candidate_digest ||
      !basis.candidate_digests.includes(candidate.digest)
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    for (const repo of Object.keys(candidate.repo_tree_oids))
      valid(Object.hasOwn(basis.canonical_ref_oids, repo));
    for (const [repo_id, refs] of Object.entries(basis.canonical_ref_oids)) {
      for (const [ref, oid] of Object.entries(refs)) {
        await this.#authorize(context, 'repository.observe', { repo_id, ref });
        const current = await trustedCall(() => this.observeRef(repo_id, ref, context));
        if (current !== oid) throw new V1Error('STALE_BASIS');
      }
    }
    valid(Array.isArray(state.evidence_payloads));
    if (state.evidence_payloads.length > this.max_evidence)
      throw new V1Error('INCOMPLETE_ANALYSIS');
    const payloads = [],
      digests = new Set();
    for (const payload of state.evidence_payloads) {
      assertSchemaVersion(payload);
      valid(Object.keys(payload).length === 3);
      parseDigest(payload.payload_digest, 'evidence-payload');
      const verified = await verifyEvidence(payload.evidence);
      if (!basis.evidence_digests.includes(verified.digest) || digests.has(verified.digest))
        throw new V1Error('INTEGRITY_MISMATCH');
      digests.add(verified.digest);
      payloads.push({
        schema_version: 1,
        digest: payload.payload_digest,
        payload_ref: verified.evidence.payload_ref,
      });
    }
    if (digests.size !== basis.evidence_digests.length) throw new V1Error('INCOMPLETE_ANALYSIS');
    const dependencies = {
      policyEvaluator: this.policy,
      subject: state.subject,
      effects: state.effects,
    };
    const resolvable =
      decision.state === 'REVIEWABLE'
        ? await makeResolvable(decision, basis, dependencies)
        : decision;
    const resolved = await resolveDecision(resolvable, basis, {
      ...dependencies,
      expectedBasisDigest: request.basis_digest,
      resolution: {
        candidate_digest: candidate.digest,
        actor_id: context.principal.actor_id,
        operation_id: context.id,
      },
    });
    return freeze({
      decision: resolved,
      from_state: decision.state,
      payloads: payloads.sort((a, b) =>
        a.digest < b.digest
          ? -1
          : a.digest > b.digest
            ? 1
            : a.payload_ref.localeCompare(b.payload_ref),
      ),
    });
  }

  async resolve(input, options) {
    const context = await this.#context(input, options);
    const prepared = await this.store.transaction(context.request.scope, async (tx) => {
      await this.#authorize(context, 'decision.resolve');
      const existing = await this.#existing(tx, context);
      return existing ? { existing } : this.#checked(tx, context);
    });
    if (prepared.existing) return prepared.existing;
    for (const payload of prepared.payloads)
      await trustedCall(() =>
        this.payloadStore.pin({
          ...payload,
          scope: {
            schema_version: 1,
            tenant_id: context.request.scope.tenant_id,
            system_id: context.request.scope.system_id,
          },
          reference_id: context.request.decision_id,
        }),
      );
    // Another actor, policy update or Git push may have intervened while pins
    // were acquired. Recompute eligibility rather than trusting preparation.
    return this.store.transaction(context.request.scope, async (tx) => {
      await this.#authorize(context, 'decision.resolve');
      const existing = await this.#existing(tx, context);
      if (existing) return existing;
      const checked = await this.#checked(tx, context);
      if (!same(prepared.payloads, checked.payloads)) throw new V1Error('STALE_BASIS');
      await tx.put('decision:' + checked.decision.id, checked.decision);
      await tx.put('resolution:' + context.id, {
        schema_version: 1,
        id: context.id,
        trace_id: context.request.trace_id,
        request_digest: context.request_digest,
        actor_id: context.principal.actor_id,
        state: 'APPLIED',
        from_state: checked.from_state,
        decision: checked.decision,
      });
      return checked.decision;
    });
  }
}
