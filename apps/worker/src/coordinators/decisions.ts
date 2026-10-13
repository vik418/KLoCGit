import {
  hashProjection,
  sealCandidate,
  sealCandidateSpec,
  sealDecisionBasis,
  sealEvidence,
} from "../../../../packages/contracts/src/index.ts";
import type {
  Candidate,
  CandidateSpec,
  Decision,
  EffectSet,
  Evidence,
  Predicate,
} from "../../../../packages/contracts/src/index.ts";
import {
  DecisionLifecycle,
  PolicyEvaluator,
  policyDigest,
} from "../../../../packages/policy/src/policy.ts";
import type {
  CandidateAnalysis,
  Review,
  ReviewPolicy,
  PolicyResult,
} from "../../../../packages/policy/src/policy.ts";
import { EvidenceStore } from "../evidence-store.ts";
import { GitStore } from "../git-store.ts";
import { callRef } from "../internal.ts";
import { Failure, readJson } from "../runtime.ts";
import type { Bindings, Scope } from "../runtime.ts";
import type { Principal } from "../auth.ts";
import type { PromotionCommand } from "./ref.ts";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;

import type { DecisionPacket } from "../../../../packages/contracts/src/views.ts";
export type { DecisionPacket } from "../../../../packages/contracts/src/views.ts";

export interface ReviewCommand {
  schema_version: 1;
  scope: Scope;
  decision_id: string;
  basis_digest: string;
  candidate_digest: string;
  idempotency_key: string;
  principal: Principal;
  predicates?: Predicate[];
  author?: { name: string; email: string };
}

export interface PreparedCandidate {
  schema_version: number;
  candidate_digest: string;
  expected_oid: string;
  target_oid: string;
  tree_oid: string;
  payload_digest: string;
}

type Slot = {
  spec_id: string;
  version: number;
  spec: string;
  status: string;
  candidate: string | null;
  evidence: string | null;
};
type Operation = {
  request_digest: string;
  command: string;
  status: string;
  result: string | null;
};

function policy(env: Bindings): ReviewPolicy {
  try {
    const value = JSON.parse(env.REVIEW_POLICY ?? "");
    if (value.schema_version !== 1) throw new Error();
    return value;
  } catch {
    throw new Failure(
      "CONFIGURATION_REQUIRED",
      503,
      "Review policy is not configured",
    );
  }
}

function bounded(value: unknown): string {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > MAX_RECORD_BYTES)
    throw new Failure(
      "RESOURCE_LIMIT",
      409,
      "Decision record exceeds configured storage limit",
    );
  return json;
}

/** Authoritative records share the Objective's SQLite transaction boundary. */
export class DecisionStore {
  constructor(
    private storage: DurableObjectStorage,
    private env: Bindings,
  ) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS candidate_slots (version INTEGER NOT NULL, spec_id TEXT NOT NULL, schema_version INTEGER NOT NULL, spec TEXT NOT NULL, status TEXT NOT NULL, candidate TEXT, evidence TEXT, PRIMARY KEY(version, spec_id))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS decisions (decision_id TEXT PRIMARY KEY, version INTEGER NOT NULL, schema_version INTEGER NOT NULL, packet TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS decision_bases (decision_id TEXT NOT NULL, basis_digest TEXT NOT NULL, schema_version INTEGER NOT NULL, packet TEXT NOT NULL, PRIMARY KEY(decision_id, basis_digest))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS decision_reviews (sequence INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL, actor_id TEXT NOT NULL, schema_version INTEGER NOT NULL, record TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS reviews_by_decision ON decision_reviews(decision_id, actor_id, sequence)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS review_receipts (idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, decision_id TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS decision_operations (idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, decision_id TEXT NOT NULL, schema_version INTEGER NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL, active_slot INTEGER UNIQUE, result TEXT)",
    );
  }

  private version(): number {
    return Number(
      this.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM metadata WHERE key = ?",
          "version",
        )
        .toArray()[0]?.value ?? 0,
    );
  }

  assertIdle(): void {
    if (
      this.storage.sql
        .exec("SELECT 1 FROM decision_operations WHERE active_slot = 1 LIMIT 1")
        .toArray().length
    )
      throw new Failure(
        "PROMOTION_PENDING",
        409,
        "A canonical operation needs completion or reconciliation",
      );
  }

