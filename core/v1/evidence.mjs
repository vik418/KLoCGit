/** Exact-state Evidence identity and policy-controlled reuse. */
import { V1Error, assertSchemaVersion, objectId, parseDigest } from './conventions.mjs';
import { Evidence, copyJsonData, gitOid } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';
import { verifyCandidateContent } from './promotion.mjs';

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function text(value) {
  valid(typeof value === 'string' && value.trim().length > 0);
  return value;
}

/** Include commits: checks may inspect Git history as well as file contents. */
export async function evidenceSubject(input) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  valid(
    Object.keys(value).length === 3 &&
      value.repo_tree_oids &&
      value.repo_commit_oids &&
      !Array.isArray(value.repo_tree_oids) &&
      !Array.isArray(value.repo_commit_oids) &&
      Object.keys(value.repo_tree_oids).length > 0 &&
      Object.keys(value.repo_commit_oids).length === Object.keys(value.repo_tree_oids).length,
  );
  for (const [repo, tree] of Object.entries(value.repo_tree_oids)) {
    text(repo);
    gitOid(tree);
    valid(Object.hasOwn(value.repo_commit_oids, repo));
    gitOid(value.repo_commit_oids[repo], tree.length);
  }
  return freeze({ ...value, digest: await digestCanonical('evidence-subject', value) });
}

export async function candidateEvidenceSubject(input) {
  const candidate = await verifyCandidateContent(input);
  return evidenceSubject({
    schema_version: 1,
    repo_tree_oids: candidate.repo_tree_oids,
    repo_commit_oids: candidate.materialization_record.repo_commit_oids,
  });
}

export async function buildEvidence(input) {
  const body = copyJsonData(input);
  valid(!Object.hasOwn(body, 'id'));
  return Evidence({
    ...body,
    id: objectId('evidence', await digestCanonical('object-evidence', body)),
  });
}

export async function verifyEvidence(input) {
  const evidence = Evidence(input);
  const { id, ...body } = evidence;
  const digest = await digestCanonical('object-evidence', body);
  if (objectId('evidence', digest) !== id) throw new V1Error('INTEGRITY_MISMATCH');
  return freeze({ evidence, digest });
}

/** Policy explicitly lists evaluator versions; a name alone does not establish trust. */
export function evidenceRequirements(input) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  valid(Object.keys(value).length === 3 && Array.isArray(value.checks));
  parseDigest(value.policy_digest);
  const ids = new Set();
  for (const check of value.checks) {
    assertSchemaVersion(check);
    valid(Object.keys(check).length === 6);
    text(check.id);
    text(check.type);
    valid(!ids.has(check.id));
    ids.add(check.id);
    parseDigest(check.config_digest);
    parseDigest(check.environment_digest);
    valid(Array.isArray(check.producers) && check.producers.length > 0);
    const producers = new Set();
    for (const producer of check.producers) {
      assertSchemaVersion(producer);
      valid(Object.keys(producer).length === 3);
      text(producer.identity);
      valid(!producers.has(producer.identity));
      producers.add(producer.identity);
      valid(Array.isArray(producer.versions) && producer.versions.length > 0);
      producer.versions.forEach(text);
      valid(new Set(producer.versions).size === producer.versions.length);
      producer.versions.sort();
    }
    check.producers.sort((a, b) => (a.identity < b.identity ? -1 : 1));
  }
  value.checks.sort((a, b) => (a.id < b.id ? -1 : 1));
  return freeze(value);
}

function dependencies(options) {
  valid(typeof options?.verifyProvenance === 'function');
  valid(typeof options?.policyEvaluator?.can_reuse === 'function');
  return {
    verify: options.verifyProvenance,
    reuse: options.policyEvaluator.can_reuse.bind(options.policyEvaluator),
  };
}

async function trustedCall(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof V1Error) throw error;
    throw new V1Error('PROVIDER_UNAVAILABLE');
  }
}

