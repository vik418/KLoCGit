import { payloadDigest, sealEvidence } from "../../../packages/contracts/src/index.ts";
import type { Evidence } from "../../../packages/contracts/src/index.ts";
import { Failure, identifier } from "./runtime.ts";

type Retention = Evidence["retention_class"];
const retentionOrder: Retention[] = ["EPHEMERAL", "REBUILDABLE", "DECISION_RECORD", "CANONICAL"];
function stronger(a: Retention, b: Retention): Retention {
  if (!retentionOrder.includes(a) || !retentionOrder.includes(b))
    throw new Failure("INVALID_RETENTION", 409, "Evidence retention class is invalid");
  return retentionOrder[Math.max(retentionOrder.indexOf(a), retentionOrder.indexOf(b))];
}

export class EvidenceStore {
  private bucket: R2Bucket;
  constructor(bucket: R2Bucket) { this.bucket = bucket; }

  private async retainPayload(key: string, bytes: Uint8Array, digest: string, retention: Retention): Promise<void> {
    const existing = await this.bucket.get(key);
    if (existing) {
      if (existing.size !== bytes.length || await payloadDigest(new Uint8Array(await existing.arrayBuffer())) !== digest)
        throw new Failure("EVIDENCE_CORRUPT", 409, "Stored evidence bytes differ");
    } else {
      const stored = await this.bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: { schema_version: "1", payload_digest: digest, retention_ref: key + ".retention" },
      });
      if (!stored) {
        const winner = await this.bucket.get(key);
        if (!winner || await payloadDigest(new Uint8Array(await winner.arrayBuffer())) !== digest)
          throw new Failure("EVIDENCE_CORRUPT", 409, "Concurrent evidence bytes differ");
      }
    }
    // R2 payload ETags track bytes, not metadata. A separate content-changing
    // retention record makes concurrent pinning compare-and-swap safe.
    const retentionKey = key + ".retention";
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.bucket.get(retentionKey);
      let selected = retention;
      if (previous) {
        if (previous.size > 1024) throw new Failure("EVIDENCE_CORRUPT", 409, "Retention record exceeds limit");
        const prior = await previous.json<{ schema_version: number; payload_digest: string; retention_class: Retention }>();
        if (prior.schema_version !== 1 || prior.payload_digest !== digest)
          throw new Failure("EVIDENCE_CORRUPT", 409, "Retention payload identity differs");
        selected = stronger(prior.retention_class, retention);
        if (selected === prior.retention_class) return;
      }
      const result = await this.bucket.put(retentionKey,
        JSON.stringify({ schema_version: 1, payload_digest: digest, retention_class: selected }), {
        onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
        customMetadata: { schema_version: "1", retention_class: selected },
      });
      if (result) return;
    }
    throw new Failure("EVIDENCE_CONTENTION", 409, "Evidence retention changed; retry persistence");
  }

  async payloadRetention(tenant: string, digest: string): Promise<Retention> {
    identifier(tenant);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Failure("INVALID_INPUT", 400, "Invalid payload identity");
    const object = await this.bucket.get("evidence/" + tenant + "/payloads/" + digest.slice(7) + ".retention");
    if (!object || object.size > 1024) throw new Failure("EVIDENCE_MISSING", 404, "Retention record is unavailable");
    const record = await object.json<{ schema_version: number; payload_digest: string; retention_class: Retention }>();
    if (record.schema_version !== 1 || record.payload_digest !== digest)
      throw new Failure("EVIDENCE_CORRUPT", 409, "Retention payload identity differs");
    return stronger(record.retention_class, record.retention_class);
  }

  async persist(tenant: string, supplied: Evidence, payload: Uint8Array): Promise<Evidence> {
    identifier(tenant); stronger(supplied.retention_class, supplied.retention_class);
    if (payload.length > 8 * 1024 * 1024 || await payloadDigest(payload) !== supplied.payload_digest)
      throw new Failure("INVALID_EVIDENCE", 409, "Evidence payload digest differs");
    const sealed = await sealEvidence(supplied);
    if (sealed.evidence_digest !== supplied.evidence_digest || sealed.id !== supplied.id)
      throw new Failure("INVALID_EVIDENCE", 409, "Evidence record digest differs");
    const payload_ref = "evidence/" + tenant + "/payloads/" + sealed.payload_digest.slice(7);
    const key = "evidence/" + tenant + "/records/" + sealed.evidence_digest.slice(7);
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.bucket.get(key);
      let record: Evidence = { ...sealed, payload_ref, created_at: supplied.created_at || new Date().toISOString() };
      if (previous) {
        if (previous.size > 32 * 1024) throw new Failure("EVIDENCE_CORRUPT", 409, "Stored evidence exceeds limit");
        const old = await previous.json<Evidence>();
        const verified = await sealEvidence(old);
        if (verified.evidence_digest !== sealed.evidence_digest || verified.id !== old.id || old.payload_ref !== payload_ref)
          throw new Failure("EVIDENCE_CORRUPT", 409, "Stored evidence identity differs");
        record = { ...old, retention_class: stronger(old.retention_class, supplied.retention_class) };
      }
      // Pin shared bytes before pinning a record. A later short-lived reuse must
      // not make evidence needed by an accepted decision eligible for deletion.
      await this.retainPayload(payload_ref, payload, record.payload_digest, record.retention_class);
      if (previous && record.retention_class === previous.customMetadata?.retention_class) return record;
      const result = await this.bucket.put(key, JSON.stringify({ schema_version: 1, ...record }), {
        onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
        customMetadata: { schema_version: "1", retention_class: record.retention_class, evidence_digest: record.evidence_digest },
      });
      if (result) return record;
    }
    throw new Failure("EVIDENCE_CONTENTION", 409, "Evidence record changed; retry persistence");
  }

  async load(tenant: string, evidenceDigest: string): Promise<{ evidence: Evidence; payload: Uint8Array }> {
    identifier(tenant);
    if (!/^sha256:[0-9a-f]{64}$/.test(evidenceDigest))
      throw new Failure("INVALID_INPUT", 400, "Invalid evidence identity");
    const object = await this.bucket.get("evidence/" + tenant + "/records/" + evidenceDigest.slice(7));
    if (!object || object.size > 32 * 1024)
      throw new Failure("EVIDENCE_MISSING", 404, "Evidence record is unavailable");
    const evidence = await object.json<Evidence>();
    const sealed = await sealEvidence(evidence);
    if (sealed.evidence_digest !== evidenceDigest || sealed.id !== evidence.id ||
        evidence.payload_ref !== "evidence/" + tenant + "/payloads/" + evidence.payload_digest.slice(7))
      throw new Failure("EVIDENCE_CORRUPT", 409, "Evidence reference differs");
    const payloadObject = await this.bucket.get(evidence.payload_ref);
    if (!payloadObject || payloadObject.size > 8 * 1024 * 1024)
      throw new Failure("EVIDENCE_MISSING", 404, "Evidence payload is unavailable");
    const payload = new Uint8Array(await payloadObject.arrayBuffer());
    if (await payloadDigest(payload) !== evidence.payload_digest)
      throw new Failure("EVIDENCE_CORRUPT", 409, "Evidence payload was substituted");
    return { evidence, payload };
  }
}
