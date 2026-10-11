# Tenant and capability authorization

Status: accepted. Resolves D004.

Use verified OIDC identities through the existing issuer/audience/JWKS verifier. The authoritative identity registry maps an authenticated actor to its tenant and human, service or agent role. Token claims and request headers cannot grant tenancy or permissions.

Authorization evaluates current versioned grants for each privileged operation. Agents require an explicit capability ID and exact action/resource matching. Human and service grants may explicitly cover a system. Wildcard actions, expired grants, revoked grants and incomplete registry reads deny authorization.

Provider authentication stays outside domain types. Local owner credentials remain a configured development/bootstrap identity; they do not bypass tenant grants.

Tests exercise scope expansion, current revocation, foreign identities, registry outages and untrusted input accessors. Production identity routing is verified during application integration.
