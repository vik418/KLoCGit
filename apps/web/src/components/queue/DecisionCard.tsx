import { useRef, useState } from "react";
import type { DecisionPacket, Scope, Session } from "../../../../../packages/contracts/src/views.ts";
import { Client, ApiError } from "@/lib/api";
import { BlastRadius } from "@/components/blast/BlastRadius";
import { EvidencePanel } from "@/components/incident/EvidencePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Check, GitCommitHorizontal, LoaderCircle, TriangleAlert } from "lucide-react";

const blockerLabels: Record<string, string> = {
  CAPABILITY_REQUIRED: "Required analysis capability is unavailable",
  ANALYSIS_INCOMPLETE: "Required analysis is incomplete",
  EVIDENCE_REQUIRED: "Required evidence is missing",
  EVIDENCE_FAILED: "Required checks failed",
  REVIEW_REQUIRED: "Human approval is required",
  PREDICATE_UNSATISFIED: "An approval condition is no longer satisfied",
  REDUCTION_INCOMPLETE: "Candidate discovery is incomplete",
};

export function DecisionCard({ client, scope, packet, session, author, refresh }: {
  client: Client; scope: Scope; packet: DecisionPacket; session: Session;
  author: { name: string; email: string }; refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(packet.candidates[0]?.candidate.candidate_digest);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempt = useRef<{ packet: DecisionPacket; selected: string; key: string; author: typeof author } | null>(null);
  const alternative = packet.candidates.find(item => item.candidate.candidate_digest === selected);
  const blocked = (packet.blockers[selected] ?? []).filter(item => item.code !== "REVIEW_REQUIRED");
  const stale = packet.decision.state === "STALE";
  const canApprove = session.actor_type === "human" && !stale && !blocked.length && !!author.name.trim() && !!author.email.trim();

  async function approve() {
    if (!alternative || busy) return;
    setBusy(true); setMessage(null);
    try {
      let operation = attempt.current;
      if (!operation) {
        const reviewed = await client.review(scope, packet, selected, crypto.randomUUID());
        if (reviewed.decision.state !== "RESOLVABLE") {
          setMessage("Approval recorded. Additional required reviews remain.");
          await refresh(); return;
        }
        operation = { packet: reviewed, selected, key: crypto.randomUUID(), author: { ...author } };
        attempt.current = operation;
      }
      await client.promote(scope, operation.packet, operation.selected, operation.key, operation.author);
      attempt.current = null;
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) attempt.current = null;
      setMessage(error instanceof Error ? error.message : "The request could not be completed.");
      await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }

  return <Card className="gap-5">
    <CardHeader>
      <div className="mb-1 flex items-center justify-between gap-4">
        <Badge variant="outline">{stale ? "Review needs updating" : packet.decision.state === "RESOLVABLE" ? "Ready to promote" : "Needs your decision"}</Badge>
        <span className="text-xs text-muted-foreground">{packet.candidates.length} alternatives</span>
      </div>
      <CardTitle className="text-lg font-semibold tracking-tight">{packet.question}</CardTitle>
      <CardDescription>Select a validated state to accept. Every source revision remains in history.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      <fieldset className="space-y-2" disabled={busy || !!attempt.current}>
        <legend className="sr-only">Candidate alternatives</legend>
        {packet.candidates.map((item, index) => {
          const digest = item.candidate.candidate_digest;
          const statuses = item.effects.map(effect => effect.status);
          const evidence = packet.evidence.filter(row => row.subject_digest === digest);
          const passing = evidence.length > 0 && evidence.every(row => row.result === "PASSED");
          return <label key={digest} className={"flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors " + (selected === digest ? "border-primary/50 bg-primary/5" : "hover:bg-muted")}>
            <input type="radio" name={packet.decision.id} value={digest} checked={selected === digest}
              onChange={() => { setSelected(digest); setMessage(null); }}
              aria-label={"Alternative " + (index + 1)} className="mt-1 accent-[#f5ee9e]" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">Alternative {index + 1}</span>
                <Badge variant="secondary">{passing ? "Checks passed" : "Validation blocked"}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{item.spec.selected_future_revisions.length} source revisions · {Object.keys(item.candidate.repo_tree_oids).length} repositories</p>
              {statuses.some(status => status !== "COMPLETE") && <p className="mt-1 text-xs text-primary">Analysis: {[...new Set(statuses)].join(", ")}</p>}
            </div>
          </label>;
        })}
      </fieldset>
      {alternative && <>
        <BlastRadius alternative={alternative} /><Separator />
        <EvidencePanel client={client} scope={scope} packet={packet} candidate={selected} />
        <details className="text-xs text-muted-foreground"><summary>Exact state and decision basis</summary>
          <dl className="mt-3 space-y-2 break-all">
            <dt>Candidate</dt><dd className="font-mono">{selected}</dd>
            <dt>Reviewed basis</dt><dd className="font-mono">{packet.decision.basis.basis_digest}</dd>
            {Object.entries(alternative.candidate.repo_tree_oids).map(([repo, tree]) => <div key={repo}><dt>{repo} tree</dt><dd className="font-mono">{tree}</dd></div>)}
          </dl>
        </details>
      </>}
      {!!blocked.length && <Alert><TriangleAlert aria-hidden="true" /><AlertDescription>
        <ul className="space-y-1">{blocked.map((item, index) => <li key={index}>{blockerLabels[item.code] ?? item.code.replaceAll("_", " ").toLowerCase()}</li>)}</ul>
      </AlertDescription></Alert>}
      {stale && <Alert><TriangleAlert aria-hidden="true" /><AlertDescription>The accepted state or material inputs changed. This review cannot be applied to the old state.</AlertDescription></Alert>}
      {message && <p role="status" className="text-primary">{message}</p>}
    </CardContent>
    <CardFooter className="flex flex-wrap items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-xs text-muted-foreground"><GitCommitHorizontal className="size-4" aria-hidden="true" />Promotion checks the current Git head</span>
      <Button onClick={() => void approve()} disabled={busy || (!canApprove && !attempt.current)}>
        {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
        {busy ? "Applying…" : attempt.current ? "Reconcile promotion" : "Approve and promote"}
      </Button>
    </CardFooter>
  </Card>;
}
