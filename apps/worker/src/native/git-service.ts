import { hashProjection } from "../../../../packages/contracts/src/index.ts";
import { signToken, verifyInternal, sameScope } from "../auth.ts";
import { Failure, failureResponse, readJson, validateScope } from "../runtime.ts";
import type { Scope } from "../runtime.ts";
import { NativeContainer } from "./containers.ts";
import type { Command, NativeBindings } from "./containers.ts";

interface GitBindings extends NativeBindings {
  GIT: DurableObjectNamespace;
  ARTIFACTS: Artifacts;
  ARTIFACTS_REPOSITORIES: string;
}
interface CasCommand {
  schema_version: 1; scope: Scope; ref: string; expected_oid: string; target_oid: string;
  idempotency_key: string; operation_digest: string;
}

function oid(value: string): void { if (!/^[0-9a-f]{40}$/.test(value)) throw new Failure("INVALID_INPUT", 400, "Invalid Git object ID"); }

function repositoryName(env: GitBindings, scope: Scope): string {
  let mappings: { tenant_id: string; organization_id: string; repo_id: string; artifacts_name: string }[];
  try { mappings = JSON.parse(env.ARTIFACTS_REPOSITORIES); }
  catch { throw new Failure("CONFIGURATION_REQUIRED", 503, "Repository mappings are required"); }
  const matches = mappings.filter(mapping => mapping.tenant_id === scope.tenant_id &&
    mapping.organization_id === scope.organization_id && mapping.repo_id === scope.repo_id);
  if (matches.length !== 1) throw new Failure("FORBIDDEN", 403, "Repository is outside this resource scope");
  return matches[0].artifacts_name;
}

export class GitContainer extends NativeContainer {
  protected role = "git";
  interceptHttps = true;

  static outboundHandlers: typeof NativeContainer.outboundHandlers = {
    git: async (request, _env, context): Promise<Response> => {
      const parameters = context.params;
      if (!parameters || typeof parameters !== "object" || !("remote" in parameters) ||
          !("expires_at" in parameters) || typeof parameters.remote !== "string" ||
          typeof parameters.expires_at !== "number")
        return new Response("Forbidden", { status: 403 });
      const remote = new URL(parameters.remote);
      const url = new URL(request.url);
      const path = remote.pathname.replace(/\/$/, "") + "/";
      if (parameters.expires_at <= Date.now() || url.origin !== remote.origin ||
          ![path + "info/refs", path + "git-upload-pack", path + "git-receive-pack"].includes(url.pathname) ||
          !["GET", "POST"].includes(request.method))
        return new Response("Forbidden", { status: 403 });
      return fetch(request);
    },
  };

  protected async prepare(input: Command): Promise<Response | undefined> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS git_receipts (idempotency_key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, operation_digest TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT)");
    const payload = input.payload as Record<string, unknown>;
    const key = String(payload.idempotency_key);
    const digest = String(payload.operation_digest);
    const previous = this.ctx.storage.sql.exec<{ operation_digest: string; status: string; receipt: string | null }>(
      "SELECT operation_digest, status, receipt FROM git_receipts WHERE idempotency_key = ?", key).toArray()[0];
    if (previous?.operation_digest !== undefined && previous.operation_digest !== digest)
      throw new Failure("IDEMPOTENCY_MISMATCH", 409, "Git operation key belongs to different inputs");
    if (previous?.receipt) return Response.json(JSON.parse(previous.receipt));
    if (input.action === "git/operation" && !previous)
      return Response.json({ schema_version: 1, status: "UNKNOWN" });
    if (input.action === "git/cas") {
      if (previous) return Response.json({ schema_version: 1, status: "UNKNOWN", operation_digest: digest });
      this.ctx.storage.sql.exec("INSERT INTO git_receipts (idempotency_key, schema_version, operation_digest, status) VALUES (?, 1, ?, 'PREPARED')", key, digest);
      const remote = new URL(String(payload.remote));
      if (remote.protocol !== "https:" || remote.username || remote.password) throw new Failure("INVALID_INPUT", 400, "Invalid repository transport");
      this.allowedHosts = [remote.hostname];
      await this.setOutboundByHost(remote.hostname, "git", { remote: remote.href, expires_at: Date.now() + 120000 });
    }
    return undefined;
  }

  protected async complete(input: Command, response: Response): Promise<Response> {
    if (!response.ok) return response;
    const receipt = await response.json<Record<string, unknown>>();
    const payload = input.payload as Record<string, unknown>;
    if (receipt.status !== "UNKNOWN" && receipt.operation_digest !== payload.operation_digest)
      throw new Failure("GIT_OUTCOME_UNKNOWN", 503, "Git receipt input binding differs");
    if (["APPLIED", "NO_EFFECT"].includes(String(receipt.status))) {
      this.ctx.storage.sql.exec("UPDATE git_receipts SET status = ?, receipt = ? WHERE idempotency_key = ? AND operation_digest = ?",
        receipt.status, JSON.stringify(receipt), payload.idempotency_key, payload.operation_digest);
    }
    return Response.json(receipt);
  }
}

