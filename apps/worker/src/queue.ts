/**
 * CODEX OPERATING CONTRACT: Phase 2 Coordination Plane
 * Event Queue Framework with Claim-Check Handling & Digest Verification
 */

import { createHash, randomUUID } from 'node:crypto';

export const INLINE_THRESHOLD_BYTES = 32 * 1024; // 32 KB
export const QUEUE_HARD_CEILING_BYTES = 128 * 1024; // 128 KB platform maximum

export interface EventEnvelope<T = unknown> {
  id: string;
  trace_id: string;
  idempotency_key: string;
  topic: string;
  tenant_id: string;
  repo_id: string;
  timestamp: string;
  attempt_count: number;
  payload_mode: 'INLINE' | 'CLAIM_CHECK';
  payload_size_bytes: number;
  payload_digest: string;
  inline_payload?: T;
  payload_ref?: string; // R2 storage key when CLAIM_CHECK
}

export interface DLQRecord {
  envelope: EventEnvelope;
  failed_at: string;
  reason: string;
  attempts: number;
}

/**
 * Simulated R2 ObjectStore for claim-check storage
 */
export class ObjectStore {
  private store: Map<string, { data: Uint8Array; digest: string }> = new Map();

  async put(key: string, data: Uint8Array): Promise<string> {
    const digest = createHash('sha256').update(data).digest('hex');
    this.store.set(key, { data, digest });
    return digest;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.store.get(key);
    return entry ? entry.data : null;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

/**
 * Event Queue Broker with Idempotency, Claim-Check, and DLQ
 */
export class EventQueueBroker {
  private queue: EventEnvelope[] = [];
  private dlq: DLQRecord[] = [];
  private processedIdempotencyKeys: Set<string> = new Set();
  private objectStore: ObjectStore;
  private maxRetries: number;

  constructor(objectStore: ObjectStore, maxRetries = 3) {
    this.objectStore = objectStore;
    this.maxRetries = maxRetries;
  }

  async publish<T>(params: {
    topic: string;
    tenant_id: string;
    repo_id: string;
    idempotency_key: string;
    trace_id?: string;
    payload: T;
  }): Promise<EventEnvelope<T>> {
    const rawBytes = new TextEncoder().encode(JSON.stringify(params.payload));
    const size = rawBytes.length;
    const digest = createHash('sha256').update(rawBytes).digest('hex');

    let mode: 'INLINE' | 'CLAIM_CHECK' = 'INLINE';
    let payload_ref: string | undefined = undefined;
    let inline_payload: T | undefined = undefined;

    if (size >= INLINE_THRESHOLD_BYTES) {
      // Must use Claim-Check pattern in R2
      mode = 'CLAIM_CHECK';
      payload_ref = `r2://klocgit-events/${params.tenant_id}/${params.repo_id}/${randomUUID()}`;
      await this.objectStore.put(payload_ref, rawBytes);
    } else {
      inline_payload = params.payload;
    }

    const envelope: EventEnvelope<T> = {
      id: `evt_${randomUUID()}`,
      trace_id: params.trace_id || `trace_${randomUUID()}`,
      idempotency_key: params.idempotency_key,
      topic: params.topic,
      tenant_id: params.tenant_id,
      repo_id: params.repo_id,
      timestamp: new Date().toISOString(),
      attempt_count: 0,
      payload_mode: mode,
      payload_size_bytes: size,
      payload_digest: digest,
      inline_payload,
      payload_ref,
    };

    // Platform Ceiling Awareness Check
    const serializedEnvelopeSize = new TextEncoder().encode(JSON.stringify(envelope)).length;
    if (serializedEnvelopeSize >= QUEUE_HARD_CEILING_BYTES) {
      throw new Error(`QUEUE_OVERSIZE: Serialized envelope exceeds Cloudflare Queue 128KB ceiling (${serializedEnvelopeSize} bytes)`);
    }

    this.queue.push(envelope as EventEnvelope);
    return envelope;
  }

  async processNext(
    handler: (envelope: EventEnvelope, payload: any) => Promise<void>
  ): Promise<{ status: 'PROCESSED' | 'SKIPPED_DUPLICATE' | 'DLQ' | 'EMPTY'; event_id?: string }> {
    const envelope = this.queue.shift();
    if (!envelope) return { status: 'EMPTY' };

    // Idempotency check
    if (this.processedIdempotencyKeys.has(envelope.idempotency_key)) {
      return { status: 'SKIPPED_DUPLICATE', event_id: envelope.id };
    }

    envelope.attempt_count += 1;

    try {
      // Resolve payload
      let payloadData: any;
      if (envelope.payload_mode === 'INLINE') {
        payloadData = envelope.inline_payload;
      } else {
        // Claim-check resolution
        if (!envelope.payload_ref) throw new Error('Missing payload_ref on claim-check envelope');
        const bytes = await this.objectStore.get(envelope.payload_ref);
        if (!bytes) throw new Error(`Claim-check payload not found at ${envelope.payload_ref}`);

        // Post-retrieval digest verification
        const computedDigest = createHash('sha256').update(bytes).digest('hex');
        if (computedDigest !== envelope.payload_digest) {
          throw new Error(`DIGEST_MISMATCH: Claim-check byte digest ${computedDigest} != expected ${envelope.payload_digest}`);
        }

        payloadData = JSON.parse(new TextDecoder().decode(bytes));
      }

      await handler(envelope, payloadData);

      // Mark processed for idempotency
      this.processedIdempotencyKeys.add(envelope.idempotency_key);
      return { status: 'PROCESSED', event_id: envelope.id };
    } catch (err: any) {
      if (envelope.attempt_count >= this.maxRetries) {
        // Exceeded retries -> send to DLQ
        this.dlq.push({
          envelope,
          failed_at: new Date().toISOString(),
          reason: err.message || 'Unknown processing error',
          attempts: envelope.attempt_count,
        });
        return { status: 'DLQ', event_id: envelope.id };
      } else {
        // Re-enqueue for retry
        this.queue.push(envelope);
        return { status: 'EMPTY' };
      }
    }
  }

  getDLQ(): DLQRecord[] {
    return [...this.dlq];
  }

  replayDLQ(): number {
    const count = this.dlq.length;
    while (this.dlq.length > 0) {
      const rec = this.dlq.shift()!;
      rec.envelope.attempt_count = 0;
      this.queue.push(rec.envelope);
    }
    return count;
  }
}
