/** Connect bounded analysis to authoritative review records. Git writes stay in promotion. */
import {
  V1Error,
  assertSchemaVersion,
  assertIdempotencyKey,
  operationId,
  objectId,
  parseObjectId,
} from './conventions.mjs';
import { copyJsonData, Decision, FutureRevision } from './domain.mjs';
import { coordinationScope, coordinationKey } from './coordination.mjs';
import { digestCanonical, encodeCanonical } from './encoding.mjs';
import { verifyCandidateSpec } from './reduction.mjs';
import { verifyEvidence } from './evidence.mjs';
import { appendAudit } from './audit.mjs';

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

async function trustedCall(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof V1Error) throw error;
    throw new V1Error('PROVIDER_UNAVAILABLE');
  }
}

export class ConvergenceService {
  constructor({
    store,
    workProvider,
    reducer,
    materializer,
    scheduler,
    formulator,
    observeRef,
    authorize,
    limits,
  }) {
    for (const [provider, method] of [
      [store, 'transaction'],
      [workProvider, 'current'],
      [reducer, 'reduce'],
      [materializer, 'materialize'],
      [scheduler, 'evaluate'],
      [formulator, 'formulate'],
    ])
      valid(typeof provider?.[method] === 'function');
    valid(typeof workProvider.payloadDigest === 'function');
    valid(typeof observeRef === 'function' && typeof authorize === 'function');
    const budget = copyJsonData(limits);
    assertSchemaVersion(budget);
    valid(Object.keys(budget).length === 5);
    for (const key of ['max_work_bytes', 'max_candidates', 'max_evidence', 'max_decisions'])
      valid(Number.isSafeInteger(budget[key]) && budget[key] > 0);
    Object.assign(this, {
      store,
      workProvider,
      reducer,
      materializer,
      scheduler,
      formulator,
      observeRef,
      authorize,
      limits: freeze(budget),
    });
  }

  async context(input, options, action) {
    const request = freeze(copyJsonData(input));
    assertSchemaVersion(request);
    const fields = ['schema_version', 'scope', 'idempotency_key', 'trace_id'];
    valid(
      Object.keys(request).length === fields.length &&
        fields.every((key) => Object.hasOwn(request, key)),
    );
    const scope = coordinationScope(request.scope);
    assertIdempotencyKey(request.idempotency_key);
    valid(
      typeof request.trace_id === 'string' &&
        request.trace_id.trim() &&
        request.trace_id.length <= 128 &&
        !/[\u0000-\u001f\u007f]/.test(request.trace_id),
    );
    const captured = freeze(copyJsonData(options));
    valid(captured && Object.keys(captured).length === 1);
    const principal = captured.principal;
    if (
      typeof principal?.actor_id !== 'string' ||
      !principal.actor_id.trim() ||
      principal.tenant_id !== scope.tenant_id
    )
      throw new V1Error('UNAUTHENTICATED');
    const context = freeze({ request, scope, principal });
    await this.checkAccess(context, action);
    return context;
  }

  async checkAccess(context, action, resource = {}) {
    if (
      (await trustedCall(() =>
        this.authorize(context.principal, freeze({ ...context.scope, action, ...resource })),
      )) !== true
    )
      throw new V1Error('FORBIDDEN');
  }

  async work(tx, context) {
    const input = freeze(
      copyJsonData(await trustedCall(() => this.workProvider.current(tx, context))),
    );
    assertSchemaVersion(input);
    const fields = [
      'schema_version',
      'context',
      'effects',
      'reduction_policy',
      'budget',
      'requirements',
      'canonical_ref_oids',
      'compositions',
    ];
    valid(
      Object.keys(input).length === fields.length &&
        fields.every((key) => Object.hasOwn(input, key)),
    );
    valid(Array.isArray(input.effects) && Array.isArray(input.compositions));
    if (encodeCanonical(input).length > this.limits.max_work_bytes)
      throw new V1Error('INCOMPLETE_ANALYSIS');
    for (const revision of input.context.revisions.map(FutureRevision)) {
      if (revision.system_id !== context.scope.system_id) throw new V1Error('FORBIDDEN');
      await this.checkAccess(context, 'repository.observe', {
        repo_id: revision.repo_id,
        ref: revision.ref,
      });
    }
    // A current-provider read is authoritative metadata, never a producer's API body.
    return { input, digest: await digestCanonical('convergence-work', input) };
  }

