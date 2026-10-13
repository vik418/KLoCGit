import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AttentionSnapshot,
  Scope,
  Session,
} from "../../../packages/contracts/src/views.ts";
import { ApiError, Client, objectivePath } from "@/lib/api";
import { DecisionCard } from "@/components/queue/DecisionCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CheckCheck,
  CircleDot,
  LogOut,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

export function App() {
  const [credential, setCredential] = useState("");
  const [client, setClient] = useState<Client | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [snapshot, setSnapshot] = useState<AttentionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [live, setLive] = useState(false);
  const [author, setAuthor] = useState({ name: "", email: "" });
  const scopes = useMemo(() => {
    const map = new Map<string, Scope>();
    for (const grant of session?.grants ?? []) {
      const item = grant.scope;
      if (
        grant.actions.includes("read") &&
        item.tenant_id &&
        item.organization_id &&
        item.repo_id &&
        item.objective_id
      )
        map.set(objectivePath(item as Scope), item as Scope);
    }
    return [...map.values()];
  }, [session]);

  const refresh = useCallback(async () => {
    if (!client || !scope) return;
    try {
      setSnapshot(await client.decisions(scope));
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Decisions could not be loaded.",
      );
      if (cause instanceof ApiError && cause.status === 401) {
        setSession(null);
        setClient(null);
      }
    }
  }, [client, scope]);

  useEffect(() => {
    setSnapshot(null);
    if (!client || !scope) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void refresh();
    const connect = async () => {
      try {
        await client.stream(scope, controller.signal, (value) => {
          setSnapshot(value);
          setLive(true);
        });
      } catch {
        if (!controller.signal.aborted) {
          setLive(false);
          timer = setTimeout(() => void connect(), 3000);
        }
      }
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      setLive(false);
    };
  }, [client, scope, refresh]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setConnecting(true);
    setError(null);
    const connection = new Client(credential.trim());
    try {
      const identity = await connection.session();
      setSession(identity);
      setClient(connection);
      setCredential("");
      setScope(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    if (!scope && scopes.length) setScope(scopes[0]);
  }, [scope, scopes]);

  if (!session || !client)
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm items-center px-6">
        <Card className="w-full">
          <CardHeader>
            <p className="mb-4 text-sm font-semibold tracking-wide text-primary">
              KLoCGit
            </p>
            <CardTitle className="text-xl">
              Your attention, where it matters.
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => void signIn(event)}
              className="space-y-4"
            >
              <div>
                <label htmlFor="credential" className="mb-2 block font-medium">
                  Access credential
                </label>
                <Input
                  id="credential"
                  type="password"
                  autoComplete="off"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  required
                />
              </div>
              {error && (
                <p role="alert" className="text-primary">
                  {error}
                </p>
              )}
              <Button className="w-full" disabled={connecting}>
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <span className="font-semibold tracking-wide text-primary">
            KLoCGit
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {session.actor_id}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={() => {
                setClient(null);
                setSession(null);
                setScope(null);
                setSnapshot(null);
              }}
            >
              <LogOut aria-hidden="true" />
            </Button>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl md:grid-cols-[220px_1fr]">
        <aside className="border-b p-5 md:min-h-[calc(100dvh-3.5rem)] md:border-r md:border-b-0">
          <p className="mb-4 text-xs font-medium tracking-wide text-muted-foreground">
            OBJECTIVES
          </p>
          <nav
            aria-label="Objectives"
            className="flex flex-wrap gap-2 md:flex-col"
          >
            {scopes.map((item) => (
              <Button
                key={objectivePath(item)}
                variant={
                  scope && objectivePath(item) === objectivePath(scope)
                    ? "secondary"
                    : "ghost"
                }
                className="h-auto justify-start px-3 py-2.5"
                onClick={() => setScope(item)}
              >
                <CircleDot
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span className="min-w-0 text-left">
                  <span className="block truncate">{item.objective_id}</span>
                  <span className="block text-xs text-muted-foreground">
                    {item.repo_id}
                  </span>
                </span>
              </Button>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 p-5 sm:p-8">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Needs your attention
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {snapshot
                  ? snapshot.decisions.length +
                    " unresolved " +
                    (snapshot.decisions.length === 1 ? "decision" : "decisions")
                  : "Evaluating concurrent work"}
                {scope ? " · " + scope.repo_id : ""}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh decisions"
              onClick={() => void refresh()}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
          {!scopes.length && (
            <Alert>
              <AlertDescription>
                No objective access is assigned to this identity.
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert className="mb-5">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {snapshot && !snapshot.policy_configured && (
            <Alert className="mb-5">
              <AlertDescription>
                Review policy must be configured before decisions can be
                resolved.
              </AlertDescription>
            </Alert>
          )}
          {session.actor_type === "human" && (
            <details
              className="mb-6 rounded-lg border p-3"
              open
            >
              <summary className="text-sm font-medium">Commit author</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="author-name"
                    className="mb-1 block text-xs text-muted-foreground"
                  >
                    Name
                  </label>
                  <Input
                    id="author-name"
                    value={author.name}
                    onChange={(event) =>
                      setAuthor((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    autoComplete="name"
                  />
                </div>
                <div>
                  <label
                    htmlFor="author-email"
                    className="mb-1 block text-xs text-muted-foreground"
                  >
                    Email
                  </label>
                  <Input
                    id="author-email"
                    type="email"
                    value={author.email}
                    onChange={(event) =>
                      setAuthor((current) => ({
                        ...current,
                        email: event.target.value,
                      }))
                    }
                    autoComplete="email"
                  />
                </div>
              </div>
            </details>
          )}
          {!snapshot && scope && (
            <div aria-label="Loading decisions" className="space-y-4">
              <Skeleton className="h-56 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
          {snapshot && !snapshot.decisions.length && (
            <div className="rounded-xl border px-6 py-12 text-center">
              <CheckCheck
                className="mx-auto mb-4 size-7 text-primary"
                aria-hidden="true"
              />
              <h2 className="text-lg font-medium">
                {snapshot.pending_candidates
                  ? "Evaluating candidate states"
                  : "Nothing needs your decision"}
              </h2>
              <p className="mt-2 text-muted-foreground">
                {snapshot.pending_candidates
                  ? snapshot.pending_candidates +
                    " candidates are being validated."
                  : "Resolved decisions remain in the audit history."}
              </p>
            </div>
          )}
          {scope && snapshot && (
            <div className="space-y-5">
              {snapshot.decisions.map((packet) => (
                <DecisionCard
                  key={
                    packet.decision.id +
                    ":" +
                    packet.decision.basis.basis_digest
                  }
                  client={client}
                  scope={scope}
                  packet={packet}
                  session={session}
                  author={author}
                  refresh={refresh}
                />
              ))}
            </div>
          )}
          <p className="mt-6 text-xs text-muted-foreground" role="status">
            {live ? "Live updates connected" : "Connecting live updates"}
          </p>
        </main>
      </div>
    </div>
  );
}
