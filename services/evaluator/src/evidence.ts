/**
 * CODEX OPERATING CONTRACT: Phase 3 Materialization Plane
 * Evidence Pipeline, R2 Claim-Check Staging & Retention Class Tagger
 */

import { randomUUID } from 'node:crypto';
import { ExecutionReceipt } from './sandbox.ts';
import {
  CanonicalEvidence,
  Evidence,
} from '../../../packages/contracts/src/types.ts';
import {
  computeEvidenceDigest,
  computePayloadDigest,
} from '../../../packages/contracts/src/digest.ts';
import { sha256Hex } from '../../../packages/contracts/src/sha256.ts';

export interface EvaluatorPolicy {
  evaluator_id: string;
  evaluator_version: string;
  config_digest: string;
  environment_digest: string;
}

export class EvidenceCollector {
  private r2Store: Map<string, { bytes: Uint8Array; digest: string }> = new Map();
  private policy: EvaluatorPolicy;

  constructor(policy?: Partial<EvaluatorPolicy>) {
    this.policy = {
      evaluator_id: policy?.evaluator_id ?? 'hermetic-container-evaluator',
      evaluator_version: policy?.evaluator_version ?? '1.2.0',
      config_digest: policy?.config_digest ?? sha256Hex('default-eval-config-v1'),
      environment_digest: policy?.environment_digest ?? sha256Hex('hermetic-linux-x86_64:v1.2'),
    };
  }

  /**
   * Stage raw execution receipt into R2 storage and emit CanonicalEvidence
   */
  stageEvidence(params: {
    subject_digest: string;
    receipt: ExecutionReceipt;
    retention_override?: 'EPHEMERAL' | 'REBUILDABLE' | 'DECISION_RECORD' | 'CANONICAL';
  }): { evidence: Evidence; canonical_evidence: CanonicalEvidence; payload_bytes: Uint8Array } {
    const rawJson = JSON.stringify(params.receipt);
    const rawBytes = new TextEncoder().encode(rawJson);
    const payload_digest = computePayloadDigest(rawBytes);

    // Write raw payload to R2 storage
    const storageKey = `r2://klocgit-evidence/${params.subject_digest.slice(0, 12)}/${params.receipt.execution_id}.json`;
    this.r2Store.set(storageKey, { bytes: rawBytes, digest: payload_digest });

    // Determine retention class based on outcome policy
    let retention_class: 'EPHEMERAL' | 'REBUILDABLE' | 'DECISION_RECORD' | 'CANONICAL' = 'DECISION_RECORD';
    if (params.retention_override) {
      retention_class = params.retention_override;
    } else if (params.receipt.exit_code !== 0) {
      retention_class = 'EPHEMERAL'; // Transient failures expire quickly
    } else if (params.receipt.coverage_pct >= 90) {
      retention_class = 'CANONICAL';
    }

    const result: 'PASSED' | 'FAILED' | 'ERROR' =
      params.receipt.exit_code === 0 ? 'PASSED' : params.receipt.exit_code === 1 ? 'FAILED' : 'ERROR';

    const canonical_evidence: CanonicalEvidence = {
      subject_digest: params.subject_digest,
      evaluator_id: this.policy.evaluator_id,
      evaluator_version: this.policy.evaluator_version,
      config_digest: this.policy.config_digest,
      environment_digest: this.policy.environment_digest,
      result,
      payload_digest,
    };

    const evidence_digest = computeEvidenceDigest(canonical_evidence);

    const evidence: Evidence = {
      id: `ev_${randomUUID().replace(/-/g, '')}`,
      ...canonical_evidence,
      payload_ref: storageKey,
      retention_class,
      created_at: new Date().toISOString(),
      evidence_digest,
    };

    return { evidence, canonical_evidence, payload_bytes: rawBytes };
  }

  getR2Payload(storageKey: string): Uint8Array | null {
    const entry = this.r2Store.get(storageKey);
    return entry ? entry.bytes : null;
  }
}
