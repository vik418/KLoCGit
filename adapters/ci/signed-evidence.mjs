/** Detached CI receipts from registered evaluators; source code claims are not receipts. */
import { V1Error, assertSchemaVersion, parseDigest } from '../../core/v1/conventions.mjs';
import { copyJsonData } from '../../core/v1/domain.mjs';
import { digestCanonical, encodeCanonical } from '../../core/v1/encoding.mjs';
import { buildEvidence, evidenceSubject, verifyEvidence } from '../../core/v1/evidence.mjs';
import { gitSnapshot } from '../../core/v1/git-store.mjs';

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

function text(value) {
  valid(typeof value === 'string' && value.trim().length > 0);
}

function decode(value, size) {
  valid(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
      char.charCodeAt(0),
    );
  } catch {
    throw new V1Error('INVALID_ARGUMENT');
  }
  valid(bytes.length === size);
  const canonical = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  valid(canonical === value);
  return bytes;
}

function receipt(input, signed = true) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  const fields = [
    'schema_version',
    'issuer',
    'key_id',
    'observation',
    ...(signed ? ['signature'] : []),
  ];
  valid(
    Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)),
  );
  text(value.issuer);
  text(value.key_id);
  if (signed) decode(value.signature, 64);
  const observation = value.observation;
  assertSchemaVersion(observation);
  valid(Object.keys(observation).length === 11);
  for (const key of ['tenant_id', 'system_id', 'run_id', 'type', 'payload_ref', 'created_at'])
    text(observation[key]);
  parseDigest(observation.config_digest);
  parseDigest(observation.environment_digest);
  valid(Array.isArray(observation.sources) && observation.sources.length > 0);
  observation.sources = observation.sources
    .map(gitSnapshot)
    .sort((a, b) => (a.repo_id < b.repo_id ? -1 : 1));
  valid(
    new Set(observation.sources.map(({ repo_id }) => repo_id)).size === observation.sources.length,
  );
  return freeze(value);
}

/** Publishers and verifiers use this domain-separated deterministic CBOR frame. */
export function ciReceiptSigningBytes(input) {
  return encodeCanonical({ domain: 'klocgit-external-ci-v1', receipt: receipt(input, false) });
}

async function trustedCall(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof V1Error) throw error;
    throw new V1Error('PROVIDER_UNAVAILABLE');
  }
}

export class ExternalCIReceiptAdapter {
  constructor({
    tenant_id,
    system_id,
    resolveEvaluator,
    observeSnapshot,
    authorize,
    retention_class,
    max_receipt_bytes,
  }) {
    text(tenant_id);
    text(system_id);
    valid(
      typeof resolveEvaluator === 'function' &&
        typeof observeSnapshot === 'function' &&
        typeof authorize === 'function',
    );
    valid(['EPHEMERAL', 'REBUILDABLE', 'DECISION_RECORD', 'CANONICAL'].includes(retention_class));
    valid(Number.isSafeInteger(max_receipt_bytes) && max_receipt_bytes > 0);
    Object.assign(this, {
      tenant_id,
      system_id,
      resolveEvaluator,
      observeSnapshot,
      authorize,
      retention_class,
      max_receipt_bytes,
    });
  }

