/**
 * CODEX OPERATING CONTRACT: Phase 2 Coordination Plane
 * Identity & Authorization Engine (Tenant Scoping & Capability Tokens)
 */

import { createHmac, randomUUID } from 'node:crypto';

export type Role = 'SUPER_ADMIN' | 'ORG_ADMIN' | 'REPO_ADMIN' | 'ENGINEER' | 'AGENT' | 'OBSERVER';

export type Permission =
  | 'repo:read'
  | 'repo:write'
  | 'future:submit'
  | 'candidate:propose'
  | 'candidate:resolve'
  | 'promotion:cas_push'
  | 'policy:manage'
  | 'admin:all';

export interface ResourceScope {
  tenant_id: string;
  org_id?: string;
  repo_id?: string;
  ref?: string;
  objective_id?: string;
}

export interface AuthContext {
  principal_id: string;
  role: Role;
  scope: ResourceScope;
  permissions?: Permission[];
}

export interface AgentCapabilityToken {
  token_id: string;
  agent_id: string;
  tenant_id: string;
  repo_id: string;
  objective_id?: string;
  allowed_actions: string[];
  budget_max: number;
  budget_consumed: number;
  expires_at: string; // ISO 8601 UTC
  signature: string;
}

const SECRET_KEY = 'klocgit-authz-signing-secret-v1';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ['admin:all', 'repo:read', 'repo:write', 'future:submit', 'candidate:propose', 'candidate:resolve', 'promotion:cas_push', 'policy:manage'],
  ORG_ADMIN: ['repo:read', 'repo:write', 'future:submit', 'candidate:propose', 'candidate:resolve', 'promotion:cas_push', 'policy:manage'],
  REPO_ADMIN: ['repo:read', 'repo:write', 'future:submit', 'candidate:propose', 'candidate:resolve', 'promotion:cas_push'],
  ENGINEER: ['repo:read', 'repo:write', 'future:submit', 'candidate:propose'],
  AGENT: ['repo:read', 'future:submit', 'candidate:propose'],
  OBSERVER: ['repo:read'],
};

/**
 * Deny-by-default permission check enforcing resource hierarchy.
 */
export function checkPermission(
  ctx: AuthContext,
  requiredPermission: Permission,
  targetScope: ResourceScope
): { allowed: boolean; reason?: string } {
  // 1. Tenant boundary must match strictly
  if (ctx.scope.tenant_id !== targetScope.tenant_id) {
    return { allowed: false, reason: `Cross-tenant access denied: ${ctx.scope.tenant_id} != ${targetScope.tenant_id}` };
  }

  // 2. Org boundary check if scoped
  if (targetScope.org_id && ctx.scope.org_id && ctx.scope.org_id !== targetScope.org_id) {
    return { allowed: false, reason: `Cross-org access denied: ${ctx.scope.org_id} != ${targetScope.org_id}` };
  }

  // 3. Repo boundary check if scoped
  if (targetScope.repo_id && ctx.scope.repo_id && ctx.scope.repo_id !== targetScope.repo_id) {
    return { allowed: false, reason: `Cross-repo access denied: ${ctx.scope.repo_id} != ${targetScope.repo_id}` };
  }

  // 4. Role-based permission evaluation (deny-by-default)
  const rolePerms = ROLE_PERMISSIONS[ctx.role] || [];
  if (rolePerms.includes('admin:all') || rolePerms.includes(requiredPermission)) {
    return { allowed: true };
  }

  // 5. Explicit permission overrides if any
  if (ctx.permissions && ctx.permissions.includes(requiredPermission)) {
    return { allowed: true };
  }

  return { allowed: false, reason: `Principal ${ctx.principal_id} (${ctx.role}) lacks permission ${requiredPermission}` };
}

export function assertAuthorized(ctx: AuthContext, requiredPermission: Permission, targetScope: ResourceScope): void {
  const check = checkPermission(ctx, requiredPermission, targetScope);
  if (!check.allowed) {
    throw new Error(`AUTHZ_DENIED: ${check.reason}`);
  }
}

/**
 * Agent Capability Tokens with Hard Budgets and Expiry
 */
export class CapabilityTokenManager {
  private activeTokens: Map<string, AgentCapabilityToken> = new Map();

  issueToken(params: {
    agent_id: string;
    tenant_id: string;
    repo_id: string;
    objective_id?: string;
    allowed_actions: string[];
    budget_max: number;
    ttl_seconds: number;
  }): AgentCapabilityToken {
    const token_id = `cap_${randomUUID().replace(/-/g, '')}`;
    const expires_at = new Date(Date.now() + params.ttl_seconds * 1000).toISOString();

    const payload = `${token_id}:${params.agent_id}:${params.tenant_id}:${params.repo_id}:${params.allowed_actions.sort().join(',')}:${params.budget_max}:${expires_at}`;
    const signature = createHmac('sha256', SECRET_KEY).update(payload).digest('hex');

    const token: AgentCapabilityToken = {
      token_id,
      agent_id: params.agent_id,
      tenant_id: params.tenant_id,
      repo_id: params.repo_id,
      objective_id: params.objective_id,
      allowed_actions: params.allowed_actions,
      budget_max: params.budget_max,
      budget_consumed: 0,
      expires_at,
      signature,
    };

    this.activeTokens.set(token_id, token);
    return token;
  }

  verifyAndConsume(
    token_id: string,
    action: string,
    cost: number,
    targetScope: { tenant_id: string; repo_id: string }
  ): { allowed: boolean; remaining_budget: number; error?: string } {
    const token = this.activeTokens.get(token_id);
    if (!token) {
      return { allowed: false, remaining_budget: 0, error: 'Token not found or revoked' };
    }

    // Expiry verification
    const now = new Date().toISOString();
    if (now > token.expires_at) {
      return { allowed: false, remaining_budget: 0, error: `Token expired at ${token.expires_at}` };
    }

    // Scope check
    if (token.tenant_id !== targetScope.tenant_id || token.repo_id !== targetScope.repo_id) {
      return { allowed: false, remaining_budget: token.budget_max - token.budget_consumed, error: 'Target scope outside token boundary' };
    }

    // Action check
    if (!token.allowed_actions.includes(action) && !token.allowed_actions.includes('*')) {
      return { allowed: false, remaining_budget: token.budget_max - token.budget_consumed, error: `Action ${action} not permitted by capability token` };
    }

    // Budget check
    if (token.budget_consumed + cost > token.budget_max) {
      return {
        allowed: false,
        remaining_budget: token.budget_max - token.budget_consumed,
        error: `Budget exhausted: consumed ${token.budget_consumed}/${token.budget_max}, attempted cost ${cost}`,
      };
    }

    // Consume budget
    token.budget_consumed += cost;
    return { allowed: true, remaining_budget: token.budget_max - token.budget_consumed };
  }

  revoke(token_id: string): void {
    this.activeTokens.delete(token_id);
  }
}
