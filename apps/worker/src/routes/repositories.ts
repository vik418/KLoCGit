import { hashProjection } from "../../../../packages/contracts/src/index.ts";
import { signToken } from "../auth.ts";
import { directoryName } from "../coordinators/repositories.ts";
import type { RepositoryRecord } from "../coordinators/repositories.ts";
import { Failure, readJson } from "../runtime.ts";
import type { Bindings, Scope } from "../runtime.ts";

export async function callDirectory(
  env: Bindings, scope: Pick<Scope, "tenant_id" | "organization_id">,
  action: string, supplied: Record<string, unknown>, actor: string,
): Promise<Response> {
  const body = { ...supplied, schema_version: 1, scope };
  const token = await signToken({
    schema_version: 1, aud: "repository", scope, action, actor_id: actor,
    subject_digest: await hashProjection("klocgit.repository-command", body),
    expires_at: Date.now() + 60000,
  }, env.INTERNAL_SIGNING_KEY);
  return env.REPOSITORIES.getByName(await directoryName(scope)).fetch("https://repository.internal/" + action, {
    method: "POST", headers: { "content-type": "application/json", "x-klocgit-internal": token },
    body: JSON.stringify(body),
  });
}

export async function resolveRepository(env: Bindings, scope: Scope): Promise<RepositoryRecord> {
  const response = await callDirectory(env, {
    tenant_id: scope.tenant_id, organization_id: scope.organization_id,
  }, "resolve", { repo_id: scope.repo_id }, "engine");
  if (!response.ok) throw new Failure("REPOSITORY_UNAVAILABLE", response.status, "Repository mapping is unavailable");
  return readJson<RepositoryRecord>(response);
}
