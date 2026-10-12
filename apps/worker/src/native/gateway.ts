import { hashProjection, payloadDigest, sealCandidate } from "../../../../packages/contracts/src/index.ts";
import type { Candidate } from "../../../../packages/contracts/src/index.ts";
import { signToken, verifyInternal, sameScope } from "../auth.ts";
import { EvidenceStore } from "../evidence-store.ts";
import { Failure, failureResponse, readJson, validateScope } from "../runtime.ts";
import type { Scope } from "../runtime.ts";
import type { NativeBindings } from "./containers.ts";

export { AnalysisContainer, EvaluationContainer } from "./containers.ts";

interface Config {
  schema_version: 1; policy: Record<string, unknown> & { image_oid: string; timeout_ms: number; checks: unknown[] };
}
interface FileDescriptor { path: string; mode: number; blob_oid: string; bytes: number; }
interface SuiteManifest { schema_version: 1; files: (FileDescriptor & { payload_ref: string; payload_digest: string })[]; }

async function native(env: NativeBindings, scope: Scope, instance: string, action: string, payload: unknown, evaluation = false): Promise<Response> {
  const command = { schema_version: 1, scope, action, payload };
  const subject_digest = await hashProjection("klocgit.native-command", command);
  const token = await signToken({ schema_version: 1, aud: "native-container", scope, action, subject_digest,
    actor_id: "engine", expires_at: Date.now() + 900000 }, env.INTERNAL_SIGNING_KEY);
  const namespace = evaluation ? env.EVALUATIONS : env.ANALYSIS;
  return namespace.getByName(instance).fetch("https://native.internal/command", {
    method: "POST", headers: { "content-type": "application/json", "x-klocgit-internal": token },
    body: JSON.stringify(command), signal: AbortSignal.timeout(900000),
  });
}

async function responseJson<T>(response: Response, maximum = 8 * 1024 * 1024): Promise<T> {
  if (!response.ok) {
    const result: { error?: { code?: string } } = await response.json<{ error?: { code?: string } }>().catch(() => ({}));
    throw new Failure(result.error?.code ?? "NATIVE_UNAVAILABLE", response.status, "Native execution did not complete");
  }
  return readJson<T>(new Request("https://result.internal", { method: "POST", body: response.body }), maximum);
}

async function r2Bytes(env: NativeBindings, ref: string, digest: string, prefix: string): Promise<Uint8Array> {
  if (!ref.startsWith(prefix) || !/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new Failure("INVALID_INPUT", 409, "Payload scope differs");
  const object = await env.PAYLOADS.get(ref);
  if (!object || object.size > 8 * 1024 * 1024) throw new Failure("PAYLOAD_MISSING", 409, "Payload is unavailable");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await payloadDigest(bytes) !== digest) throw new Failure("PAYLOAD_CORRUPT", 409, "Payload bytes differ");
  return bytes;
}

async function readCapability(env: NativeBindings, scope: Scope): Promise<string> {
  return signToken({ schema_version: 1, aud: "git-objects", scope, action: "read",
    expires_at: Date.now() + 300000, max_object_bytes: 16 * 1024 * 1024 }, env.INTERNAL_SIGNING_KEY);
}

async function stage(env: NativeBindings, scope: Scope, instance: string, root: string, file: FileDescriptor, bytes: Uint8Array): Promise<void> {
  if (bytes.length !== file.bytes) throw new Failure("INPUT_MISMATCH", 409, "Staged file length differs");
  const chunks = Math.max(1, Math.ceil(bytes.length / (1024 * 1024)));
  for (let index = 0; index < chunks; index++) {
    const part = bytes.subarray(index * 1024 * 1024, (index + 1) * 1024 * 1024);
    await responseJson(await native(env, scope, instance, "stage", { schema_version: 1, root,
      path: file.path, mode: file.mode, blob_oid: file.blob_oid, chunk_index: index, chunk_count: chunks,
      payload_hex: Array.from(part, byte => byte.toString(16).padStart(2, "0")).join(""),
    }, true));
  }
}

