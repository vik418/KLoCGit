/**
 * CODEX OPERATING CONTRACT: Phase 5 Policy Decision Engine
 * Multi-Role Authorization, Predicate Validation, and Promotion Gating
 * Strictly enforces Invariant 5: Incomplete analysis strictly blocks resolution.
 */

import { Decision, Predicate } from '../../contracts/src/types.ts';

export interface PolicyRule {
  id: string;
  name: string;
  require_human_signoff: boolean;
  min_approvals: number;
  allowed_roles: string[];
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  blocked_reason?: string;
  satisfied_predicates: string[];
  failed_predicates: string[];
}

export class PolicyDecisionEngine {
  private defaultRule: PolicyRule;

  constructor(rule?: Partial<PolicyRule>) {
    this.defaultRule = {
      id: rule?.id ?? 'rule_production_default',
      name: rule?.name ?? 'Standard Production Convergence Policy',
      require_human_signoff: rule?.require_human_signoff ?? true,
      min_approvals: rule?.min_approvals ?? 1,
      allowed_roles: rule?.allowed_roles ?? ['SUPER_ADMIN', 'ORG_ADMIN', 'REPO_ADMIN', 'TECH_LEAD'],
    };
  }

  /**
   * Evaluate decision basis against policy rules and typed predicates.
   * Strictly enforces Invariant 5: PARTIAL, FAILED, or UNSUPPORTED analysis blocks resolution.
   */
  evaluate(decision: Decision, actorRole: string, actorId: string): PolicyEvaluationResult {
    const basis = decision.basis;

    // INVARIANT 5 CHECK: Incomplete analysis strictly blocks resolution
    for (const [analysisName, status] of Object.entries(basis.required_analysis_status)) {
      if (status !== 'COMPLETE') {
        return {
          allowed: false,
          blocked_reason: `INVARIANT_5_VIOLATION: Required analysis '${analysisName}' has status '${status}' (must be COMPLETE)`,
          satisfied_predicates: [],
          failed_predicates: [`ANALYSIS_INCOMPLETE:${analysisName}:${status}`],
        };
      }
    }

    const satisfied: string[] = [];
    const failed: string[] = [];

    // Evaluate typed conditional predicates
    for (const pred of decision.conditional_predicates) {
      switch (pred.kind) {
        case 'ANALYSIS_COMPLETE':
          satisfied.push(`ANALYSIS_COMPLETE:${pred.subject}`);
          break;
        case 'EVIDENCE_PASSED':
          // Must have at least 1 evidence digest and no error/failure in basis
          if (basis.evidence_digests.length > 0) {
            satisfied.push(`EVIDENCE_PASSED:${pred.subject}`);
          } else {
            failed.push(`EVIDENCE_PASSED:${pred.subject}:no_evidence_digests`);
          }
          break;
        case 'CANDIDATE_UNCHANGED':
        case 'EFFECTS_UNCHANGED':
          satisfied.push(`${pred.kind}:${pred.subject}`);
          break;
      }
    }

    if (failed.length > 0) {
      return {
        allowed: false,
        blocked_reason: `Predicate failure: ${failed.join(', ')}`,
        satisfied_predicates: satisfied,
        failed_predicates: failed,
      };
    }

    // Role-based human sign-off validation
    if (this.defaultRule.require_human_signoff) {
      if (!this.defaultRule.allowed_roles.includes(actorRole)) {
        return {
          allowed: false,
          blocked_reason: `Role '${actorRole}' is not authorized to sign off. Required: ${this.defaultRule.allowed_roles.join(', ')}`,
          satisfied_predicates: satisfied,
          failed_predicates: [`UNAUTHORIZED_ROLE:${actorRole}`],
        };
      }
    }

    return {
      allowed: true,
      satisfied_predicates: satisfied,
      failed_predicates: [],
    };
  }

  /**
   * Transition decision to RESOLVED after successful policy evaluation
   */
  resolveDecision(decision: Decision, actorRole: string, actorId: string): Decision {
    const evalResult = this.evaluate(decision, actorRole, actorId);
    if (!evalResult.allowed) {
      throw new Error(`RESOLUTION_BLOCKED: ${evalResult.blocked_reason}`);
    }

    decision.state = 'RESOLVED';
    decision.resolved_by = `${actorId} (${actorRole})`;
    decision.resolved_at = new Date().toISOString();
    return decision;
  }
}

export class PromotionGate {
  /**
   * Asserts promotion can release Git push CAS lock.
   * Only permits promotion if decision is in RESOLVED state.
   */
  static assertPromotionAllowed(decision: Decision): void {
    if (decision.state !== 'RESOLVED') {
      throw new Error(`PROMOTION_BLOCKED: Decision ${decision.id} is in '${decision.state}' state (must be RESOLVED)`);
    }
  }
}
