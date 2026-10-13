import { useEffect, useState } from "react";
import type { Scope, Session } from "../../../../../packages/contracts/src/views.ts";
import { Client } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Folder, File, GitFork, Plus, ArrowLeft, Copy, GitCommitHorizontal } from "lucide-react";

type Repository = { repo_id: string; name: string; description: string; remote: string | null; state: string };
type TreeEntry = { name: string; hash: string; type: string };
type Code = { empty?: boolean; commit_oid: string; tree_oid: string; ref: string;
  entries: TreeEntry[]; commits: { oid: string; message: string }[] };

export function RepositoryBrowser({ client, session }: { client: Client; session: Session }) {
  const organization = session.organization_grants?.find(grant => grant.actions.includes("read"))?.scope;
  const [available, setAvailable] = useState<{ name: string; status: string }[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selected, setSelected] = useState<Repository | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [directory, setDirectory] = useState<{ path: string; tree: string }[]>([]);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [creating, setCreating] = useState<"create" | "fork" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [objective, setObjective] = useState("");
  const [objectiveMessage, setObjectiveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = organization ? "/api/tenants/" + encodeURIComponent(organization.tenant_id) +
    "/organizations/" + encodeURIComponent(organization.organization_id) + "/repos" : "";

  async function refresh() {
    if (!base) return;
    const result = await client.request<{ repositories: Repository[] }>(base);
    setRepositories(result.repositories);
    const discovered = await client.request<{ repositories: { name: string; status: string }[] }>(base + "/discover");
    setAvailable(discovered.repositories.filter(repo => !result.repositories.some(mapped => mapped.repo_id === repo.name)));
  }
  useEffect(() => { void refresh().catch(cause => setError(cause.message)); }, [base, client]);

  async function open(repo: Repository, tree?: string, path = "", ref?: string) {
    setBusy(true); setError(null);
    try {
      const ready = await client.request<Repository>(base + "/" + encodeURIComponent(repo.repo_id));
      const query = new URLSearchParams();
      if (tree) query.set("tree", tree);
      if (ref) query.set("ref", ref);
      const next = await client.request<Code>(base + "/" + encodeURIComponent(repo.repo_id) + "/code?" + query);
      setSelected(ready); setCode(next); setFile(null);
      if (!tree) setDirectory([{ path: "", tree: next.tree_oid }]);
      else setDirectory(current => [...current, { path, tree }]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Repository could not be loaded."); }
    finally { setBusy(false); }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!creating) return;
    setBusy(true); setError(null);
    try {
      const path = creating === "fork" ? base + "/" + encodeURIComponent(selected!.repo_id) + "/fork" : base;
      const result = await client.request<Repository>(path, {
        name, description, ...(creating === "create" && source ? { source_url: source } : {}),
      }, crypto.randomUUID());
      setCreating(null); setName(""); setDescription(""); setSource("");
      await refresh(); await open(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Repository could not be created."); }
    finally { setBusy(false); }
  }

  async function connect(name: string) {
    setBusy(true); setError(null);
    try { const record = await client.request<Repository>(base + "/connect", { name, artifacts_name: name }, crypto.randomUUID());
      await refresh(); await open(record); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Repository could not be connected."); }
    finally { setBusy(false); }
  }

  async function read(entry: TreeEntry) {
    if (!selected || !code) return;
    const current = directory.at(-1)?.path ?? "";
    const path = current ? current + "/" + entry.name : entry.name;
    if (entry.type === "tree") { await open(selected, entry.hash, path, code.commit_oid); return; }
    setBusy(true); setError(null);
    try {
      const value = await client.request<{ path: string; content: string }>(base + "/" +
        encodeURIComponent(selected.repo_id) + "/file?" + new URLSearchParams({ ref: code.commit_oid, path }));
      setFile(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "File could not be loaded."); }
    finally { setBusy(false); }
  }

  async function createObjective(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setError(null);
    try {
      const id = crypto.randomUUID();
      await client.request(base + "/" + encodeURIComponent(selected.repo_id) + "/objectives",
        { objective_id: id, statement: objective }, id);
      setObjective(""); setObjectiveMessage("Objective created. Open Attention to review its work.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Objective could not be created."); }
    finally { setBusy(false); }
  }

  async function parent() {
    if (!selected || !code || directory.length < 2) return;
    const previous = directory[directory.length - 2];
    const value = await client.request<Code>(base + "/" + encodeURIComponent(selected.repo_id) +
      "/code?" + new URLSearchParams({ ref: code.commit_oid, tree: previous.tree }));
    setCode(value); setDirectory(current => current.slice(0, -1)); setFile(null);
  }

  return <section className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-semibold tracking-tight">{selected?.name ?? "Repositories"}</h1>
        <p className="mt-2 text-muted-foreground">{selected?.description ?? "Your source, history, and isolated workspaces."}</p></div>
      <div className="flex gap-2">
        {selected && <Button variant="outline" onClick={() => { setSelected(null); setCode(null); setFile(null); }}><ArrowLeft aria-hidden="true" />All repositories</Button>}
        {organization && <Button onClick={() => setCreating("create")}><Plus aria-hidden="true" />New repository</Button>}
      </div>
    </div>
    {error && <Alert><AlertDescription>{error}</AlertDescription></Alert>}
    {creating && <Card><CardHeader><CardTitle>{creating === "fork" ? "Fork repository" : "Create repository"}</CardTitle></CardHeader>
      <CardContent><form onSubmit={event => void create(event)} className="space-y-4">
        <div><label htmlFor="repository-name" className="mb-1 block font-medium">Repository name</label>
          <Input id="repository-name" required value={name} onChange={event => setName(event.target.value)} /></div>
        <div><label htmlFor="repository-description" className="mb-1 block font-medium">Description</label>
          <Input id="repository-description" value={description} onChange={event => setDescription(event.target.value)} /></div>
        {creating === "create" && <div><label htmlFor="repository-source" className="mb-1 block font-medium">Import from a public Git URL</label>
          <Input id="repository-source" type="url" value={source} onChange={event => setSource(event.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">Leave empty to create an empty Git repository.</p></div>}
        <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={() => setCreating(null)}>Cancel</Button>
          <Button disabled={busy}>{busy ? "Creating…" : creating === "fork" ? "Create fork" : "Create repository"}</Button></div>
      </form></CardContent></Card>}
    {!selected && <div className="space-y-2">{repositories.map(repo => <button key={repo.repo_id}
      className="flex w-full items-center justify-between rounded-lg border bg-card p-4 text-left hover:bg-muted"
      onClick={() => void open(repo)} disabled={busy}>
      <span><span className="block font-medium">{repo.name}</span><span className="text-xs text-muted-foreground">{repo.description}</span></span>
      <Badge variant="outline">{repo.state.toLowerCase()}</Badge>
    </button>)}
      {!repositories.length && <p className="rounded-lg border p-8 text-center text-muted-foreground">Create or import your first repository.</p>}
    </div>}
    {!selected && !!available.length && <Card><CardHeader><CardTitle className="text-base">Existing Artifacts repositories</CardTitle></CardHeader>
      <CardContent className="space-y-3">{available.map(repo => <div key={repo.name} className="flex items-center justify-between gap-3">
        <span className="min-w-0 break-all font-mono text-xs">{repo.name}</span>
        <Button variant="outline" size="sm" disabled={busy || repo.status !== "ready"} onClick={() => void connect(repo.name)}>Connect</Button>
      </div>)}</CardContent></Card>}
    {selected && code && <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><GitCommitHorizontal className="size-4" aria-hidden="true" />
          {code.empty ? "No commits yet" : code.commit_oid.slice(0, 12)}<Badge variant="secondary">{code.ref}</Badge></div>
        <div className="flex gap-2"><Button variant="outline" onClick={() => setCreating("fork")} disabled={busy || !!code.empty}><GitFork aria-hidden="true" />Fork</Button>
          {selected.remote && <Button variant="outline" onClick={() => void navigator.clipboard.writeText(selected.remote!)}><Copy aria-hidden="true" />Copy clone URL</Button>}</div>
      </div>
      {!!directory.at(-1)?.path && <Button variant="ghost" onClick={() => void parent()}><ArrowLeft aria-hidden="true" />Parent directory</Button>}
      {file ? <Card><CardHeader><CardTitle className="break-all font-mono text-sm">{file.path}</CardTitle></CardHeader>
        <CardContent><Button variant="ghost" className="mb-3" onClick={() => setFile(null)}><ArrowLeft aria-hidden="true" />Back to files</Button>
          <pre className="max-h-[70dvh] whitespace-pre text-xs leading-6">{file.content}</pre></CardContent></Card>
        : <div className="overflow-hidden rounded-lg border">{[...code.entries].sort((a, b) =>
          Number(b.type === "tree") - Number(a.type === "tree") || a.name.localeCompare(b.name)).map(entry =>
          <button key={entry.name} className="flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-muted"
            onClick={() => void read(entry)} disabled={busy}>{entry.type === "tree" ? <Folder className="size-4 text-primary" aria-hidden="true" /> : <File className="size-4 text-muted-foreground" aria-hidden="true" />}{entry.name}</button>)}
          {code.empty && <p className="p-8 text-muted-foreground">This repository is empty. Its clone URL is ready for a standard Git client.</p>}
        </div>}
      <Card><CardHeader><CardTitle className="text-base">Start an objective</CardTitle></CardHeader><CardContent>
        <form onSubmit={event => void createObjective(event)} className="flex flex-col gap-3 sm:flex-row">
          <Input aria-label="Objective" required value={objective} onChange={event => setObjective(event.target.value)} />
          <Button disabled={busy || !!code.empty}>Create objective</Button>
        </form>{objectiveMessage && <p className="mt-3 text-sm text-primary" role="status">{objectiveMessage}</p>}
      </CardContent></Card>
      {!!code.commits.length && <details className="rounded-lg border p-4"><summary className="font-medium">Commit history</summary>
        <ul className="mt-3 space-y-3">{code.commits.map(commit => <li key={commit.oid} className="text-sm">
          <span className="mr-3 font-mono text-xs text-muted-foreground">{commit.oid.slice(0, 12)}</span>{commit.message.split("\n")[0]}
        </li>)}</ul></details>}
    </>}
  </section>;
}