  async ingest(input, options) {
    const envelope = receipt(input);
    if (!options?.principal) throw new V1Error('UNAUTHENTICATED');
    const principal = freeze(copyJsonData(options.principal));
    if (!principal || typeof principal.actor_id !== 'string' || !principal.actor_id.trim())
      throw new V1Error('UNAUTHENTICATED');
    const observation = envelope.observation;
    if (observation.tenant_id !== this.tenant_id || observation.system_id !== this.system_id)
      throw new V1Error('FORBIDDEN');
    const unsigned = { ...envelope };
    delete unsigned.signature;
    const encoded = ciReceiptSigningBytes(unsigned);
    if (encoded.length > this.max_receipt_bytes) throw new V1Error('INVALID_ARGUMENT');
    const scope = freeze({
      schema_version: 1,
      tenant_id: this.tenant_id,
      system_id: this.system_id,
      issuer: envelope.issuer,
      key_id: envelope.key_id,
    });
    if (
      (await trustedCall(() =>
        this.authorize(principal, freeze({ ...scope, action: 'evidence.ingest' })),
      )) !== true
    )
      throw new V1Error('FORBIDDEN');
    // Registry data is authoritative. Keys and recipe grants are never accepted
    // from the receipt or from the untrusted validation environment.
    const evaluator = freeze(copyJsonData(await trustedCall(() => this.resolveEvaluator(scope))));
    if (!evaluator) throw new V1Error('FORBIDDEN');
    assertSchemaVersion(evaluator);
    valid(Object.keys(evaluator).length === 7 && Array.isArray(evaluator.allowed_config_digests));
    if (evaluator.issuer !== envelope.issuer || evaluator.key_id !== envelope.key_id)
      throw new V1Error('FORBIDDEN');
    text(evaluator.producer_version);
    valid(
      evaluator.repository_bindings &&
        typeof evaluator.repository_bindings === 'object' &&
        !Array.isArray(evaluator.repository_bindings),
    );
    evaluator.allowed_config_digests.forEach((digest) => parseDigest(digest));
    if (!evaluator.allowed_config_digests.includes(observation.config_digest))
      throw new V1Error('POLICY_REJECTED');
    let key;
    try {
      key = await crypto.subtle.importKey(
        'raw',
        decode(evaluator.public_key, 32),
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
    } catch {
      throw new V1Error('INTEGRITY_MISMATCH');
    }
    if (!(await crypto.subtle.verify('Ed25519', key, decode(envelope.signature, 64), encoded)))
      throw new V1Error('INTEGRITY_MISMATCH');
    const trees = {},
      commits = {};
    for (const source of observation.sources) {
      if (!Object.hasOwn(evaluator.repository_bindings, source.repo_id))
        throw new V1Error('FORBIDDEN');
      const target = evaluator.repository_bindings[source.repo_id];
      text(target);
      if (Object.hasOwn(trees, target)) throw new V1Error('INVALID_ARGUMENT');
      if (
        (await trustedCall(() =>
          this.authorize(
            principal,
            freeze({
              ...scope,
              action: 'evidence.ingest',
              source_repo_id: source.repo_id,
              repo_id: target,
            }),
          ),
        )) !== true
      )
        throw new V1Error('FORBIDDEN');
      const actual = gitSnapshot(
        await trustedCall(() => this.observeSnapshot(source.repo_id, source.commit_oid)),
      );
      if (
        actual.repo_id !== source.repo_id ||
        actual.commit_oid !== source.commit_oid ||
        actual.tree_oid !== source.tree_oid ||
        JSON.stringify(actual.parent_oids) !== JSON.stringify(source.parent_oids)
      )
        throw new V1Error('INTEGRITY_MISMATCH');
      Object.defineProperty(trees, target, { value: source.tree_oid, enumerable: true });
      Object.defineProperty(commits, target, { value: source.commit_oid, enumerable: true });
    }
    const subject = await evidenceSubject({
      schema_version: 1,
      repo_tree_oids: trees,
      repo_commit_oids: commits,
    });
    const evidence = await buildEvidence({
      schema_version: 1,
      subject_digest: subject.digest,
      type: observation.type,
      producer_identity: envelope.issuer,
      producer_version: evaluator.producer_version,
      config_digest: observation.config_digest,
      environment_digest: observation.environment_digest,
      result: observation.result,
      payload_ref: observation.payload_ref,
      created_at: observation.created_at,
      retention_class: this.retention_class,
    });
    return freeze({
      schema_version: 1,
      evidence,
      receipt_digest: await digestCanonical('external-ci-receipt', envelope),
    });
  }

  async verifyProvenance(evidenceInput, receiptInput, options) {
    const { evidence } = await verifyEvidence(evidenceInput);
    try {
      return (await this.ingest(receiptInput, options)).evidence.id === evidence.id;
    } catch (error) {
      if (
        error instanceof V1Error &&
        ['FORBIDDEN', 'POLICY_REJECTED', 'INTEGRITY_MISMATCH', 'INVALID_ARGUMENT'].includes(
          error.code,
        )
      )
        return false;
      throw error;
    }
  }
}
