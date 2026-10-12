import { payloadDigest, sealEvidence } from '../../../packages/contracts/src/index.ts';
import type { Evidence } from '../../../packages/contracts/src/index.ts';
import { Failure, identifier } from './runtime.ts';

export class EvidenceStore {
  private bucket: R2Bucket;
  constructor(bucket: R2Bucket) { this.bucket = bucket; }

  async persist(tenant: string, supplied: Evidence, payload: Uint8Array): Promise<Evidence> {
    identifier(tenant);
    if (payload.length > 8 * 1024 * 1024 || await payloadDigest(payload) !== supplied.payload_digest) throw new Failure('INVALID_EVIDENCE', 409, 'Evidence payload digest differs');
    const sealed = await sealEvidence(supplied);
    if (sealed.evidence_digest !== supplied.evidence_digest || sealed.id !== supplied.id) throw new Failure('INVALID_EVIDENCE', 409, 'Evidence record digest differs');
    const payload_ref = 'evidence/' + tenant + '/payloads/' + sealed.payload_digest.slice(7);
    const record: Evidence = { ...sealed, payload_ref, created_at: supplied.created_at || new Date().toISOString() };
    const existing = await this.bucket.get(payload_ref);
    if (existing) {
      if (await payloadDigest(new Uint8Array(await existing.arrayBuffer())) !== sealed.payload_digest) throw new Failure('EVIDENCE_CORRUPT', 409, 'Stored evidence bytes differ');
    } else {
      await this.bucket.put(payload_ref, payload, { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: {
        schema_version: '1', retention_class: record.retention_class, payload_digest: record.payload_digest,
      } });
    }
    const key = 'evidence/' + tenant + '/records/' + record.evidence_digest.slice(7);
    const previous = await this.bucket.get(key);
    if (previous) {
      const previousRecord = await previous.json<Evidence>();
      const verified = await sealEvidence(previousRecord);
      if (verified.evidence_digest !== record.evidence_digest) throw new Failure('EVIDENCE_CORRUPT', 409, 'Stored evidence identity differs');
      return previousRecord;
    }
    await this.bucket.put(key, JSON.stringify({ schema_version: 1, ...record }), {
      onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: { schema_version: '1', retention_class: record.retention_class, evidence_digest: record.evidence_digest },
    });
    return record;
  }

  async load(tenant: string, evidenceDigest: string): Promise<{ evidence: Evidence; payload: Uint8Array }> {
    identifier(tenant);
    if (!/^sha256:[0-9a-f]{64}$/.test(evidenceDigest)) throw new Failure('INVALID_INPUT', 400, 'Invalid evidence identity');
    const object = await this.bucket.get('evidence/' + tenant + '/records/' + evidenceDigest.slice(7));
    if (!object || object.size > 32 * 1024) throw new Failure('EVIDENCE_MISSING', 404, 'Evidence record is unavailable');
    const evidence = await object.json<Evidence>();
    const sealed = await sealEvidence(evidence);
    if (sealed.evidence_digest !== evidenceDigest || evidence.payload_ref !== 'evidence/' + tenant + '/payloads/' + evidence.payload_digest.slice(7)) throw new Failure('EVIDENCE_CORRUPT', 409, 'Evidence reference differs');
    const payloadObject = await this.bucket.get(evidence.payload_ref);
    if (!payloadObject || payloadObject.size > 8 * 1024 * 1024) throw new Failure('EVIDENCE_MISSING', 404, 'Evidence payload is unavailable');
    const payload = new Uint8Array(await payloadObject.arrayBuffer());
    if (await payloadDigest(payload) !== evidence.payload_digest) throw new Failure('EVIDENCE_CORRUPT', 409, 'Evidence payload was substituted');
    return { evidence, payload };
  }
}
