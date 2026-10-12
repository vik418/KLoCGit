/**
 * CODEX OPERATING CONTRACT: Phase 2 Coordination Plane
 * ObjectiveCoordinator & RefCoordinator (DO SQLite State & CAS Adapter)
 */

import {
  Decision,
  DecisionBasis,
  Predicate,
} from '../../../packages/contracts/src/types.ts';

export type IngestionPhase =
  | 'INIT'
  | 'ANALYZING'
  | 'REDUCING'
  | 'DECISION_PENDING'
  | 'CONVERGED'
  | 'BLOCKED';

export interface ObjectiveState {
  objective_id: string;
  tenant_id: string;
  repo_id: string;
  phase: IngestionPhase;
  scheduled_jobs: string[];
  ingested_futures: string[];
  candidate_specs: string[];
  decisions: Record<string, Decision>;
  last_updated: string;
}

export interface ReductionResult {
  objective_id: string;
  exact_duplicates_collapsed: number;
  effect_clusters_count: number;
  alternative_implementations_count: number;
  resolved_dependencies: string[];
  synthesized_candidate_specs: string[];
  material_effect_digest: string;
  policy_digest: string;
  required_analysis_status: Record<string, 'COMPLETE' | 'PARTIAL' | 'UNSUPPORTED' | 'FAILED'>;
}

/**
 * ObjectiveCoordinator DO Simulator (DO SQLite backing)
 * Handles ingestion state machine, job scheduling, decision state transitions,
 * and ReductionResult consumption.
 * STRICT INVARIANT: DOs must NEVER perform heavy AST parsing or graph reduction.
 */
export class ObjectiveCoordinator {
  private state: ObjectiveState;
  private sqliteStore: Map<string, string>; // Simulates Durable Object SQLite storage

  constructor(
    objective_id: string,
    tenant_id: string,
    repo_id: string,
    sqliteStore: Map<string, string>
  ) {
    this.sqliteStore = sqliteStore;
    const key = `do:objective:${objective_id}`;
    const raw = this.sqliteStore.get(key);

    if (raw) {
      // Reconstitute from DO SQLite persistent storage (Crash/Restart Recovery)
      this.state = JSON.parse(raw);
    } else {
      this.state = {
        objective_id,
        tenant_id,
        repo_id,
        phase: 'INIT',
        scheduled_jobs: [],
        ingested_futures: [],
        candidate_specs: [],
        decisions: {},
        last_updated: new Date().toISOString(),
      };
      this.persist();
    }
  }

  private persist() {
    this.state.last_updated = new Date().toISOString();
    this.sqliteStore.set(`do:objective:${this.state.objective_id}`, JSON.stringify(this.state));
  }

  getState(): ObjectiveState {
    return JSON.parse(JSON.stringify(this.state));
  }

  ingestFutureRevision(futureId: string): void {
    if (!this.state.ingested_futures.includes(futureId)) {
      this.state.ingested_futures.push(futureId);
      this.state.phase = 'ANALYZING';
      const jobId = `job_extract_${futureId}`;
      if (!this.state.scheduled_jobs.includes(jobId)) {
        this.state.scheduled_jobs.push(jobId);
      }
      this.persist();
    }
  }

  scheduleReductionJob(): string {
    const jobId = `job_reduce_${this.state.objective_id}_${Date.now()}`;
    this.state.phase = 'REDUCING';
    this.state.scheduled_jobs.push(jobId);
    this.persist();
    return jobId;
  }

  /**
   * Consume bounded ReductionResult produced by Rust engine.
   * DOES NOT perform graph reduction inside the DO.
   */
  consumeReductionResult(reduction: ReductionResult): void {
    this.state.candidate_specs = reduction.synthesized_candidate_specs;
    this.state.phase = 'DECISION_PENDING';

    // Create or update decision based on reduction
    const decisionId = `dec_${this.state.objective_id}`;
    const basis: DecisionBasis = {
      candidate_digests: reduction.synthesized_candidate_specs,
      evidence_digests: [],
      material_effect_digest: reduction.material_effect_digest,
      policy_digest: reduction.policy_digest,
      canonical_ref_oids: { [this.state.repo_id]: 'base_trunk_oid' },
      required_analysis_status: reduction.required_analysis_status,
      basis_digest: '',
    };

    const hasIncomplete = Object.values(reduction.required_analysis_status).some(
      (s) => s !== 'COMPLETE'
    );

    const decision: Decision = {
      id: decisionId,
      objective_id: this.state.objective_id,
      basis,
      state: hasIncomplete ? 'DISCOVERED' : 'REVIEWABLE',
      conditional_predicates: [
        { kind: 'ANALYSIS_COMPLETE', subject: this.state.objective_id },
      ],
    };

    this.state.decisions[decisionId] = decision;
    if (hasIncomplete) {
      this.state.phase = 'BLOCKED';
    }
    this.persist();
  }

  updateDecisionState(decisionId: string, newState: 'REVIEWABLE' | 'RESOLVABLE' | 'RESOLVED' | 'STALE', actor?: string): void {
    const decision = this.state.decisions[decisionId];
    if (!decision) throw new Error(`Decision ${decisionId} not found`);

    decision.state = newState;
    if (newState === 'RESOLVED') {
      decision.resolved_by = actor || 'human-authorizer';
      decision.resolved_at = new Date().toISOString();
      this.state.phase = 'CONVERGED';
    }
    this.persist();
  }
}

/**
 * RefCoordinator DO (Serialized Promotion Locks & CAS Push Adapter)
 * Serializes mutations on Git ref scopes and asserts current remote OID matches expected_oid.
 */
export class RefCoordinator {
  private ref: string;
  private currentRemoteOid: string;
  private isLocked: boolean = false;
  private lockOwner?: string;
  private sqliteStore: Map<string, string>;

  constructor(ref: string, initialOid: string, sqliteStore: Map<string, string>) {
    this.ref = ref;
    this.sqliteStore = sqliteStore;
    const stored = this.sqliteStore.get(`do:ref:${ref}`);
    if (stored) {
      this.currentRemoteOid = stored;
    } else {
      this.currentRemoteOid = initialOid;
      this.sqliteStore.set(`do:ref:${ref}`, initialOid);
    }
  }

  getCurrentOid(): string {
    return this.currentRemoteOid;
  }

  /**
   * Serialized Compare-and-Swap (CAS) Git Mutation.
   * Returns true on success, throws CAS_CONFLICT on mismatch.
   */
  async compareAndSwapRef(params: {
    expected_oid: string;
    target_oid: string;
    mutator_id: string;
  }): Promise<{ success: boolean; new_oid: string }> {
    // Acquire serialized lock on ref
    if (this.isLocked) {
      throw new Error(`REF_LOCKED: Ref ${this.ref} currently locked by ${this.lockOwner}`);
    }

    this.isLocked = true;
    this.lockOwner = params.mutator_id;

    try {
      // Simulate atomic Git receive-pack CAS verification:
      if (this.currentRemoteOid !== params.expected_oid) {
        throw new Error(
          `CAS_CONFLICT: Ref ${this.ref} current OID is ${this.currentRemoteOid}, expected ${params.expected_oid}`
        );
      }

      // CAS Succeeded: Advance remote ref
      this.currentRemoteOid = params.target_oid;
      this.sqliteStore.set(`do:ref:${this.ref}`, params.target_oid);

      return { success: true, new_oid: this.currentRemoteOid };
    } finally {
      // Release serialized lock
      this.isLocked = false;
      this.lockOwner = undefined;
    }
  }
}
