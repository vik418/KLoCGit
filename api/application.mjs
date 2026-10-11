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

export function createV1Application({ scope: scopeInput, backend, workProvider, gitStore, materializer, evidenceProvider, payloadStore, observeSnapshot, authorize, authenticate, verifyProvenance, verifyRejection, canReuse, requiredAnalysis, limits }) {
  const scope = coordinationScope(scopeInput);
  const store = new CoordinationStore(backend);
  const observeRef = (repo, ref) => gitStore.observe_ref(repo, ref);
  const policyEvaluator = { can_reuse: canReuse, required_analysis: requiredAnalysis };
  const convergence = new ConvergenceService({
    store, workProvider, materializer, observeRef, authorize,
    reducer: new CandidateReducer({ verifyRejection }),
    scheduler: new EvidenceScheduler({ provider: evidenceProvider, verifyProvenance, policyEvaluator, limits: limits.evidence }),
    formulator: new DecisionFormulator({ verifyProvenance, policyEvaluator, limits: limits.formulation }),
    limits: limits.convergence,
  });
  const policy = async (state) => createCandidatePolicy({ candidate: state.candidate, requirements: state.requirements, required_analysis: await requiredAnalysis(state.subject, state.effects), evidence: state.evidence, verifyProvenance, canReuse, max_evidence: limits.convergence.max_evidence });
  const resolution = new ResolutionService({ store, basisProvider: convergence, policyEvaluator: policy, observeRef, payloadStore, authorize, max_evidence: limits.convergence.max_evidence });
  const promotion = new PromotionService({ store, gitStore, observeSnapshot, basisProvider: convergence, policyEvaluator: policy, authorize });
  return Object.freeze({ store, convergence, resolution, promotion, fetch: createConvergenceHandler({ scope, authenticate, convergence, resolution, promotion, max_request_bytes: limits.max_request_bytes }) });
}
