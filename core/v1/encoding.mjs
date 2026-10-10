/** Deterministic encoding identifies declared data, not semantic equivalence. */
import { encode } from 'cbor2';
import { V1Error, assertSchemaVersion, digestBytes } from './conventions.mjs';
import { EffectSet, copyJsonData, validateDomain } from './domain.mjs';

const options = Object.freeze({
  cde: true,
  ignoreOriginalEncoding: true,
  rejectUndefined: true,
  rejectBigInts: true,
  rejectDuplicateKeys: true,
  rejectCustomSimples: true,
  stringNormalization: null,
  wtf8: false,
});

/** Validate and copy before the encoder can invoke producer-defined methods. */
export function encodeCanonical(input) {
  return encode(copyJsonData(input), options);
}

/** Callers supply an explicit identity projection; no fields are guessed away. */
export function digestCanonical(domain, projection) {
  return digestBytes(domain, encodeCanonical(projection));
}

function assertValid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function compareBytes(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

/** Sets use lexicographic canonical CBOR bytes, never locale-dependent sorting. */
function orderedSet(values, project = (value) => value) {
  const entries = values.map((value) => ({ value, bytes: encodeCanonical(project(value)) }));
  entries.sort((left, right) => compareBytes(left.bytes, right.bytes));
  for (let index = 1; index < entries.length; index += 1) {
    assertValid(compareBytes(entries[index - 1].bytes, entries[index].bytes) !== 0);
  }
  return entries.map((entry) => entry.value);
}

function identity(value) {
  // Git paths and symbols may differ by case, Unicode form or whitespace.
  assertValid(typeof value === 'string' && value.trim().length > 0);
  return value;
}

function token(value) {
  assertValid(
    typeof value === 'string' &&
      value.length <= 64 &&
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value),
  );
  return value;
}

function plain(value) {
  assertValid(value !== null && typeof value === 'object' && !Array.isArray(value));
}

function annotations(value) {
  plain(value);
  const allowed = ['observed_at', 'trace_id', 'runtime_metrics', 'transient_locations'];
  assertValid(Object.keys(value).every((key) => allowed.includes(key)));
  if (Object.hasOwn(value, 'observed_at')) identity(value.observed_at);
  if (Object.hasOwn(value, 'trace_id')) identity(value.trace_id);
  if (Object.hasOwn(value, 'runtime_metrics')) plain(value.runtime_metrics);
  if (Object.hasOwn(value, 'transient_locations')) {
    assertValid(Array.isArray(value.transient_locations));
    value.transient_locations.forEach(identity);
  }
}

function materialEffect(value) {
  const material = { ...value };
  delete material.annotations;
  return material;
}

function normalizeEffect(value) {
  plain(value);
  assertSchemaVersion(value);
  const required = ['schema_version', 'kind', 'target', 'operation', 'attributes', 'references'];
  assertValid(required.every((field) => Object.hasOwn(value, field)));
  assertValid(
    Object.keys(value).every((field) => required.includes(field) || field === 'annotations'),
  );
  token(value.kind);
  identity(value.target);
  token(value.operation);
  plain(value.attributes);
  assertValid(Array.isArray(value.references));
  value.references.forEach(identity);
  if (Object.hasOwn(value, 'annotations')) annotations(value.annotations);
  return { ...value, references: orderedSet(value.references) };
}

/**
 * Normalize the declared effect sets and reference sets. Annotation differences
 * do not create distinct effects. Attributes and their nested arrays stay ordered.
 */
export function normalizeEffectSet(input) {
  const record = EffectSet(input);
  return EffectSet({
    ...record,
    effects: orderedSet(record.effects.map(normalizeEffect), materialEffect),
    security_effects: orderedSet(record.security_effects.map(normalizeEffect), materialEffect),
  });
}

/** Only explicit non-material annotations and the self digest are omitted. */
export function materialEffectProjection(input) {
  const record = { ...normalizeEffectSet(input) };
  delete record.digest;
  return Object.freeze({
    ...record,
    effects: Object.freeze(record.effects.map((value) => Object.freeze(materialEffect(value)))),
    security_effects: Object.freeze(
      record.security_effects.map((value) => Object.freeze(materialEffect(value))),
    ),
  });
}

export function materialEffectDigest(input) {
  return digestCanonical('material-effect', materialEffectProjection(input));
}

/** The full effect record identity retains annotations, unlike material identity. */
export function effectSetDigest(input) {
  const record = { ...normalizeEffectSet(input) };
  delete record.digest;
  return digestCanonical('effect-set', record);
}

const setFields = Object.freeze({
  CandidateSpec: ['selected_future_revisions', 'required_dependencies'],
  DecisionBasis: ['candidate_digests', 'evidence_digests'],
  SystemRevision: ['accepted_decisions'],
});

function normalizedRecord(type, input) {
  if (type === 'EffectSet') return normalizeEffectSet(input);
  const record = { ...validateDomain(type, input) };
  for (const field of setFields[type] ?? []) record[field] = orderedSet(record[field]);
  if (type === 'Decision' && record.basis !== null) {
    record.basis = normalizedRecord('DecisionBasis', record.basis);
  }
  return record;
}

/** Persistence encoding includes IDs and self digests; it is not an ID builder. */
export function encodeDomain(type, input) {
  return encodeCanonical(normalizedRecord(type, input));
}
