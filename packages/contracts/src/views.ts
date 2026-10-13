import type {
  Candidate,
  CandidateSpec,
  Decision,
  EffectSet,
  Evidence,
} from "./index.ts";

export interface Scope {
  tenant_id: string;
  organization_id: string;
  repo_id: string;
  objective_id: string;
}

export interface DecisionAlternative {
  spec: CandidateSpec;
  candidate: Candidate;
  effects: EffectSet[];
}

export interface DecisionPacket {
  schema_version: 1;
  version: number;
  reduction_status: string;
  review_sequence: number;
  decision: Decision;
  question: string;
  candidates: DecisionAlternative[];
  evidence: Evidence[];
  blockers: Record<string, { code: string; subject: string }[]>;
}

export interface AttentionSnapshot {
  schema_version: 1;
  decisions: DecisionPacket[];
  pending_candidates: number;
  policy_configured: boolean;
}

export interface Session {
  schema_version: 1;
  actor_id: string;
  actor_type: "human" | "agent" | "service";
  expires_at: number;
  grants: { scope: Partial<Scope>; actions: string[] }[];
  organization_grants?: { scope: Pick<Scope, "tenant_id" | "organization_id">; actions: string[] }[];
}

export interface ForwardPortProof {
  schema_version: 1;
  repo_id: string;
  previous_spec_digest: string;
  spec_digest: string;
  previous_candidate_digest: string;
  candidate_digest: string;
  previous_base_oid: string;
  base_oid: string;
  base_tree_oid: string;
  reviewed_delta_digest: string;
  effect_summary_digest: string;
  proof_digest: string;
}

export interface ForwardPortSource {
  specification: CandidateSpec;
  candidate: Candidate;
}
