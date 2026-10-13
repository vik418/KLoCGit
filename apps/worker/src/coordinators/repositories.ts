import { DurableObject } from "cloudflare:workers";
import { hashProjection } from "../../../../packages/contracts/src/index.ts";
import { authorizeOrganization, verifyToken } from "../auth.ts";
import type { Principal } from "../auth.ts";
import { Failure, failureResponse, identifier, readJson } from "../runtime.ts";
import type { Bindings, Scope } from "../runtime.ts";

export interface RepositoryRecord {
  schema_version: 1;
  repo_id: string;
  name: string;
  description: string;
  artifacts_name: string;
  remote: string | null;
  state: "PROVISIONING" | "READY" | "UNKNOWN";
  source_repo_id: string | null;
}

export function directoryName(scope: Pick<Scope, "tenant_id" | "organization_id">) {
  return hashProjection("klocgit.repository-directory", {
    tenant_id: scope.tenant_id, organization_id: scope.organization_id,
  });
}

function physicalName(scope: Pick<Scope, "tenant_id" | "organization_id" | "repo_id">): Promise<string> {
  return hashProjection("klocgit.repository-location", {
    tenant_id: scope.tenant_id, organization_id: scope.organization_id, repo_id: scope.repo_id,
  }).then(identity => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    let bits = 0, accumulator = 0, result = "";
    for (const byte of identity.slice(7).match(/../g)!) {
      accumulator = (accumulator << 8) | Number.parseInt(byte, 16); bits += 8;
      while (bits >= 5) { bits -= 5; result += alphabet[(accumulator >>> bits) & 31]; }
    }
    if (bits) result += alphabet[(accumulator << (5 - bits)) & 31];
    return result;
  });
}