export default {
  async fetch(request: Request, env: NativeBindings): Promise<Response> {
    let scope: Scope | undefined;
    let instance = "";
    let evaluator = "";
    try {
      if (request.method !== "POST") throw new Failure("METHOD_NOT_ALLOWED", 405, "POST is required");
      const action = new URL(request.url).pathname.slice(1);
      const body = await readJson<Record<string, unknown> & { scope: Scope; schema_version: number }>(request, 32 * 1024);
      scope = validateScope(body.scope);
      const digest = await hashProjection("klocgit.engine-command", body);
      const grant = await verifyInternal(request, env, "engine", action, digest);
      if (body.schema_version !== 1 || !sameScope(grant.scope, scope) || !["analyze", "reduce", "evaluate"].includes(action))
        throw new Failure("FORBIDDEN", 403, "Native execution is outside the authorized scope");
      instance = await hashProjection("klocgit.analysis-instance", { scope, input_digest: digest });
      if (action === "analyze") {
        const original_payload = String(body.original_payload);
        if (await payloadDigest(new TextEncoder().encode(original_payload)) !== body.input_payload_digest)
          throw new Failure("INPUT_MISMATCH", 409, "Analysis payload binding differs");
        const result = await native(env, scope, instance, "analyze", { schema_version: 1, original_payload,
          input_payload_digest: body.input_payload_digest, broker_endpoint: "https://broker.internal/internal/git-objects",
          read_capability: await readCapability(env, scope) });
        return Response.json(await responseJson(result));
      }
      if (action === "reduce") {
        const bytes = await r2Bytes(env, String(body.input_payload_ref), String(body.input_payload_digest), "analysis/" + scope.tenant_id + "/");
        const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { schema_version: number; segments: { payload_ref: string; payload_digest: string }[] };
        if (manifest.schema_version !== 1 || !Array.isArray(manifest.segments) || manifest.segments.length > 1024)
          throw new Failure("INVALID_INPUT", 409, "Reduction manifest is invalid");
        const futures: unknown[] = [];
        let total = 0;
        for (const segment of manifest.segments) {
          const bytes = await r2Bytes(env, segment.payload_ref, segment.payload_digest, "analysis/" + scope.tenant_id + "/");
          total += bytes.length;
          if (total > 32 * 1024 * 1024) throw new Failure("RESOURCE_LIMIT", 409, "Reduction input exceeds budget");
          const rows = JSON.parse(new TextDecoder().decode(bytes));
          if (!Array.isArray(rows)) throw new Failure("INPUT_MISMATCH", 409, "Reduction segment is invalid");
          for (const row of rows) {
            if (row.state.repo_id !== scope.repo_id) throw new Failure("FORBIDDEN", 403, "Reduction repository differs");
            // Footprints are derived by the native repository extractor.
            if (!Array.isArray(row.changed_paths))
              throw new Failure("ANALYSIS_REQUIRED", 409, "Observed change paths are required");
            futures.push({ state: row.state, revision: row.revision, effects: row.effects,
              changed_paths: row.changed_paths, required_future_ids: row.required_future_ids ?? [] });
          }
        }
        const nativeResult = await responseJson<{ result: Record<string, unknown>; input_payload_digest: string }>(
          await native(env, scope, instance, "reduce", { schema_version: 1, input_payload_digest: body.input_payload_digest,
            base_revisions: body.base_revisions, futures, budget: body.budget }));
        if (nativeResult.input_payload_digest !== body.input_payload_digest) throw new Failure("INPUT_MISMATCH", 409, "Reduction output binding differs");
        const payload = new TextEncoder().encode(JSON.stringify(nativeResult.result));
        const payload_digest = await payloadDigest(payload);
        const payload_ref = "reductions/" + scope.tenant_id + "/" + payload_digest.slice(7);
        await env.PAYLOADS.put(payload_ref, payload, { customMetadata: { schema_version: "1", retention_class: "REBUILDABLE", payload_digest } });
        const result = nativeResult.result;
        return Response.json({ schema_version: 1, input_payload_digest: body.input_payload_digest, payload_ref, payload_digest,
          summary: { status: result.status, candidate_count: (result.candidate_specs as unknown[]).length,
            deferred_count: (result.deferred_future_ids as unknown[]).length, group_count: (result.groups as unknown[]).length,
            candidate_spec_digests: (result.candidate_specs as { spec_digest: string }[]).map(spec => spec.spec_digest),
            reduction_digest: result.reduction_digest } });
      }
      let config: Config;
      let suite: SuiteManifest;
      try { config = JSON.parse(env.EVALUATION_CONFIG); suite = JSON.parse(env.TRUSTED_SUITE_MANIFEST); }
      catch { throw new Failure("CONFIGURATION_REQUIRED", 503, "Trusted evaluator configuration is required"); }
      if (config.schema_version !== 1 || suite.schema_version !== 1) throw new Failure("CONFIGURATION_REQUIRED", 503, "Evaluator configuration is invalid");
      const materialized = await responseJson<{ candidate: Candidate; files: FileDescriptor[] }>(await native(env, scope, instance,
        "materialize", { schema_version: 1, scope, broker_endpoint: "https://broker.internal/internal/git-objects",
          read_capability: await readCapability(env, scope), candidate_spec: body.candidate_spec, sources: body.sources }));
      const sealed = await sealCandidate(materialized.candidate);
      if (sealed.candidate_digest !== materialized.candidate.candidate_digest) throw new Failure("INPUT_MISMATCH", 409, "Candidate identity differs");
      evaluator = await hashProjection("klocgit.evaluation-instance", { scope, candidate_digest: sealed.candidate_digest, policy: config.policy });
      for (const file of materialized.files) {
        const blob = await native(env, scope, instance, "workspace/blob", { path: file.path });
        if (!blob.ok) throw new Failure("NATIVE_UNAVAILABLE", blob.status, "Materialized blob is unavailable");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await stage(env, scope, evaluator, "workspace", file, bytes);
      }
      for (const file of suite.files) {
        const bytes = await r2Bytes(env, file.payload_ref, file.payload_digest, "trusted-checks/" + scope.tenant_id + "/");
        await stage(env, scope, evaluator, "checks", file, bytes);
      }
      const result = await responseJson<{ evidence: Parameters<EvidenceStore["persist"]>[1]; payload: number[] }>(
        await native(env, scope, evaluator, "evaluate", { schema_version: 1, candidate: sealed, repo_id: scope.repo_id,
          policy: config.policy, environment: { schema_version: 1, provider: "cloudflare-containers",
            image_oid: config.policy.image_oid, network: "DENIED" } }, true));
      if (result.evidence.subject_digest !== sealed.candidate_digest) throw new Failure("INPUT_MISMATCH", 409, "Evidence subject differs");
      const evidence = await new EvidenceStore(env.PAYLOADS).persist(scope.tenant_id, result.evidence, Uint8Array.from(result.payload));
      return Response.json({ schema_version: 1, candidate: sealed, evidence });
    } catch (error) { return failureResponse(error); }
    finally {
      if (scope && evaluator) await native(env, scope, evaluator, "destroy", {}, true).catch(() => undefined);
      if (scope && instance) await native(env, scope, instance, "destroy", {}).catch(() => undefined);
    }
  },
};
