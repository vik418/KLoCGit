import { useState } from "react";
import type {
  DecisionPacket,
  Scope,
} from "../../../../../packages/contracts/src/views.ts";
import { Client } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, FlaskConical } from "lucide-react";

export function EvidencePanel({
  client,
  scope,
  packet,
  candidate,
}: {
  client: Client;
  scope: Scope;
  packet: DecisionPacket;
  candidate: string;
}) {
  const [payloads, setPayloads] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const evidence = packet.evidence.filter(
    (item) => item.subject_digest === candidate,
  );
  async function inspect(digest: string) {
    if (digest in payloads) {
      setPayloads((current) => {
        const next = { ...current };
        delete next[digest];
        return next;
      });
      return;
    }
    setLoading(digest);
    try {
      setPayloads((current) => ({ ...current, [digest]: null }));
      const payload = await client.evidence(scope, packet, digest);
      setPayloads((current) => ({ ...current, [digest]: payload }));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [digest]:
          error instanceof Error
            ? error.message
            : "Evidence could not be loaded.",
      }));
    } finally {
      setLoading(null);
    }
  }
  return (
    <section aria-label="Evidence" className="space-y-3">
      <h4 className="flex items-center gap-2 font-medium">
        <FlaskConical className="size-4 text-primary" aria-hidden="true" />
        Exact-state evidence
      </h4>
      {!evidence.length && (
        <p className="text-muted-foreground">
          Validation has not completed for this candidate.
        </p>
      )}
      {evidence.map((item) => (
        <div key={item.evidence_digest} className="rounded-md border">
          <div className="flex items-center justify-between gap-4 p-3">
            <div className="min-w-0">
              <p className="font-medium">{item.evaluator_id}</p>
              <p className="text-xs text-muted-foreground">
                Version {item.evaluator_version} ·{" "}
                {new Date(item.created_at).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={item.result === "PASSED" ? "secondary" : "outline"}
              >
                {item.result}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void inspect(item.evidence_digest)}
                disabled={loading === item.evidence_digest}
                aria-expanded={item.evidence_digest in payloads}
                aria-label={"Inspect evidence " + item.evaluator_id}
              >
                <ChevronDown aria-hidden="true" />
              </Button>
            </div>
          </div>
          {errors[item.evidence_digest] && (
            <p role="alert" className="px-3 pb-3 text-primary">
              {errors[item.evidence_digest]}
            </p>
          )}
          {payloads[item.evidence_digest] !== undefined &&
            payloads[item.evidence_digest] !== null && (
              <pre className="m-3 mt-0 max-h-96" aria-label="Test receipt">
                {JSON.stringify(payloads[item.evidence_digest], null, 2)}
              </pre>
            )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        These checks report the observed behavior of this exact state.
      </p>
    </section>
  );
}