/** The catalog owns resource mappings; Git content remains in Artifacts. */
export class RepositoryDirectory extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS repositories (repo_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, record TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS objectives (objective_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, repo_id TEXT NOT NULL, record TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS operations (idempotency_key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, request_digest TEXT NOT NULL, repo_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, action TEXT NOT NULL, actor_id TEXT NOT NULL, object_id TEXT NOT NULL, trace_id TEXT NOT NULL)");
  }

  private load(repoId: string): RepositoryRecord {
    const row = this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM repositories WHERE repo_id = ?", repoId).toArray()[0];
    if (!row) throw new Failure("NOT_FOUND", 404, "Repository is not registered");
    return JSON.parse(row.record);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const body = await readJson<{
        schema_version: 1; scope: Pick<Scope, "tenant_id" | "organization_id">; principal?: Principal;
        repo_id?: string; description?: string; source_repo_id?: string; source_url?: string; idempotency_key?: string; objective_id?: string; statement?: string;
      }>(request);
      identifier(body.scope.tenant_id); identifier(body.scope.organization_id);
      const token = request.headers.get("x-klocgit-internal");
      if (!token) throw new Failure("FORBIDDEN", 403, "Repository authorization is required");
      const action = new URL(request.url).pathname.slice(1);
      const grant = await verifyToken<{
        schema_version: 1; aud: "repository"; scope: Pick<Scope, "tenant_id" | "organization_id">;
        action: string; actor_id: string; expires_at: number; subject_digest: string;
      }>(token, this.env.INTERNAL_SIGNING_KEY);
      if (grant.schema_version !== 1 || grant.aud !== "repository" || grant.action !== action ||
          !Number.isSafeInteger(grant.expires_at) || grant.expires_at <= Date.now() ||
          grant.subject_digest !== await hashProjection("klocgit.repository-command", body))
        throw new Failure("FORBIDDEN", 403, "Repository request is not authorized");
      if (body.schema_version !== 1 ||
          grant.scope.tenant_id !== body.scope.tenant_id || grant.scope.organization_id !== body.scope.organization_id ||
          this.ctx.id.toString() !== this.env.REPOSITORIES.idFromName(await directoryName(body.scope)).toString())
        throw new Failure("FORBIDDEN", 403, "Repository directory scope differs");
      if (action === "resolve") return Response.json(this.load(identifier(body.repo_id)));
      if (!body.principal || body.principal.sub !== grant.actor_id || body.principal.exp * 1000 <= Date.now())
        throw new Failure("FORBIDDEN", 403, "Repository authorization expired");
      const principal = body.principal;
      if (action === "list") {
        authorizeOrganization(principal, body.scope, "read");
        return Response.json({ schema_version: 1, repositories: this.ctx.storage.sql
          .exec<{ record: string }>("SELECT record FROM repositories ORDER BY repo_id LIMIT 100").toArray()
          .map(row => JSON.parse(row.record)) });
      }
      if (action === "objectives") {
        authorizeOrganization(principal, body.scope, "read");
        return Response.json({ schema_version: 1, objectives: this.ctx.storage.sql
          .exec<{ record: string }>("SELECT record FROM objectives ORDER BY objective_id LIMIT 100")
          .toArray().map(row => JSON.parse(row.record)) });
      }
      if (action === "objective-create") {
        authorizeOrganization(principal, body.scope, "ingest");
        const repository = this.load(identifier(body.repo_id));
        const objective_id = identifier(body.objective_id);
        if (typeof body.statement !== "string" || !body.statement.trim() || body.statement.length > 4096)
          throw new Failure("INVALID_INPUT", 400, "An objective statement is required");
        const record = { schema_version: 1, objective_id, repo_id: repository.repo_id,
          statement: body.statement, scope: { ...body.scope, repo_id: repository.repo_id, objective_id },
          created_by: principal.sub, created_at: new Date().toISOString() };
        const prior = this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM objectives WHERE objective_id = ?", objective_id).toArray()[0];
        if (prior) {
          const value = JSON.parse(prior.record);
          if (value.repo_id !== repository.repo_id || value.statement !== body.statement || value.created_by !== principal.sub)
            throw new Failure("IDEMPOTENCY_MISMATCH", 409, "Objective inputs changed");
          return Response.json(value);
        }
        this.ctx.storage.sql.exec("INSERT INTO objectives (objective_id, schema_version, repo_id, record) VALUES (?, 1, ?, ?)",
          objective_id, repository.repo_id, JSON.stringify(record));
        this.ctx.storage.sql.exec("INSERT INTO audit (schema_version, action, actor_id, object_id, trace_id) VALUES (1, 'objective.created', ?, ?, ?)",
          principal.sub, objective_id, body.idempotency_key ?? objective_id);
        return Response.json(record, { status: 201 });
      }
      if (action === "discover" || action === "connect") {
        authorizeOrganization(principal, body.scope, action === "discover" ? "read" : "repository:create");
        const owner = this.env.OWNER_SCOPE ? JSON.parse(this.env.OWNER_SCOPE) : null;
        if (principal.sub !== this.env.ACTOR_ID || body.scope.tenant_id !== owner?.tenant_id ||
            body.scope.organization_id !== owner?.organization_id)
          throw new Failure("FORBIDDEN", 403, "Namespace ownership is required");
        if (!this.env.ARTIFACTS) throw new Failure("CONFIGURATION_REQUIRED", 503, "Artifacts is not configured");
        if (action === "discover") {
          const page = await this.env.ARTIFACTS.list({ limit: 100 });
          const mapped = new Set(this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM repositories").toArray().map(row => JSON.parse(row.record).artifacts_name));
          const repositories = await Promise.all(page.repos.filter(repo => !mapped.has(repo.name)).map(async descriptor => {
            try { using handle = await this.env.ARTIFACTS!.get(descriptor.name); await handle.info();
              return { name: descriptor.name, status: "ready" }; }
            catch { return { name: descriptor.name, status: "unknown" }; }
          }));
          return Response.json({ schema_version: 1, repositories, cursor: page.cursor ?? null });
        }
        const repo_id = identifier(body.repo_id);
        const artifacts_name = identifier(body.source_repo_id);
        using repository = await this.env.ARTIFACTS.get(artifacts_name);
        const info = await repository.info();
        const mapped = this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM repositories").toArray()
          .map(row => JSON.parse(row.record) as RepositoryRecord)
          .find(record => record.artifacts_name === artifacts_name);
        if (mapped) return Response.json(mapped);
        const record: RepositoryRecord = { schema_version: 1, repo_id, name: repo_id,
          description: info.description ?? "", artifacts_name, remote: info.remote, state: "READY", source_repo_id: null };
        this.ctx.storage.transactionSync(() => {
          if (this.ctx.storage.sql.exec("SELECT 1 FROM repositories WHERE repo_id = ?", repo_id).toArray().length)
            throw new Failure("REPOSITORY_EXISTS", 409, "Repository name is already registered");
          this.ctx.storage.sql.exec("INSERT INTO repositories (repo_id, schema_version, record) VALUES (?, 1, ?)", repo_id, JSON.stringify(record));
          this.ctx.storage.sql.exec("INSERT INTO audit (schema_version, action, actor_id, object_id, trace_id) VALUES (1, 'repository.connected', ?, ?, ?)",
            principal.sub, repo_id, body.idempotency_key ?? "");
        });
        return Response.json(record);
      }
      if (action === "get") {
        authorizeOrganization(principal, body.scope, "read");
        const record = this.load(identifier(body.repo_id));
        if (!this.env.ARTIFACTS) throw new Failure("CONFIGURATION_REQUIRED", 503, "Artifacts is not configured");
        using repo = await this.env.ARTIFACTS.get(record.artifacts_name);
        const info = await repo.info();
        const refreshed: RepositoryRecord = { ...record, remote: info.remote, state: "READY" };
        this.ctx.storage.sql.exec("UPDATE repositories SET record = ? WHERE repo_id = ?", JSON.stringify(refreshed), record.repo_id);
        return Response.json(refreshed);
      }
      if (!["create", "fork"].includes(action)) throw new Failure("NOT_FOUND", 404, "Repository operation is unsupported");
      authorizeOrganization(principal, body.scope, action === "create" ? "repository:create" : "repository:fork");
      if (principal.actor_type !== "human") throw new Failure("FORBIDDEN", 403, "Repository creation requires a human identity");
      const repo_id = identifier(body.repo_id);
      const description = body.description ?? "";
      const key = body.idempotency_key;
      if (typeof description !== "string" || description.length > 2048 ||
          description.includes("[klocgit-operation:") || !key || key.length > 256)
        throw new Failure("INVALID_INPUT", 400, "Repository request is invalid");
      const source = action === "fork" ? this.load(identifier(body.source_repo_id)) : null;
      let source_url: string | null = null;
      if (body.source_url) {
        const url = new URL(body.source_url);
        if (action !== "create" || url.protocol !== "https:" || url.username || url.password) throw new Failure("INVALID_INPUT", 400, "Repository import requires a public HTTPS Git URL");
        source_url = url.href;
      }
      const request_digest = await hashProjection("klocgit.repository-request", {
        scope: body.scope, repo_id, action, description, source_url, source_repo_id: source?.repo_id ?? null, actor_id: principal.sub,
      });
      const existing = this.ctx.storage.sql.exec<{ request_digest: string; status: string }>(
        "SELECT request_digest, status FROM operations WHERE idempotency_key = ?", key,
      ).toArray()[0];
      if (existing?.request_digest && existing.request_digest !== request_digest)
        throw new Failure("IDEMPOTENCY_MISMATCH", 409, "Repository operation inputs changed");
      if (existing?.status === "APPLIED") return Response.json(this.load(repo_id));
      const artifacts_name = await physicalName({ ...body.scope, repo_id });
      const marker = "[klocgit-operation:" + request_digest + "]";
      this.ctx.storage.transactionSync(() => {
        const prior = this.ctx.storage.sql.exec<{ request_digest: string }>(
          "SELECT request_digest FROM operations WHERE idempotency_key = ?", key,
        ).toArray()[0];
        if (prior && prior.request_digest !== request_digest) throw new Failure("IDEMPOTENCY_MISMATCH", 409, "Repository request changed");
        if (!prior && this.ctx.storage.sql.exec("SELECT 1 FROM repositories WHERE repo_id = ?", repo_id).toArray().length)
          throw new Failure("REPOSITORY_EXISTS", 409, "Repository name is already registered");
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO operations (idempotency_key, schema_version, request_digest, repo_id, actor_id, action, status) VALUES (?, 1, ?, ?, ?, ?, 'PREPARED')",
          key, request_digest, repo_id, principal.sub, action,
        );
        const initial: RepositoryRecord = { schema_version: 1, repo_id, name: repo_id, description,
          artifacts_name, remote: null, state: "PROVISIONING", source_repo_id: source?.repo_id ?? null };
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO repositories (repo_id, schema_version, record) VALUES (?, 1, ?)", repo_id, JSON.stringify(initial));
      });
      if (!this.env.ARTIFACTS) throw new Failure("CONFIGURATION_REQUIRED", 503, "Artifacts is not configured");
      let remote: string;
      if (existing) {
        // Reconcile ambiguous completion; a matching operation marker is required.
        using found = await this.env.ARTIFACTS.get(artifacts_name);
        const info = await found.info();
        if (!info.description?.includes(marker))
          throw new Failure("REPOSITORY_OUTCOME_UNKNOWN", 409, "Repository creation requires reconciliation");
        remote = info.remote;
      } else {
        const options = { description: description + "\n" + marker, readOnly: false };
        const created = source ? await (async () => {
          using repo = await this.env.ARTIFACTS!.get(source.artifacts_name);
          return repo.fork(artifacts_name, { ...options, defaultBranchOnly: true });
        })() : source_url ? await this.env.ARTIFACTS.import({ source: { url: source_url }, target: { name: artifacts_name, opts: options } })
          : await this.env.ARTIFACTS.create(artifacts_name, { ...options, setDefaultBranch: "main" });
        remote = created.remote;
        try { using createdRepo = await this.env.ARTIFACTS.get(artifacts_name); await createdRepo.revokeToken(created.token); }
        catch { /* The unused initial token expires while an asynchronous fork finishes. */ }
      }
      const record = { ...this.load(repo_id), remote };
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE repositories SET record = ? WHERE repo_id = ?", JSON.stringify(record), repo_id);
        this.ctx.storage.sql.exec("UPDATE operations SET status = 'APPLIED' WHERE idempotency_key = ?", key);
        this.ctx.storage.sql.exec(
          "INSERT INTO audit (schema_version, action, actor_id, object_id, trace_id) VALUES (1, ?, ?, ?, ?)",
          "repository." + action, principal.sub, repo_id, key,
        );
      });
      return Response.json(record, { status: 201 });
    } catch (error) { return failureResponse(error); }
  }
}
