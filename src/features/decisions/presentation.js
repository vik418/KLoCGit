export function decisionTitle(decision, workspace) {
  const keys = [
    ...new Set(
      decision.revision_ids
        .map((id) => workspace.revisions.find((r) => r.id === id)?.decision_key)
        .filter(Boolean),
    ),
  ];
  return decision.kind === 'Architectural choice' && keys.length === 1
    ? 'Choose ' + keys[0]
    : decision.title;
}

export function decisionSummary(decision) {
  const observed = decision.edges
    ?.filter(
      (e) => e.classification === 'observed-interaction' || e.classification === 'textual-conflict',
    )
    .map((e) => e.observation)
    .filter(Boolean);
  if (observed?.length) return observed.join(' ');
  if (decision.kind === 'Architectural choice' && decision.alternatives.length)
    return (
      decision.alternatives.map((a) => a.title).join(' or ') +
      '. Choose the behavior to ship and review its evidence.'
    );
  return decision.summary;
}
