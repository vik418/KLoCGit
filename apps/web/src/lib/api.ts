import type { AttentionSnapshot, DecisionPacket, Scope, Session } from "../../../../packages/contracts/src/views.ts";

const API_VERSION = "2026-10-12";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function objectivePath(scope: Scope) {
  return "/api/tenants/" + encodeURIComponent(scope.tenant_id) +
    "/organizations/" + encodeURIComponent(scope.organization_id) +
    "/repos/" + encodeURIComponent(scope.repo_id) +
    "/objectives/" + encodeURIComponent(scope.objective_id);
}

export class Client {
  constructor(private token: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: "Bearer " + this.token, "KLoCGit-Version": API_VERSION, ...extra };
  }

  async request<T>(path: string, body?: unknown, key?: string): Promise<T> {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: this.headers({
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new ApiError(response.status, result?.error?.code ?? "UNAVAILABLE",
        result?.error?.message ?? "The request could not be completed.");
    }
    return response.json() as Promise<T>;
  }

  session() { return this.request<Session>("/api/session"); }
  decisions(scope: Scope) { return this.request<AttentionSnapshot>(objectivePath(scope) + "/decisions"); }
  evidence(scope: Scope, packet: DecisionPacket, digest: string) {
    return this.request<unknown>(objectivePath(scope) + "/decisions/" +
      encodeURIComponent(packet.decision.id) + "/evidence/" + encodeURIComponent(digest));
  }

  review(scope: Scope, packet: DecisionPacket, candidate: string, key: string) {
    return this.request<DecisionPacket>(objectivePath(scope) + "/decisions/" +
      encodeURIComponent(packet.decision.id) + "/review",
      { basis_digest: packet.decision.basis.basis_digest, candidate_digest: candidate }, key);
  }
  promote(scope: Scope, packet: DecisionPacket, candidate: string, key: string, author: { name: string; email: string }) {
    return this.request<{ target_oid: string }>(objectivePath(scope) + "/decisions/" +
      encodeURIComponent(packet.decision.id) + "/promote",
      { basis_digest: packet.decision.basis.basis_digest, candidate_digest: candidate, author }, key);
  }

  async stream(scope: Scope, signal: AbortSignal, receive: (snapshot: AttentionSnapshot) => void) {
    const response = await fetch(objectivePath(scope) + "/decisions/stream", {
      headers: this.headers({ Accept: "text/event-stream" }), signal,
    });
    if (!response.ok || !response.body)
      throw new ApiError(response.status, "STREAM_UNAVAILABLE", "Live updates are unavailable.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 8 * 1024 * 1024) throw new Error("Live update exceeds its limit.");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (data) receive(JSON.parse(data) as AttentionSnapshot);
        }
      }
    } finally { await reader.cancel().catch(() => undefined); }
    if (!signal.aborted) throw new Error("Live connection closed.");
  }
}
