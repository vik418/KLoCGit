/** Ranking is a disposable priority projection, never an authorization input. */
import { V1Error, assertSchemaVersion, parseDigest, parseObjectId } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';
import { verifyCandidateSpec } from './reduction.mjs';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export async function scheduleOptionalRanking(inputs, summaryInput, { ranker, timeout_ms }) {
  if (
    !Number.isSafeInteger(timeout_ms) ||
    timeout_ms < 1 ||
    (ranker !== null && typeof ranker?.rank !== 'function')
  )
    throw new V1Error('INVALID_ARGUMENT');
  const copied = copyJsonData(inputs);
  const summary = freeze(copyJsonData(summaryInput));
  assertSchemaVersion(summary);
  const specs = freeze(await Promise.all(copied.map(verifyCandidateSpec)));
  const ids = specs.map(({ id }) => id);
  const known = new Set(ids);
  if (known.size !== ids.length) throw new V1Error('INVALID_ARGUMENT');
  const basis = await digestCanonical('ranking-basis', {
    schema_version: 1,
    candidate_spec_ids: [...ids].sort(),
    evidence_summary: summary,
  });
  const initial = freeze({
    schema_version: 1,
    basis_digest: basis,
    status: ranker === null ? 'DISABLED' : 'PENDING',
    basis: 'DETERMINISTIC',
    priorities: ids,
  });
  if (ranker === null) return Object.freeze({ initial, completion: Promise.resolve(initial) });
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'TIMED_OUT' });
    }, timeout_ms);
  });
  const attempt = Promise.resolve()
    .then(() => ranker.rank(specs, summary, { signal: controller.signal }))
    .then((output) => {
      const result = copyJsonData(output);
      assertSchemaVersion(result);
      if (
        Object.keys(result).length !== 2 ||
        !Array.isArray(result.priorities) ||
        result.priorities.length !== ids.length ||
        new Set(result.priorities).size !== ids.length ||
        result.priorities.some((id) => !known.has(id))
      )
        throw new V1Error('INTEGRITY_MISMATCH');
      return { status: 'COMPLETE', priorities: result.priorities };
    })
    .catch(() => ({ status: 'FAILED' }));
  // The caller can enqueue or waitUntil this promise. Its initial queue is usable
  // before the model responds, including when the provider never responds.
  const completion = Promise.race([attempt, timeout]).then((result) => {
    clearTimeout(timer);
    return freeze({
      schema_version: 1,
      basis_digest: basis,
      status: result.status,
      basis: result.status === 'COMPLETE' ? 'INFERRED' : 'DETERMINISTIC',
      priorities: result.priorities || ids,
    });
  });
  return Object.freeze({ initial, completion });
}

/** Reject late projections from a different batch or Evidence snapshot. */
export function acceptRanking(currentInput, resultInput) {
  const current = copyJsonData(currentInput),
    result = copyJsonData(resultInput);
  for (const row of [current, result]) {
    assertSchemaVersion(row);
    if (
      Object.keys(row).length !== 5 ||
      !Array.isArray(row.priorities) ||
      new Set(row.priorities).size !== row.priorities.length
    )
      throw new V1Error('INVALID_ARGUMENT');
    parseDigest(row.basis_digest, 'ranking-basis');
    row.priorities.forEach((id) => parseObjectId(id, 'candidate-spec'));
    if (
      !['DETERMINISTIC', 'INFERRED'].includes(row.basis) ||
      !['DISABLED', 'PENDING', 'COMPLETE', 'FAILED', 'TIMED_OUT'].includes(row.status)
    )
      throw new V1Error('INVALID_ARGUMENT');
  }
  if (current.basis_digest !== result.basis_digest) return freeze(current);
  const known = new Set(current.priorities);
  if (
    current.priorities.length !== result.priorities.length ||
    result.priorities.some((id) => !known.has(id))
  )
    throw new V1Error('INTEGRITY_MISMATCH');
  if (result.status !== 'COMPLETE' || result.basis !== 'INFERRED') return freeze(current);
  return freeze(result);
}
