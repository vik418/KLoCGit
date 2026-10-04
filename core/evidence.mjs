const PASSING_COMPLETION_STATES = ['passing', 'passed', 'success', 'succeeded', 'completed'];

function completionStatesPassed(states) {
  // Absent state fields are allowed; any supplied state must be allowlisted.
  return states
    .filter((state) => state !== undefined && state !== null)
    .every((state) => PASSING_COMPLETION_STATES.includes(state));
}

function childCheckPassed(check) {
  return check.passed === true && completionStatesPassed([check.state, check.status]);
}

/** Completion state and every finite child check must agree with the explicit passing result. */
export function validationPassed(evidence) {
  if (evidence?.result?.passed !== true) return false;
  const states = [evidence.state, evidence.status, evidence.result.state, evidence.result.status];
  return completionStatesPassed(states) && (evidence.result.checks ?? []).every(childCheckPassed);
}
