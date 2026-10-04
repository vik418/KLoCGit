// Completion state and finite check result are separate inputs. Unknown or
// unfinished states cannot authorize a canonical write, even with passed:true.
export function validationPassed(evidence) {
  if (evidence?.result?.passed !== true) return false;
  const states = [evidence.state, evidence.status, evidence.result.state, evidence.result.status].filter(value => value !== undefined && value !== null);
  return states.every(value => ['passing', 'passed', 'success', 'succeeded', 'completed'].includes(value)) && (evidence.result.checks ?? []).every(check => check.passed === true && [check.state, check.status].filter(value => value !== undefined && value !== null).every(value => ['passing', 'passed', 'success', 'succeeded', 'completed'].includes(value)));
}
