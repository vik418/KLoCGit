/** Trusted, registered checks evaluate isolated producer I/O, never producer verdicts. */
import { randomUUID } from 'node:crypto';
import { V1Error, assertSchemaVersion, parseDigest } from '../../core/v1/conventions.mjs';
import { copyJsonData } from '../../core/v1/domain.mjs';
import { digestCanonical, encodeCanonical } from '../../core/v1/encoding.mjs';
import {
  buildEvidence,
  candidateEvidenceSubject,
  evidenceRequirements,
} from '../../core/v1/evidence.mjs';
import { verifyCandidateContent } from '../../core/v1/promotion.mjs';

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

export class SandboxEvidenceProvider {
  #recipes = new Map();

  constructor({
    tenant_id,
    system_id,
    principal,
    authorize,
    materializer,
    sandbox,
    producer_identity,
    producer_version,
    environment_digest,
    recipes,
    payloadStore,
    evidenceStore,
    retention_class,
    now,
    max_payload_bytes,
  }) {
    for (const value of [tenant_id, system_id, producer_identity, producer_version])
      valid(typeof value === 'string' && value.trim());
    valid(typeof authorize === 'function' && typeof materializer?.open === 'function');
    valid(
      typeof sandbox?.run === 'function' && typeof sandbox?.readBrokeredResource === 'function',
    );
    valid(typeof payloadStore?.put === 'function' && typeof now === 'function');
    valid(typeof evidenceStore?.find === 'function' && typeof evidenceStore?.put === 'function');
    valid(typeof sandbox?.checkPayload === 'function');
    valid(Number.isSafeInteger(max_payload_bytes) && max_payload_bytes > 0);
    valid(['EPHEMERAL', 'REBUILDABLE', 'DECISION_RECORD', 'CANONICAL'].includes(retention_class));
    parseDigest(environment_digest);
    valid(Array.isArray(recipes));
    for (const recipe of recipes) {
      valid(typeof recipe?.evaluate === 'function');
      const configuration = freeze(copyJsonData(recipe.configuration));
      assertSchemaVersion(configuration);
      valid(
        typeof configuration.id === 'string' &&
          configuration.id.trim() &&
          typeof configuration.type === 'string',
      );
      valid(Array.isArray(configuration.brokered_resources));
      for (const resource of configuration.brokered_resources) {
        assertSchemaVersion(resource);
        valid(Object.keys(resource).length === 3 && typeof resource.resource_id === 'string');
        parseDigest(resource.digest, 'broker-resource');
      }
      valid(!this.#recipes.has(configuration.id));
      this.#recipes.set(configuration.id, {
        configuration,
        evaluate: recipe.evaluate.bind(recipe),
      });
    }
    Object.assign(this, {
      tenant_id,
      system_id,
      principal: freeze(copyJsonData(principal)),
      authorize,
      materializer,
      sandbox,
      producer_identity,
      producer_version,
      environment_digest,
      payloadStore,
      evidenceStore,
      retention_class,
      now,
      max_payload_bytes,
    });
  }

  async find_reusable(subject_digest, requirementsInput) {
    parseDigest(subject_digest);
    const requirements = evidenceRequirements(requirementsInput);
    const scope = freeze({
      schema_version: 1,
      tenant_id: this.tenant_id,
      system_id: this.system_id,
      action: 'evidence.read',
    });
    if (!this.principal?.actor_id) throw new V1Error('UNAUTHENTICATED');
    if ((await trustedCall(() => this.authorize(this.principal, scope))) !== true)
      throw new V1Error('FORBIDDEN');
    return freeze(
      copyJsonData(
        await trustedCall(() => this.evidenceStore.find(scope, subject_digest, requirements)),
      ),
    );
  }

  async evaluate(candidateInput, requirementsInput) {
    const candidateData = copyJsonData(candidateInput);
    const requirements = evidenceRequirements(requirementsInput);
    const candidate = await verifyCandidateContent(candidateData);
    const subject = await candidateEvidenceSubject(candidate);
    const scope = freeze({
      schema_version: 1,
      tenant_id: this.tenant_id,
      system_id: this.system_id,
      candidate_digest: candidate.digest,
      trace_id: randomUUID(),
    });
    if (!this.principal?.actor_id) throw new V1Error('UNAUTHENTICATED');
    if (
      (await trustedCall(() =>
        this.authorize(this.principal, freeze({ ...scope, action: 'evidence.evaluate' })),
      )) !== true
    )
      throw new V1Error('FORBIDDEN');
    const workspaces = new Map();
    for (const repoId of Object.keys(candidate.repo_tree_oids)) {
      if (
        (await trustedCall(() =>
          this.authorize(
            this.principal,
            freeze({ ...scope, repo_id: repoId, action: 'evidence.evaluate' }),
          ),
        )) !== true
      )
        throw new V1Error('FORBIDDEN');
      const workspace = await trustedCall(() => this.materializer.open(candidate, repoId));
      if (
        workspace?.identity?.repo_id !== repoId ||
        workspace.identity.commit_oid !== subject.repo_commit_oids[repoId] ||
        workspace.identity.tree_oid !== subject.repo_tree_oids[repoId]
      )
        throw new V1Error('INTEGRITY_MISMATCH');
      workspaces.set(repoId, workspace);
    }
    const records = [];
    for (const check of requirements.checks) {
      const recipe = this.#recipes.get(check.id);
      if (!recipe) throw new V1Error('UNSUPPORTED_CAPABILITY');
      const config_digest = await digestCanonical('evaluation-config', recipe.configuration);
      if (
        recipe.configuration.type !== check.type ||
        config_digest !== check.config_digest ||
        this.environment_digest !== check.environment_digest ||
        !check.producers.some(
          (producer) =>
            producer.identity === this.producer_identity &&
            producer.versions.includes(this.producer_version),
        )
      )
        throw new V1Error('POLICY_REJECTED');
      const operations = Object.freeze({
        run: (input) => this.sandbox.run(input, { workspaces, scope }),
        read_resource: (input) => {
          const request = copyJsonData(input);
          if (
            !recipe.configuration.brokered_resources.some(
              (resource) =>
                resource.resource_id === request.resource_id && resource.digest === request.digest,
            )
          )
            throw new V1Error('FORBIDDEN');
          return this.sandbox.readBrokeredResource(request, scope);
        },
      });
      // evaluate is installed trusted controller code. It receives no Git writer
      // or canonical credential, and cannot be supplied in a producer request.
      const result = freeze(
        copyJsonData(await trustedCall(() => recipe.evaluate(operations, candidate))),
      );
      assertSchemaVersion(result);
      valid(
        result.basis === 'OBSERVED' && ['PASSING', 'FAILED', 'CANCELLED'].includes(result.status),
      );
      valid(
        Array.isArray(result.claims) &&
          result.claims.length > 0 &&
          result.claims.every((claim) => typeof claim === 'string' && claim.trim()),
      );
      const payload = encodeCanonical(result);
      if (payload.length > this.max_payload_bytes) throw new V1Error('INCOMPLETE_ANALYSIS');
      await this.sandbox.checkPayload(payload);
      const payload_digest = await digestCanonical('evidence-payload', result);
      const stored = copyJsonData(
        await trustedCall(() =>
          this.payloadStore.put({
            schema_version: 1,
            scope,
            digest: payload_digest,
            bytes: payload.slice(),
            retention_class: this.retention_class,
            idempotency_key: parseDigest(payload_digest).hex,
          }),
        ),
      );
      assertSchemaVersion(stored);
      if (stored.digest !== payload_digest || typeof stored.ref !== 'string' || !stored.ref)
        throw new V1Error('INTEGRITY_MISMATCH');
      const evidence = await buildEvidence({
        schema_version: 1,
        subject_digest: subject.digest,
        type: check.type,
        producer_identity: this.producer_identity,
        producer_version: this.producer_version,
        config_digest,
        environment_digest: this.environment_digest,
        result,
        payload_ref: stored.ref,
        created_at: this.now(),
        retention_class: this.retention_class,
      });
      await trustedCall(() =>
        this.evidenceStore.put({
          schema_version: 1,
          scope,
          evidence,
          idempotency_key: evidence.id.split(':').at(-1),
        }),
      );
      records.push(evidence);
    }
    return Object.freeze(records);
  }
}
