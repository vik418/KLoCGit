import type { DecisionAlternative } from "../../../../../packages/contracts/src/views.ts";
import { Badge } from "@/components/ui/badge";
import { FileCode2, Package, Database, ShieldAlert } from "lucide-react";

export function BlastRadius({ alternative }: { alternative: DecisionAlternative }) {
  const exports = [...new Set(alternative.effects.flatMap(effect => effect.modified_exports))].sort();
  const dependencies = alternative.effects.flatMap(effect => Object.entries(effect.added_dependencies));
  const security = [...new Set(alternative.effects.flatMap(effect => effect.security_effects))].sort();
  const migrations = alternative.effects.some(effect => effect.db_migrations_detected);
  const paths = [...new Set(alternative.spec.composition_manifest.map(slice => slice.path))].sort();
  return <section aria-label="Blast radius" className="space-y-5">
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline">{paths.length} changed {paths.length === 1 ? "file" : "files"}</Badge>
      <Badge variant="outline">{exports.length} exported {exports.length === 1 ? "symbol" : "symbols"}</Badge>
      {migrations && <Badge><Database aria-hidden="true" />Migration detected</Badge>}
    </div>
    <div>
      <h4 className="mb-2 flex items-center gap-2 font-medium"><FileCode2 className="size-4 text-primary" aria-hidden="true" />Public API</h4>
      {exports.length ? <ul className="space-y-1">{exports.map(name => <li key={name} className="font-mono text-xs break-all">{name}</li>)}</ul> : <p className="text-muted-foreground">No exported symbol changes detected.</p>}
    </div>
    {!!dependencies.length && <div>
      <h4 className="mb-2 flex items-center gap-2 font-medium"><Package className="size-4 text-primary" aria-hidden="true" />Dependencies added</h4>
      <ul className="space-y-1">{dependencies.map(([name, version], i) => <li key={name + i}><span className="font-mono text-xs">{name}</span><span className="ml-2 text-muted-foreground">{version}</span></li>)}</ul>
    </div>}
    {!!security.length && <div>
      <h4 className="mb-2 flex items-center gap-2 font-medium"><ShieldAlert className="size-4 text-primary" aria-hidden="true" />Security-sensitive changes</h4>
      <ul>{security.map(item => <li key={item} className="text-muted-foreground">{item}</li>)}</ul>
    </div>}
    <details className="rounded-md border p-3">
      <summary className="font-medium">Changed files and source attribution</summary>
      <ul className="mt-3 space-y-2">{alternative.spec.composition_manifest.map((slice, index) =>
        <li key={index} className="flex flex-wrap justify-between gap-2 text-xs">
          <span className="font-mono break-all">{slice.path}</span>
          <span className="text-muted-foreground">Future {slice.source_future_id.slice(0, 16)} · commit {slice.source_commit_oid.slice(0, 12)}</span>
        </li>)}</ul>
    </details>
  </section>;
}