  private audit(action: string, actor: string, object: string): void {
    this.storage.sql.exec(
      "INSERT INTO audit (schema_version, action, actor_id, trace_id, object_id) VALUES (1, ?, ?, ?, ?)",
      action,
      actor,
      object,
      object,
    );
  }

  private slots(version: number): Slot[] {
    return this.storage.sql
      .exec<Slot>(
        "SELECT spec_id, version, spec, status, candidate, evidence FROM candidate_slots WHERE version = ? ORDER BY spec_id",
        version,
      )
      .toArray();
  }

  sources(
    spec: CandidateSpec,
  ): { state: unknown; revision: unknown; effects: EffectSet }[] {
    return spec.selected_future_revisions
      .map((id) => {
        const row = this.storage.sql
          .exec<{ record: string; effects: string | null }>(
            "SELECT record, effects FROM futures WHERE revision_id = ?",
            id,
          )
          .toArray()[0];
        if (!row?.effects)
          throw new Failure(
            "ANALYSIS_REQUIRED",
            409,
            "Selected Future analysis is missing",
          );
        return { ...JSON.parse(row.record), effects: JSON.parse(row.effects) };
      })
      .map(({ state, revision, effects }) => ({ state, revision, effects }));
  }

  async register(
    scope: Scope,
    version: number,
    specs: CandidateSpec[],
    status: string,
  ): Promise<void> {
    this.assertIdle();
    if (version !== this.version())
      throw new Failure("OUTDATED_VERSION", 409, "Objective inputs changed");
    const reduction = this.storage.sql
      .exec<{ summary: string }>(
        "SELECT summary FROM reductions WHERE version = ?",
        version,
      )
      .toArray()[0];
    if (!reduction)
      throw new Failure(
        "REDUCTION_REQUIRED",
        409,
        "Reduction record is unavailable",
      );
    const summary = JSON.parse(reduction.summary);
    const expected = new Set<string>(summary.candidate_spec_digests);
    if (
      expected.size !== specs.length ||
      !specs.length ||
      specs.some((spec) => !expected.has(spec.spec_digest)) ||
      summary.status !== status
    )
      throw new Failure(
        "INVALID_REDUCTION",
        409,
        "Candidate plans differ from the recorded reduction",
      );
    const base = this.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM metadata WHERE key = ?",
        "base_oid",
      )
      .one().value;
    const sealed: CandidateSpec[] = [];
    for (const spec of specs) {
      const verified = await sealCandidateSpec(spec);
      if (
        verified.id !== spec.id ||
        verified.spec_digest !== spec.spec_digest ||
        Object.keys(spec.base_revisions).length !== 1 ||
        spec.base_revisions[scope.repo_id] !== base
      )
        throw new Failure(
          "INVALID_CANDIDATE",
          409,
          "Candidate plan identity or base differs",
        );
      const effects = this.sources(spec).map(
        (source) => source.effects.effect_digest,
      );
      if (
        (await hashProjection(
          "klocgit.effect-summary",
          [...new Set(effects)].sort(),
        )) !== spec.effect_summary_digest
      )
        throw new Failure(
          "INVALID_CANDIDATE",
          409,
          "Candidate effect summary differs",
        );
      bounded(verified);
      sealed.push(verified);
    }
    this.storage.transactionSync(() => {
      this.assertIdle();
      if (version !== this.version())
        throw new Failure("OUTDATED_VERSION", 409, "Objective inputs changed");
      for (const spec of sealed) {
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO candidate_slots (version, spec_id, schema_version, spec, status) VALUES (?, ?, 1, ?, 'PENDING')",
          version,
          spec.id,
          JSON.stringify(spec),
        );
        const payload = {
          schema_version: 1,
          operation: "evaluate",
          scope,
          version,
          spec_id: spec.id,
        };
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO outbox (job_id, version, payload, actor_id, expires_at, status) VALUES (?, ?, ?, 'engine', ?, 'PENDING')",
          "evaluate-" + version + "-" + spec.id,
          version,
          JSON.stringify(payload),
          Date.now() + 86400000,
        );
      }
      this.audit("candidates.discovered", "engine", String(version));
    });
  }

  async input(
    scope: Scope,
    version: number,
    specId: string,
  ): Promise<{ candidate_spec: CandidateSpec; sources: unknown[] } | null> {
    if (version !== this.version()) return null;
    const slot = this.slots(version).find((row) => row.spec_id === specId);
    if (!slot)
      throw new Failure("NOT_FOUND", 404, "Candidate plan is unavailable");
    if (slot.status === "COMPLETE") {
      await this.assemble(scope, version);
      return null;
    }
    const candidate_spec = JSON.parse(slot.spec) as CandidateSpec;
    return { candidate_spec, sources: this.sources(candidate_spec) };
  }

  async evaluated(
    scope: Scope,
    version: number,
    specId: string,
    supplied: Candidate,
    suppliedEvidence: Evidence,
  ): Promise<void> {
    this.assertIdle();
    if (version !== this.version()) return;
    const slot = this.slots(version).find((row) => row.spec_id === specId);
    if (!slot)
      throw new Failure("NOT_FOUND", 404, "Candidate plan is unavailable");
    const candidate = await sealCandidate(supplied);
    const evidence = await sealEvidence(suppliedEvidence);
    if (
      candidate.id !== supplied.id ||
      candidate.candidate_digest !== supplied.candidate_digest ||
      candidate.candidate_spec_id !== specId ||
      Object.keys(candidate.repo_tree_oids).length !== 1 ||
      !candidate.repo_tree_oids[scope.repo_id] ||
      evidence.evidence_digest !== suppliedEvidence.evidence_digest ||
      evidence.id !== suppliedEvidence.id ||
      evidence.subject_digest !== candidate.candidate_digest
    )
      throw new Failure(
        "INVALID_EVALUATION",
        409,
        "Evaluation state binding differs",
      );
    const stored = await new EvidenceStore(this.env.PAYLOADS).load(
      scope.tenant_id,
      evidence.evidence_digest,
    );
    if (stored.evidence.subject_digest !== candidate.candidate_digest)
      throw new Failure(
        "INVALID_EVALUATION",
        409,
        "Persisted evidence belongs to another candidate",
      );
    this.storage.transactionSync(() => {
      this.assertIdle();
      if (version !== this.version()) return;
      const prior = this.slots(version).find((row) => row.spec_id === specId)!;
      if (
        prior.candidate &&
        JSON.parse(prior.candidate).candidate_digest !==
          candidate.candidate_digest
      )
        throw new Failure(
          "IMMUTABLE_RECORD_CHANGED",
          409,
          "Materialized candidate already exists",
        );
      const observations: Evidence[] = prior.evidence
        ? JSON.parse(prior.evidence)
        : [];
      if (
        !observations.some(
          (record) => record.evidence_digest === evidence.evidence_digest,
        )
      )
        observations.push(stored.evidence);
      observations.sort((a, b) =>
        a.evidence_digest.localeCompare(b.evidence_digest),
      );
      this.storage.sql.exec(
        "UPDATE candidate_slots SET status = 'COMPLETE', candidate = ?, evidence = ? WHERE version = ? AND spec_id = ?",
        prior.candidate ?? JSON.stringify(candidate),
        JSON.stringify(observations),
        version,
        specId,
      );
      this.audit("candidate.evaluated", "engine", candidate.id);
    });
    await this.assemble(scope, version);
  }

  private async assemble(scope: Scope, version: number): Promise<void> {
    const slots = this.slots(version);
    if (!slots.length || slots.some((slot) => slot.status !== "COMPLETE"))
      return;
    const reduction = JSON.parse(
      this.storage.sql
        .exec<{ summary: string }>(
          "SELECT summary FROM reductions WHERE version = ?",
          version,
        )
        .one().summary,
    );
    const candidates = slots.map((slot): CandidateAnalysis => {
      const spec = JSON.parse(slot.spec) as CandidateSpec;
      return {
        spec,
        candidate: JSON.parse(slot.candidate!),
        effects: this.sources(spec).map((source) => source.effects),
      };
    });
    const effects = new Map(
      candidates
        .flatMap((state) => state.effects)
        .map((effect) => [effect.effect_digest, effect]),
    );
    const evidence = slots.flatMap(
      (slot) => JSON.parse(slot.evidence!) as Evidence[],
    );
    const reviewPolicy = policy(this.env);
    const basis = await sealDecisionBasis({
      candidate_digests: candidates.map(
        (state) => state.candidate.candidate_digest,
      ),
      evidence_digests: evidence.map((record) => record.evidence_digest),
      material_effect_digest: await hashProjection(
        "klocgit.effect-summary",
        [...effects.keys()].sort(),
      ),
      policy_digest: await policyDigest(reviewPolicy),
      canonical_ref_oids: candidates[0].spec.base_revisions,
      required_analysis_status: Object.fromEntries(
        [...effects].map(([digest, effect]) => [digest, effect.status]),
      ),
    });
    const decisionId = await hashProjection("klocgit.decision", {
      scope,
      version,
      reduction_digest: reduction.reduction_digest ?? basis.candidate_digests,
    });
    const existing = this.storage.sql
      .exec<{ packet: string }>(
        "SELECT packet FROM decisions WHERE decision_id = ?",
        decisionId,
      )
      .toArray()[0];
    if (existing) {
      const previous = JSON.parse(existing.packet) as DecisionPacket;
      if (previous.decision.basis.basis_digest === basis.basis_digest) return;
      if (previous.decision.state === "RESOLVED") {
        this.audit("evidence.after_resolution", "engine", decisionId);
        return;
      }
    }
    const packet: DecisionPacket = {
      schema_version: 1,
      version,
      reduction_status: reduction.status,
      review_sequence: 0,
      decision: DecisionLifecycle.inspect({
        id: decisionId,
        objective_id: scope.objective_id,
        basis,
        state: "DISCOVERED",
        conditional_predicates: [],
      }),
      question:
        candidates.length === 1
          ? "Accept the composed changes?"
          : "Which candidate should be accepted?",
      candidates,
      evidence,
      blockers: {},
    };
    await this.evaluate(packet, reviewPolicy);
    const serialized = bounded(packet);
    this.storage.transactionSync(() => {
      this.assertIdle();
      if (version !== this.version()) return;
      if (packet.review_sequence !== this.reviewSequence(packet.decision.id))
        throw new Failure("REVIEW_CHANGED", 409, "Review eligibility changed");
      if (existing) {
        const previous = JSON.parse(existing.packet) as DecisionPacket;
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO decision_bases (decision_id, basis_digest, schema_version, packet) VALUES (?, ?, 1, ?)",
          decisionId,
          previous.decision.basis.basis_digest,
          existing.packet,
        );
      }
      this.storage.sql.exec(
        "INSERT INTO decisions (decision_id, version, schema_version, packet) VALUES (?, ?, 1, ?) ON CONFLICT(decision_id) DO UPDATE SET packet = excluded.packet",
        decisionId,
        version,
        serialized,
      );
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO decision_bases (decision_id, basis_digest, schema_version, packet) VALUES (?, ?, 1, ?)",
        decisionId,
        basis.basis_digest,
        serialized,
      );
      this.audit("decision.reviewable", "engine", decisionId);
    });
  }

  private reviews(decision: string): { sequence: number; reviews: Review[] } {
    const rows = this.storage.sql
      .exec<{ record: string; sequence: number }>(
        "SELECT record, sequence FROM decision_reviews WHERE decision_id = ? AND sequence IN (SELECT MAX(sequence) FROM decision_reviews WHERE decision_id = ? GROUP BY actor_id) ORDER BY sequence",
        decision,
        decision,
      )
      .toArray();
    return {
      sequence: rows.at(-1)?.sequence ?? 0,
      reviews: rows.map((row) => JSON.parse(row.record)),
    };
  }

  private reviewSequence(decision: string): number {
    return this.storage.sql
      .exec<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM decision_reviews WHERE decision_id = ?",
        decision,
      )
      .one().sequence;
  }

  private async evaluate(
    packet: DecisionPacket,
    reviewPolicy: ReviewPolicy,
  ): Promise<void> {
    const evaluator = new PolicyEvaluator(reviewPolicy);
    const { sequence, reviews } = this.reviews(packet.decision.id);
    packet.review_sequence = sequence;
    let ready = false;
    for (const analysis of packet.candidates) {
      const result = await evaluator.canResolve(packet.decision.basis, {
        ...analysis,
        alternatives: packet.candidates.filter((state) => state !== analysis),
        evidence: packet.evidence,
        reviews,
      });
      packet.blockers[analysis.candidate.candidate_digest] = result.blockers;
      if (packet.reduction_status !== "COMPLETE")
        packet.blockers[analysis.candidate.candidate_digest].push({
          code: "REDUCTION_INCOMPLETE",
          subject: packet.decision.id,
        });
      ready ||= result.allowed && packet.reduction_status === "COMPLETE";
    }
    if (["REVIEWABLE", "RESOLVABLE"].includes(packet.decision.state))
      packet.decision = {
        ...packet.decision,
        state: ready ? "RESOLVABLE" : "REVIEWABLE",
      };
  }

  private load(id: string): DecisionPacket {
    const row = this.storage.sql
      .exec<{ packet: string }>(
        "SELECT packet FROM decisions WHERE decision_id = ?",
        id,
      )
      .toArray()[0];
    if (!row) throw new Failure("NOT_FOUND", 404, "Decision is unavailable");
    return JSON.parse(row.packet);
  }

  private save(packet: DecisionPacket): void {
    if (packet.review_sequence !== this.reviewSequence(packet.decision.id))
      throw new Failure(
        "REVIEW_CHANGED",
        409,
        "Review eligibility changed; refresh the decision",
      );
    this.storage.sql.exec(
      "UPDATE decisions SET packet = ? WHERE decision_id = ?",
      bounded(packet),
      packet.decision.id,
    );
  }

  private async current(
    scope: Scope,
    packet: DecisionPacket,
  ): Promise<ReviewPolicy> {
    const reviewPolicy = policy(this.env);
    const head = await new GitStore(
      this.env.GIT_EXECUTOR,
      this.env.INTERNAL_SIGNING_KEY,
    ).observe(scope, this.env.CANONICAL_REF);
    if (
      packet.version !== this.version() ||
      packet.decision.basis.policy_digest !==
        (await policyDigest(reviewPolicy)) ||
      packet.decision.basis.canonical_ref_oids[scope.repo_id] !==
        head.commit_oid ||
      packet.decision.state === "STALE"
    ) {
      const latest = this.load(packet.decision.id);
      if (latest.decision.state !== "RESOLVED") {
        latest.decision = DecisionLifecycle.stale(latest.decision);
        this.save(latest);
      }
      Object.assign(packet, latest);
      throw new Failure(
        "STALE_BASIS",
        409,
        "Decision inputs changed; review the current state",
      );
    }
    return reviewPolicy;
  }

  async list(scope: Scope): Promise<{
    schema_version: number;
    decisions: DecisionPacket[];
    pending_candidates: number;
    policy_configured: boolean;
  }> {
    const rows = this.storage.sql
      .exec<{ packet: string }>(
        "SELECT packet FROM decisions ORDER BY version DESC LIMIT 100",
      )
      .toArray();
    const decisions: DecisionPacket[] = [];
    for (const row of rows) {
      const packet = JSON.parse(row.packet) as DecisionPacket;
      if (packet.decision.state === "RESOLVED") continue;
      const pending =
        this.storage.sql
          .exec(
            "SELECT 1 FROM decision_operations WHERE decision_id = ? AND active_slot = 1 LIMIT 1",
            packet.decision.id,
          )
          .toArray().length > 0;
      if (packet.decision.state !== "STALE" && !pending) {
        try {
          await this.current(scope, packet);
        } catch (error) {
          if (!(error instanceof Failure && error.code === "STALE_BASIS"))
            throw error;
        }
      }
      const latest = this.load(packet.decision.id);
      if (latest.decision.state !== "RESOLVED") decisions.push(latest);
    }
    return {
      schema_version: 1,
      decisions,
      pending_candidates: this.slots(this.version()).filter(
        (slot) => slot.status !== "COMPLETE",
      ).length,
      policy_configured: !!this.env.REVIEW_POLICY,
    };
  }

  private async requestDigest(input: ReviewCommand): Promise<string> {
    if (
      input.schema_version !== 1 ||
      !input.idempotency_key ||
      input.idempotency_key.length > 256 ||
      input.principal.actor_type !== "human"
    )
      throw new Failure(
        "FORBIDDEN",
        403,
        "A scoped human identity and operation key are required",
      );
    return hashProjection("klocgit.decision-request", {
      scope: input.scope,
      decision_id: input.decision_id,
      basis_digest: input.basis_digest,
      candidate_digest: input.candidate_digest,
      actor_id: input.principal.sub,
      predicates: input.predicates ?? [],
      author: input.author ?? null,
    });
  }

  async review(input: ReviewCommand): Promise<DecisionPacket> {
    this.assertIdle();
    const request_digest = await this.requestDigest(input);
    const packet = this.load(input.decision_id);
    if (
      packet.decision.basis.basis_digest !== input.basis_digest ||
      packet.decision.state === "RESOLVED"
    )
      throw new Failure("STALE_BASIS", 409, "Review basis differs");
    const reviewPolicy = await this.current(input.scope, packet);
    if (
      !packet.candidates.some(
        (state) => state.candidate.candidate_digest === input.candidate_digest,
      ) ||
      !reviewPolicy.reviewer_actor_ids.includes(input.principal.sub)
    )
      throw new Failure(
        "FORBIDDEN",
        403,
        "Reviewer or candidate is not eligible",
      );
    const predicates = input.predicates ?? [];
    if (
      !Array.isArray(predicates) ||
      predicates.length > 32 ||
      predicates.some(
        (item) =>
          ![
            "EVIDENCE_PASSED",
            "ANALYSIS_COMPLETE",
            "CANDIDATE_UNCHANGED",
            "EFFECTS_UNCHANGED",
          ].includes(item.kind) ||
          typeof item.subject !== "string" ||
          item.subject.length > 256 ||
          (item.expected !== undefined &&
            (typeof item.expected !== "string" || item.expected.length > 256)),
      )
    )
      throw new Failure("INVALID_INPUT", 400, "Review predicates are invalid");
    const record: Review = {
      schema_version: 1,
      actor_id: input.principal.sub,
      actor_type: "human",
      candidate_digest: input.candidate_digest,
      candidate_digests: packet.decision.basis.candidate_digests,
      basis_digest: input.basis_digest,
      policy_digest: packet.decision.basis.policy_digest,
      material_effect_digest: packet.decision.basis.material_effect_digest,
      predicates,
    };
    this.storage.transactionSync(() => {
      this.assertIdle();
      if (packet.version !== this.version())
        throw new Failure("STALE_BASIS", 409, "Objective inputs changed");
      const prior = this.storage.sql
        .exec<{ request_digest: string }>(
          "SELECT request_digest FROM review_receipts WHERE idempotency_key = ?",
          input.idempotency_key,
        )
        .toArray()[0];
      if (prior) {
        if (prior.request_digest !== request_digest)
          throw new Failure(
            "IDEMPOTENCY_MISMATCH",
            409,
            "Review key belongs to different inputs",
          );
        return;
      }
      this.storage.sql.exec(
        "INSERT INTO decision_reviews (decision_id, actor_id, schema_version, record) VALUES (?, ?, 1, ?)",
        packet.decision.id,
        input.principal.sub,
        JSON.stringify(record),
      );
      this.storage.sql.exec(
        "INSERT INTO review_receipts (idempotency_key, request_digest, decision_id) VALUES (?, ?, ?)",
        input.idempotency_key,
        request_digest,
        packet.decision.id,
      );
      this.audit(
        "decision.reviewed",
        input.principal.sub,
        input.idempotency_key,
      );
    });
    await this.evaluate(packet, reviewPolicy);
    this.assertIdle();
    if (packet.version !== this.version())
      throw new Failure("STALE_BASIS", 409, "Objective inputs changed");
    this.save(packet);
    return packet;
  }

  private operation(key: string): Operation | undefined {
    return this.storage.sql
      .exec<Operation>(
        "SELECT request_digest, command, status, result FROM decision_operations WHERE idempotency_key = ?",
        key,
      )
      .toArray()[0];
  }

  async promotionInput(input: ReviewCommand): Promise<Record<string, unknown>> {
    const request_digest = await this.requestDigest(input);
    const prior = this.operation(input.idempotency_key);
    if (prior) {
      if (prior.request_digest !== request_digest)
        throw new Failure(
          "IDEMPOTENCY_MISMATCH",
          409,
          "Promotion inputs differ",
        );
      return { schema_version: 1, prior_command: JSON.parse(prior.command) };
    }
    this.assertIdle();
    const packet = this.load(input.decision_id);
    if (
      packet.decision.basis.basis_digest !== input.basis_digest ||
      packet.decision.state === "RESOLVED"
    )
      throw new Failure("STALE_BASIS", 409, "Promotion basis differs");
    const reviewPolicy = await this.current(input.scope, packet);
    await this.evaluate(packet, reviewPolicy);
    if (packet.blockers[input.candidate_digest]?.length !== 0)
      throw new Failure(
        "POLICY_BLOCKED",
        422,
        "Required analysis, evidence or reviews are incomplete",
      );
    const analysis = packet.candidates.find(
      (state) => state.candidate.candidate_digest === input.candidate_digest,
    );
    if (!analysis)
      throw new Failure("NOT_FOUND", 404, "Candidate is unavailable");
    this.save(packet);
    return {
      schema_version: 1,
      candidate_spec: analysis.spec,
      sources: this.sources(analysis.spec),
      candidate_digest: input.candidate_digest,
      expected_oid:
        packet.decision.basis.canonical_ref_oids[input.scope.repo_id],
      decision_id: input.decision_id,
      basis_digest: input.basis_digest,
    };
  }

  async promote(
    input: ReviewCommand,
    prepared?: PreparedCandidate,
  ): Promise<unknown> {
    const request_digest = await this.requestDigest(input);
    let prior = this.operation(input.idempotency_key);
    if (prior && prior.request_digest !== request_digest)
      throw new Failure("IDEMPOTENCY_MISMATCH", 409, "Promotion inputs differ");
    if (prior?.status === "APPLIED") return JSON.parse(prior.result!);
    if (prior?.status === "NO_EFFECT")
      throw new Failure("STALE_BASIS", 409, "Previous promotion had no effect");
    if (!prior) {
      await this.promotionInput(input);
      const packet = this.load(input.decision_id);
      const state = packet.candidates.find(
        (item) => item.candidate.candidate_digest === input.candidate_digest,
      )!;
      if (
        !prepared ||
        prepared.schema_version !== 1 ||
        prepared.candidate_digest !== input.candidate_digest ||
        prepared.expected_oid !==
          packet.decision.basis.canonical_ref_oids[input.scope.repo_id] ||
        prepared.tree_oid !==
          state.candidate.repo_tree_oids[input.scope.repo_id] ||
        !/^[0-9a-f]{40}$/.test(prepared.target_oid) ||
        !/^sha256:[0-9a-f]{64}$/.test(prepared.payload_digest)
      )
        throw new Failure(
          "CANDIDATE_CHANGED",
          409,
          "Prepared Git state differs from the reviewed candidate",
        );
      const command: PromotionCommand = {
        schema_version: 1,
        scope: input.scope,
        ref: this.env.CANONICAL_REF,
        decision_id: input.decision_id,
        basis_digest: input.basis_digest,
        expected_oid: prepared.expected_oid,
        target_oid: prepared.target_oid,
        actor_id: input.principal.sub,
        idempotency_key: input.idempotency_key,
        promotion_pack: {
          payload_digest: prepared.payload_digest,
          candidate_digest: input.candidate_digest,
          tree_oid: prepared.tree_oid,
        },
      };
      this.storage.transactionSync(() => {
        this.assertIdle();
        if (
          packet.version !== this.version() ||
          packet.review_sequence !== this.reviewSequence(packet.decision.id)
        )
          throw new Failure(
            "STALE_BASIS",
            409,
            "Objective inputs or reviews changed",
          );
        this.storage.sql.exec(
          "INSERT INTO decision_operations (idempotency_key, request_digest, decision_id, schema_version, command, status, active_slot) VALUES (?, ?, ?, 1, ?, 'PREPARED', 1)",
          input.idempotency_key,
          request_digest,
          input.decision_id,
          JSON.stringify(command),
        );
        this.audit(
          "decision.promotion_prepared",
          input.principal.sub,
          input.idempotency_key,
        );
      });
      prior = this.operation(input.idempotency_key)!;
    }
    const command = JSON.parse(prior.command) as PromotionCommand;
    const statusResponse = await callRef(this.env, "status", command);
    if (!statusResponse.ok)
      throw new Failure(
        "RECONCILIATION_REQUIRED",
        503,
        "Ref operation status is unavailable",
      );
    const status = await readJson<{ status: string; result: unknown }>(
      statusResponse,
    );
    if (status.status === "NOT_STARTED") {
      const packet = this.load(input.decision_id);
      try {
        const reviewPolicy = await this.current(input.scope, packet);
        await this.evaluate(packet, reviewPolicy);
        if (
          packet.decision.basis.basis_digest !== input.basis_digest ||
          packet.blockers[input.candidate_digest]?.length !== 0
        )
          throw new Failure(
            "STALE_BASIS",
            409,
            "Promotion authorization changed",
          );
        this.save(packet);
      } catch (error) {
        if (
          error instanceof Failure &&
          ["STALE_BASIS", "POLICY_BLOCKED", "REVIEW_CHANGED"].includes(
            error.code,
          )
        )
          this.storage.sql.exec(
            "UPDATE decision_operations SET status = 'NO_EFFECT', active_slot = NULL WHERE idempotency_key = ?",
            input.idempotency_key,
          );
        throw error;
      }
      // Pin the facts that authorize this operation before publishing Git state.
      const store = new EvidenceStore(this.env.PAYLOADS);
      for (const evidence of packet.evidence) {
        const loaded = await store.load(
          input.scope.tenant_id,
          evidence.evidence_digest,
        );
        await store.persist(
          input.scope.tenant_id,
          { ...loaded.evidence, retention_class: "CANONICAL" },
          loaded.payload,
        );
      }
      const authorization = await callRef(this.env, "authorize", command);
      if (!authorization.ok)
        throw new Failure(
          "RECONCILIATION_REQUIRED",
          503,
          "Ref authorization requires reconciliation",
        );
    }
    const response = await callRef(this.env, "promote", command);
    if (!response.ok) {
      if (response.status === 409) {
        this.storage.transactionSync(() => {
          this.storage.sql.exec(
            "UPDATE decision_operations SET status = 'NO_EFFECT', active_slot = NULL WHERE idempotency_key = ?",
            input.idempotency_key,
          );
          const packet = this.load(input.decision_id);
          packet.decision = DecisionLifecycle.stale(packet.decision);
          this.save(packet);
          this.audit(
            "decision.promotion_no_effect",
            input.principal.sub,
            input.idempotency_key,
          );
        });
        throw new Failure(
          "STALE_BASIS",
          409,
          "Canonical state changed; review the current state",
        );
      }
      throw new Failure(
        "RECONCILIATION_REQUIRED",
        503,
        "Canonical outcome requires reconciliation",
      );
    }
    const receipt = await readJson<{
      status: "APPLIED";
      expected_oid: string;
      target_oid: string;
      decision_id: string;
      basis_digest: string;
    }>(response);
    if (
      receipt.status !== "APPLIED" ||
      receipt.expected_oid !== command.expected_oid ||
      receipt.target_oid !== command.target_oid ||
      receipt.decision_id !== input.decision_id ||
      receipt.basis_digest !== input.basis_digest
    )
      throw new Failure(
        "RECONCILIATION_REQUIRED",
        503,
        "Canonical receipt binding differs",
      );
    this.storage.transactionSync(() => {
      const packet = this.load(input.decision_id);
      packet.decision = DecisionLifecycle.resolve(
        packet.decision,
        input.basis_digest,
        input.principal.sub,
        receipt,
      );
      this.save(packet);
      this.storage.sql.exec(
        "UPDATE decision_operations SET status = 'APPLIED', active_slot = NULL, result = ? WHERE idempotency_key = ?",
        JSON.stringify(receipt),
        input.idempotency_key,
      );
      this.audit("decision.resolved", input.principal.sub, input.decision_id);
    });
    return receipt;
  }
}