  async checkRefs(work, context) {
    for (const [repo_id, refs] of Object.entries(work.canonical_ref_oids)) {
      for (const [ref, oid] of Object.entries(refs)) {
        await this.checkAccess(context, 'repository.observe', { repo_id, ref });
        if ((await trustedCall(() => this.observeRef(repo_id, ref, context))) !== oid)
          throw new V1Error('STALE_BASIS');
      }
    }
  }

  async review(scopeInput, decision_id, options) {
    parseObjectId(decision_id, 'decision');
    const context = await this.context(
      {
        schema_version: 1,
        scope: scopeInput,
        idempotency_key: 'read-review',
        trace_id: 'read-review',
      },
      options,
      'decision.read',
    );
    return this.store.transaction(context.scope, async (tx) => {
      await this.checkAccess(context, 'decision.read');
      const record = await tx.get('review:' + decision_id);
      const decision = await tx.get('decision:' + decision_id);
      if (!record || !decision) throw new V1Error('NOT_FOUND');
      const work = await this.work(tx, context);
      if (work.digest !== record.work_digest) throw new V1Error('STALE_BASIS');
      await this.checkRefs(work.input, context);
      return { ...record.component, decision: Decision(decision) };
    });
  }

  async discover(input, options) {
    const context = await this.context(input, options, 'decision.discover');
    const id = await operationId({
      tenant_id: context.scope.tenant_id,
      resource_id: await coordinationKey(context.scope),
      action: 'decision.discover',
      idempotency_key: context.request.idempotency_key,
    });
    const request_digest = await digestCanonical('discovery-request', {
      schema_version: 1,
      scope: context.scope,
      actor_id: context.principal.actor_id,
      idempotency_key: context.request.idempotency_key,
    });
    const prior = await this.store.transaction(context.scope, async (tx) => {
      await this.checkAccess(context, 'decision.discover');
      const existing = await tx.get('discovery:' + id);
      if (existing) {
        if (existing.request_digest !== request_digest) throw new V1Error('IDEMPOTENCY_CONFLICT');
        return { existing: existing.result };
      }
      const work = await this.work(tx, context);
      await this.checkRefs(work.input, context);
      return work;
    });
    if (prior.existing) return prior.existing;
    const work = prior.input;
    // Expensive composition and checks never run inside an authoritative transaction.
    const reduction = await this.reducer.reduce(
      work.context.revisions,
      work.effects,
      work.reduction_policy,
      work.budget,
    );
    const specs = [
      ...new Map(
        (
          await Promise.all(
            [...reduction.candidate_specs, ...work.compositions].map(verifyCandidateSpec),
          )
        ).map((spec) => [spec.id, spec]),
      ).values(),
    ];
    if (specs.length > this.limits.max_candidates) throw new V1Error('INCOMPLETE_ANALYSIS');
    const candidates = [],
      evidenceById = new Map();
    for (const spec of specs) {
      const candidate = await this.materializer.materialize(spec, work.context);
      const report = await this.scheduler.evaluate(candidate, work.requirements);
      candidates.push(candidate);
      for (const evidence of report.evidence) evidenceById.set(evidence.id, evidence);
      if (evidenceById.size > this.limits.max_evidence) throw new V1Error('INCOMPLETE_ANALYSIS');
    }
    const selected = new Set(specs.flatMap((spec) => spec.selected_future_revisions));
    const effects = work.effects.filter((effect) => selected.has(effect.future_revision_id));
    const formulated = await this.formulator.formulate({
      schema_version: 1,
      candidate_specs: specs,
      candidates,
      effects,
      targets: Object.fromEntries(
        [...selected].map((revision) => [revision, work.context.bindings[revision].repo_id]),
      ),
      evidence: [...evidenceById.values()],
      canonical_ref_oids: work.canonical_ref_oids,
      requirements: work.requirements,
    });
    if (formulated.decisions.length > this.limits.max_decisions)
      throw new V1Error('INCOMPLETE_ANALYSIS');
    const components = [];
    for (const component of formulated.decisions) {
      // Each reviewed basis gets its own durable Decision. A policy/evidence refresh
      // cannot overwrite the history of a previously accepted choice.
      const decision_id = objectId(
        'decision',
        await digestCanonical('object-decision', {
          schema_version: 1,
          component_id: component.decision.id,
          basis_digest: component.decision.basis.digest,
        }),
      );
      components.push({
        ...component,
        decision: Decision({ ...component.decision, id: decision_id }),
      });
    }
    const result = freeze({
      schema_version: 1,
      discovery_id: id,
      work_digest: prior.digest,
      ...formulated,
      decisions: components,
      reduction,
    });
    return this.store.transaction(context.scope, async (tx) => {
      await this.checkAccess(context, 'decision.discover');
      const existing = await tx.get('discovery:' + id);
      if (existing) {
        if (existing.request_digest !== request_digest) throw new V1Error('IDEMPOTENCY_CONFLICT');
        return existing.result;
      }
      if ((await this.work(tx, context)).digest !== prior.digest) throw new V1Error('STALE_BASIS');
      await this.checkRefs(work, context);
      for (const component of components) {
        const decision = component.decision;
        const previous = await tx.get('decision:' + decision.id);
        if (!previous) await tx.put('decision:' + decision.id, decision);
        await tx.put('review:' + decision.id, {
          schema_version: 1,
          component,
          work_digest: prior.digest,
          requirements: work.requirements,
          effects: effects.filter((effect) =>
            component.alternatives.some((alternative) =>
              alternative.selected_future_revisions.includes(effect.future_revision_id),
            ),
          ),
          candidates: candidates.filter((candidate) =>
            decision.basis.candidate_digests.includes(candidate.digest),
          ),
        });
      }
      await tx.put('discovery:' + id, { schema_version: 1, request_digest, result });
      await appendAudit(tx, context.scope, {
        schema_version: 1,
        event_key: id.split(':').at(-1),
        actor_id: context.principal.actor_id,
        trace_id: context.request.trace_id,
        action: 'decision.discover',
        subject_id: id,
        operation_id: id,
        from_state: null,
        to_state: 'REVIEWABLE',
        failure_class: null,
        bindings: { work_digest: prior.digest },
      });
      return result;
    });
  }

