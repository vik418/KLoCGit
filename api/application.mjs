/** Assemble v1 services around a scoped authoritative backend and trusted adapters. */
import { CoordinationStore, coordinationScope } from '../core/v1/coordination.mjs';
import { CandidateReducer } from '../core/v1/candidate-reducer.mjs';
import { EvidenceScheduler } from '../core/v1/evidence-scheduling.mjs';
import { DecisionFormulator } from '../core/v1/decision-formulation.mjs';
import { ConvergenceService } from '../core/v1/convergence.mjs';
import { ResolutionService } from '../core/v1/resolution.mjs';
import { PromotionService } from '../core/v1/promotion.mjs';
import { createCandidatePolicy } from '../core/v1/decision-policy.mjs';
import { createConvergenceHandler } from './convergence.mjs';
import { copyJsonData } from '../core/v1/domain.mjs';
import { buildSystemRevision } from '../core/v1/releases.mjs';

export function createV1Application({
  scope: scopeInput,
  backend,
  workProvider,
  gitStore,
  materializer,
  evidenceProvider,
  payloadStore,
  observeSnapshot,
  authorize,
  authenticate,
  verifyProvenance,
  verifyRejection,
  canReuse,
  requiredAnalysis,
  limits,
}) {
  const scope = coordinationScope(scopeInput);
  limits = copyJsonData(limits);
  const store = new CoordinationStore(backend);
  const observeRef = (repo, ref) => gitStore.observe_ref(repo, ref);
  const policyEvaluator = { can_reuse: canReuse, required_analysis: requiredAnalysis };
  const convergence = new ConvergenceService({
    store,
    workProvider,
    materializer,
    observeRef,
    authorize,
    verifyProvenance,
    canReuse,
    reducer: new CandidateReducer({ verifyRejection }),
    scheduler: new EvidenceScheduler({
      provider: evidenceProvider,
      verifyProvenance,
      policyEvaluator,
      limits: limits.evidence,
    }),
    formulator: new DecisionFormulator({
      verifyProvenance,
      policyEvaluator,
      limits: limits.formulation,
    }),
    limits: limits.convergence,
  });
  const policy = async (state) =>
    createCandidatePolicy({
      candidate: state.candidate,
      requirements: state.requirements,
      required_analysis: await requiredAnalysis(state.subject, state.effects),
      evidence: state.evidence,
      verifyProvenance,
      canReuse,
      max_evidence: limits.convergence.max_evidence,
    });
  const resolution = new ResolutionService({
    store,
    basisProvider: convergence,
    policyEvaluator: policy,
    observeRef,
    payloadStore,
    authorize,
    max_evidence: limits.convergence.max_evidence,
  });
  const promotion = new PromotionService({
    store,
    gitStore,
    observeSnapshot,
    basisProvider: convergence,
    policyEvaluator: policy,
    authorize,
    recordAcceptance: async (tx, record) => {
      const revision = await buildSystemRevision({
        schema_version: 1,
        repositories: { [record.request.repo_id]: record.target_commit_oid },
        configuration_digests: { policy: record.authorized_decision.basis.policy_digest },
        accepted_decisions: [record.request.decision_id],
      });
      await tx.put('system-revision:' + revision.id, revision);
      await tx.put('accepted-system-revision', {
        schema_version: 1,
        id: revision.id,
        digest: revision.digest,
      });
      return revision.digest;
    },
  });
  return Object.freeze({
    store,
    convergence,
    resolution,
    promotion,
    fetch: createConvergenceHandler({
      scope,
      authenticate,
      convergence,
      resolution,
      promotion,
      max_request_bytes: limits.max_request_bytes,
    }),
  });
}