async function native(env: GitBindings, command: CasCommand, action: string, payload: unknown): Promise<Response> {
  const instance = await hashProjection("klocgit.git-operation-scope", { scope: command.scope, ref: command.ref, idempotency_key: command.idempotency_key });
  const body = { schema_version: 1, scope: command.scope, action, payload };
  const subject_digest = await hashProjection("klocgit.native-command", body);
  const token = await signToken({ schema_version: 1, aud: "native-container", scope: command.scope, action, subject_digest,
    actor_id: "ref-coordinator", expires_at: Date.now() + 120000 }, env.INTERNAL_SIGNING_KEY);
  return env.GIT.getByName(instance).fetch("https://git.native/command", { method: "POST",
    headers: { "content-type": "application/json", "x-klocgit-internal": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
}

export default {
  async fetch(request: Request, env: GitBindings): Promise<Response> {
    try {
      if (request.method !== "POST") throw new Failure("METHOD_NOT_ALLOWED", 405, "POST is required");
      const action = new URL(request.url).pathname.slice(1);
      const input = await readJson<CasCommand>(request);
      validateScope(input.scope);
      const grant = await verifyInternal(request, env, "git-executor", action, await hashProjection("klocgit.git-command", input));
      if (input.schema_version !== 1 || !sameScope(grant.scope, input.scope) || !["observe", "cas", "operation"].includes(action))
        throw new Failure("FORBIDDEN", 403, "Git command is outside the authorized scope");
      const repo = await env.ARTIFACTS.get(repositoryName(env, input.scope));
      try {
        if (action === "observe") {
          if (!input.ref?.startsWith("refs/")) throw new Failure("INVALID_INPUT", 400, "Git ref is required");
          const commits = await repo.log({ ref: input.ref, limit: 1 });
          const commit = commits[0];
          if (!commit) throw new Failure("GIT_REF_MISSING", 404, "Git ref is unavailable");
          oid(commit.hash); oid(commit.treeHash); commit.parents.forEach(oid);
          return Response.json({ commit_oid: commit.hash, tree_oid: commit.treeHash, parent_oids: commit.parents });
        }
        oid(input.expected_oid); oid(input.target_oid);
        const command = { scope: input.scope, ref: input.ref, expected_oid: input.expected_oid, target_oid: input.target_oid, idempotency_key: input.idempotency_key };
        if (await hashProjection("klocgit.git-cas", command) !== input.operation_digest)
          throw new Failure("INPUT_MISMATCH", 409, "Git operation digest differs");
        if (action === "operation")
          return native(env, input, "git/operation", { idempotency_key: input.idempotency_key, operation_digest: input.operation_digest });
        const info = await repo.info();
        const token = await repo.createToken("write", 120);
        try {
          const result = await native(env, input, "git/cas", { schema_version: 1, remote: info.remote,
            artifact_token: token.plaintext, ref_name: input.ref, expected_oid: input.expected_oid,
            target_oid: input.target_oid, idempotency_key: input.idempotency_key, operation_digest: input.operation_digest });
          if (!result.ok) return result;
          const receipt = await result.json<Record<string, unknown>>();
          if (receipt.status === "NO_EFFECT") return Response.json({ error: { code: "STALE_BASIS" } }, { status: 409 });
          if (receipt.status !== "APPLIED") throw new Failure("GIT_OUTCOME_UNKNOWN", 503, "Git mutation requires reconciliation");
          return Response.json(receipt);
        } finally { await repo.revokeToken(token.id); }
      } finally { repo[Symbol.dispose](); }
    } catch (error) { return failureResponse(error); }
  },
};
