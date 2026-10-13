import { sameScope, verifyToken } from "../auth.ts";
import { Failure, readJson, validateScope } from "../runtime.ts";
import type { Bindings, Scope } from "../runtime.ts";
import { ArtifactsObjectStore } from "../adapters/artifacts-objects.ts";
import { resolveRepository } from "./repositories.ts";
import type { ObjectRead } from "../adapters/artifacts-objects.ts";

export interface ObjectReadCapability {
  schema_version: 1;
  aud: "git-objects";
  scope: Scope;
  action: "read";
  expires_at: number;
  max_object_bytes: number;
}

/** Read capabilities authorize immutable objects only; they grant no ref mutation. */
export async function readObject(
  request: Request,
  env: Bindings,
): Promise<Response> {
  const token = request.headers.get("x-klocgit-object-capability");
  if (!token)
    throw new Failure("FORBIDDEN", 403, "Object read capability is required");
  const grant = await verifyToken<ObjectReadCapability>(
    token,
    env.INTERNAL_SIGNING_KEY,
  );
  if (
    grant.schema_version !== 1 ||
    grant.aud !== "git-objects" ||
    grant.action !== "read" ||
    !Number.isSafeInteger(grant.expires_at) ||
    grant.expires_at <= Date.now() ||
    !Number.isSafeInteger(grant.max_object_bytes) ||
    grant.max_object_bytes <= 0 ||
    grant.max_object_bytes > 16 * 1024 * 1024
  )
    throw new Failure(
      "FORBIDDEN",
      403,
      "Object read capability is invalid or expired",
    );
  validateScope(grant.scope);
  const input = await readJson<ObjectRead>(request);
  validateScope(input.scope);
  if (
    !sameScope(grant.scope, input.scope) ||
    input.max_bytes > grant.max_object_bytes
  )
    throw new Failure(
      "FORBIDDEN",
      403,
      "Object hydration exceeds capability scope",
    );
  if (!env.ARTIFACTS || (!env.REPOSITORIES && !env.ARTIFACTS_REPOSITORIES))
    throw new Failure(
      "CONFIGURATION_REQUIRED",
      503,
      "Artifacts repository mappings are required",
    );
  const configuration = env.REPOSITORIES ? JSON.stringify([{
    tenant_id: input.scope.tenant_id, organization_id: input.scope.organization_id,
    repo_id: input.scope.repo_id, artifacts_name: (await resolveRepository(env, input.scope)).artifacts_name,
  }]) : env.ARTIFACTS_REPOSITORIES!;
  return new ArtifactsObjectStore(env.ARTIFACTS, configuration).read(input);
}
