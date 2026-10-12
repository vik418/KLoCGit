import { Failure, identifier, validateScope } from "../runtime.ts";
import type { Scope } from "../runtime.ts";

export interface ObjectRead {
  schema_version: 1;
  scope: Scope;
  kind: "commit" | "tree" | "blob";
  oid: string;
  max_bytes: number;
}

interface RepositoryBinding {
  tenant_id: string;
  organization_id: string;
  repo_id: string;
  artifacts_name: string;
}

const modes: Record<string, ArtifactsTreeEntryType> = {
  "40000": "tree",
  "100644": "blob",
  "100755": "exec",
  "120000": "symlink",
  "160000": "gitlink",
};

function oid(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value))
    throw new Failure("INVALID_INPUT", 400, "Invalid Git object ID");
  return value;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

async function verifyObject(
  kind: "tree" | "blob",
  expected: string,
  bytes: Uint8Array,
): Promise<void> {
  const header = new TextEncoder().encode(kind + " " + bytes.length + "\0");
  const input = new Uint8Array(header.length + bytes.length);
  input.set(header);
  input.set(bytes, header.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const actual = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  if (actual !== expected)
    throw new Failure("GIT_OBJECT_MISMATCH", 409, "Git object content differs");
}

function treeBytes(entries: ArtifactsTreeEntry[], maximum: number): Uint8Array {
  const encoder = new TextEncoder();
  const names = new Set<string>();
  let size = 0;
  const ordered = entries
    .map((entry) => {
      if (
        !modes[entry.mode] ||
        modes[entry.mode] !== entry.type ||
        entry.name.normalize("NFC") !== entry.name ||
        !entry.name ||
        entry.name === "." ||
        entry.name === ".." ||
        /[\/\\\0]/.test(entry.name) ||
        names.has(entry.name)
      )
        throw new Failure("INVALID_GIT_TREE", 409, "Invalid Git tree entry");
      names.add(entry.name);
      oid(entry.hash);
      const prefix = encoder.encode(entry.mode + " " + entry.name + "\0");
      size += prefix.length + 20;
      if (size > maximum)
        throw new Failure(
          "HYDRATION_LIMIT",
          413,
          "Git tree exceeds hydration budget",
        );
      return {
        entry,
        prefix,
        key: encoder.encode(entry.name + (entry.type === "tree" ? "/" : "")),
      };
    })
    .sort((a, b) => compareBytes(a.key, b.key));
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const { entry, prefix } of ordered) {
    bytes.set(prefix, offset);
    offset += prefix.length;
    for (let i = 0; i < 40; i += 2)
      bytes[offset++] = Number.parseInt(entry.hash.slice(i, i + 2), 16);
  }
  return bytes;
}

/** Object-only access keeps Artifacts credentials outside the native evaluator. */
export class ArtifactsObjectStore {
  private namespace: Artifacts;
  private mappings: RepositoryBinding[];
  constructor(namespace: Artifacts, configuration: string) {
    this.namespace = namespace;
    let mappings: unknown;
    try {
      mappings = JSON.parse(configuration);
    } catch {
      throw new Failure(
        "CONFIGURATION_REQUIRED",
        503,
        "Repository mappings are not configured",
      );
    }
    if (!Array.isArray(mappings) || mappings.length > 10_000)
      throw new Failure(
        "CONFIGURATION_REQUIRED",
        503,
        "Repository mappings are invalid",
      );
    const keys = new Set<string>();
    for (const mapping of mappings) {
      for (const field of [
        "tenant_id",
        "organization_id",
        "repo_id",
        "artifacts_name",
      ])
        identifier(mapping[field]);
      const key = JSON.stringify([
        mapping.tenant_id,
        mapping.organization_id,
        mapping.repo_id,
      ]);
      if (keys.has(key))
        throw new Failure(
          "CONFIGURATION_REQUIRED",
          503,
          "Repository mapping is ambiguous",
        );
      keys.add(key);
    }
    this.mappings = mappings;
  }

  async read(input: ObjectRead): Promise<Response> {
    validateScope(input.scope);
    oid(input.oid);
    if (
      input.schema_version !== 1 ||
      !["commit", "tree", "blob"].includes(input.kind) ||
      !Number.isSafeInteger(input.max_bytes) ||
      input.max_bytes <= 0 ||
      input.max_bytes > 16 * 1024 * 1024
    )
      throw new Failure(
        "INVALID_INPUT",
        400,
        "Invalid object hydration request",
      );
    const mapping = this.mappings.find(
      (value) =>
        value.tenant_id === input.scope.tenant_id &&
        value.organization_id === input.scope.organization_id &&
        value.repo_id === input.scope.repo_id,
    );
    if (!mapping)
      throw new Failure(
        "FORBIDDEN",
        403,
        "Repository is outside the configured resource scope",
      );
    const repo = await this.namespace.get(mapping.artifacts_name);
    try {
      if (input.kind === "commit") {
        const commit = await repo.readCommit(input.oid);
        if (!commit)
          throw new Failure(
            "GIT_OBJECT_MISSING",
            404,
            "Git commit is unavailable",
          );
        if (commit.hash !== input.oid || commit.parents.length > 1024)
          throw new Failure(
            "GIT_OBJECT_MISMATCH",
            409,
            "Git commit observation differs",
          );
        oid(commit.treeHash);
        commit.parents.forEach(oid);
        const data = new TextEncoder().encode(
          JSON.stringify({
            schema_version: 1,
            commit_oid: commit.hash,
            tree_oid: commit.treeHash,
            parent_oids: commit.parents,
          }),
        );
        if (data.length > input.max_bytes)
          throw new Failure(
            "HYDRATION_LIMIT",
            413,
            "Commit metadata exceeds budget",
          );
        return new Response(data, {
          headers: {
            "content-type": "application/json",
            "content-length": String(data.length),
          },
        });
      }
      let bytes: Uint8Array;
      if (input.kind === "tree") {
        const entries = await repo.readTree(input.oid);
        if (!entries)
          throw new Failure(
            "GIT_OBJECT_MISSING",
            404,
            "Git tree is unavailable",
          );
        bytes = treeBytes(entries, input.max_bytes);
      } else {
        const blob = await repo.readBlob(input.oid);
        if (!blob)
          throw new Failure(
            "GIT_OBJECT_MISSING",
            404,
            "Git blob is unavailable",
          );
        if (blob.size > input.max_bytes)
          throw new Failure(
            "HYDRATION_LIMIT",
            413,
            "Blob exceeds hydration budget",
          );
        bytes = new Uint8Array(await blob.arrayBuffer());
      }
      await verifyObject(input.kind, input.oid, bytes);
      return new Response(bytes, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
          "x-klocgit-object-oid": input.oid,
        },
      });
    } finally {
      repo[Symbol.dispose]();
    }
  }
}