  /** BasisProvider contract used by both ResolutionService and PromotionService. */
  current = async (tx, context) => {
    const scope = coordinationScope(context.scope ?? context.request.scope);
    const checked = { ...context, scope };
    await this.checkAccess(checked, 'decision.read');
    const record = await tx.get('review:' + context.request.decision_id);
    if (!record) throw new V1Error('NOT_FOUND');
    if ((await this.work(tx, checked)).digest !== record.work_digest)
      throw new V1Error('STALE_BASIS');
    const candidate = record.candidates.find(
      (entry) => entry.digest === context.request.candidate_digest,
    );
    if (!candidate) throw new V1Error('INTEGRITY_MISMATCH');
    const evidence_payloads = [];
    for (const report of record.component.evidence) {
      const evidence = (await verifyEvidence(report.evidence)).evidence;
      const payload_digest = await trustedCall(() =>
        this.workProvider.payloadDigest(tx, evidence, checked),
      );
      evidence_payloads.push({ schema_version: 1, evidence, payload_digest });
    }
    return freeze({
      basis: record.component.decision.basis,
      candidate,
      target_commit_oid:
        candidate.materialization_record.repo_commit_oids?.[scope.resource_id.repo_id],
      subject: candidate,
      effects: record.effects,
      evidence_payloads,
      requirements: record.requirements,
      evidence: record.component.evidence.map((report) => report.evidence),
    });
  };
}