/** Returns eligibility, never a global correctness claim or permission to promote. */
export async function evidenceEligibility(
  evidenceInput,
  subject_digest,
  requirementsInput,
  options,
) {
  const data = Evidence(evidenceInput);
  parseDigest(subject_digest);
  const requirements = evidenceRequirements(requirementsInput);
  const { verify, reuse } = dependencies(options);
  const { evidence, digest } = await verifyEvidence(data);
  const eligible_for = [],
    rejections = [];
  // Attribution verification must consult authenticated receipts/attestations,
  // not repeat the producer_identity field back as an assertion of trust.
  let provenance;
  for (const check of requirements.checks) {
    let reason = null;
    if (evidence.subject_digest !== subject_digest) reason = 'SUBJECT_MISMATCH';
    else if (evidence.type !== check.type) reason = 'TYPE_MISMATCH';
    else if (evidence.config_digest !== check.config_digest) reason = 'CONFIG_MISMATCH';
    else if (evidence.environment_digest !== check.environment_digest)
      reason = 'ENVIRONMENT_MISMATCH';
    else if (
      !check.producers.some(
        (producer) =>
          producer.identity === evidence.producer_identity &&
          producer.versions.includes(evidence.producer_version),
      )
    )
      reason = 'PRODUCER_MISMATCH';
    else {
      const context = freeze({
        schema_version: 1,
        subject_digest,
        policy_digest: requirements.policy_digest,
        evidence_digest: digest,
      });
      provenance ??= (await trustedCall(() => verify(evidence, context))) === true;
      if (!provenance) reason = 'UNVERIFIED_PROVENANCE';
      else if ((await trustedCall(() => reuse(evidence, check, context))) !== true)
        reason = 'POLICY_REJECTED';
    }
    if (reason) rejections.push({ check_id: check.id, reason });
    else eligible_for.push(check.id);
  }
  return freeze({ schema_version: 1, evidence, evidence_digest: digest, eligible_for, rejections });
}

/** Provider transport is injected; all returned records are checked at this boundary. */
export class EvidenceProvider {
  constructor({ provider, verifyProvenance, policyEvaluator, max_records }) {
    valid(
      typeof provider?.find_reusable === 'function' && typeof provider?.evaluate === 'function',
    );
    dependencies({ verifyProvenance, policyEvaluator });
    valid(Number.isSafeInteger(max_records) && max_records > 0);
    this.find = provider.find_reusable.bind(provider);
    this.run = provider.evaluate.bind(provider);
    this.options = Object.freeze({
      verifyProvenance,
      policyEvaluator: Object.freeze({
        can_reuse: policyEvaluator.can_reuse.bind(policyEvaluator),
      }),
    });
    this.max_records = max_records;
  }

  async #checked(recordsInput, subject_digest, requirements, strict) {
    valid(Array.isArray(recordsInput) && recordsInput.length <= this.max_records);
    const records = copyJsonData(recordsInput);
    const accepted = new Map();
    for (const input of records) {
      const report = await evidenceEligibility(input, subject_digest, requirements, this.options);
      if (report.eligible_for.length) accepted.set(report.evidence.id, report.evidence);
      else if (strict) throw new V1Error('POLICY_REJECTED');
    }
    return Object.freeze([...accepted.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
  }

  async find_reusable(subject_digest, requirementsInput) {
    parseDigest(subject_digest);
    const requirements = evidenceRequirements(requirementsInput);
    if (!requirements.checks.length) return Object.freeze([]);
    return this.#checked(
      await trustedCall(() => this.find(subject_digest, requirements)),
      subject_digest,
      requirements,
      false,
    );
  }

  async evaluate(candidateInput, requirementsInput) {
    const candidateData = copyJsonData(candidateInput);
    const requirements = evidenceRequirements(requirementsInput);
    const candidate = await verifyCandidateContent(candidateData);
    const subject = await candidateEvidenceSubject(candidate);
    if (!requirements.checks.length) return Object.freeze([]);
    return this.#checked(
      await trustedCall(() => this.run(candidate, requirements)),
      subject.digest,
      requirements,
      true,
    );
  }
}
