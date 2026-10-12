import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canonicalEncode, hashProjection, payloadDigest, sealFutureRevision, sealEffectSet,
  sealCandidateSpec, sealCandidate, sealEvidence, sealDecisionBasis, sealSystemRevision,
  sealReleaseConstraints, sealDeploymentAttestation,
} from '../src/index.ts';
import type { CanonicalValue, ProvenanceSlice } from '../src/index.ts';

const sha = (digit: string) => 'sha256:' + digit.repeat(64);
const state = { repo_id: 'repo', commit_oid: 'a'.repeat(40), tree_oid: 'b'.repeat(40), parent_oids: ['c'.repeat(40), 'd'.repeat(40)] };
const slice = (path: string, future = 'future'): ProvenanceSlice => ({
  repo_id: 'repo', path, selector: { type: 'file', value: path },
  source_future_id: future, source_commit_oid: 'a'.repeat(40),
});
const effects = {
  future_revision_id: 'future', extractor_id: 'tree-sitter.typescript', extractor_version: '1',
  capability: 'STRUCTURAL' as const, status: 'COMPLETE' as const,
  modified_exports: ['𐀀', '\ue000', '𐀀'], added_dependencies: {}, db_migrations_detected: false, security_effects: [],
};

test('golden vectors match canonical bytes and explicit hash domains', async () => {
  const vectors = JSON.parse(await readFile(new URL('../../../tests/fixtures/canonical.golden.json', import.meta.url), 'utf8'));
  for (const vector of vectors) {
    if (vector.payload_hex !== undefined) {
      assert.equal(await payloadDigest(Uint8Array.from(Buffer.from(vector.payload_hex, 'hex'))), vector.expected_digest);
    } else {
      assert.equal(Buffer.from(canonicalEncode(vector.projection)).toString('hex'), vector.cbor_hex, vector.name);
      assert.equal(await hashProjection(vector.domain, vector.projection), vector.expected_digest, vector.name);
    }
  }
});

test('sets normalize by UTF-8 bytes and semantic parent order is preserved', async () => {
  const a = await sealEffectSet(effects);
  const b = await sealEffectSet({ ...effects, modified_exports: ['\ue000', '𐀀'] });
  assert.deepEqual(a.modified_exports, ['\ue000', '𐀀']); assert.equal(a.effect_digest, b.effect_digest);
  const metadata = { system_id: 'system', ref: 'refs/futures/a/work', producer: { actor_id: 'a' }, observed_at: '2026-01-01T00:00:00Z' };
  assert.notEqual((await sealFutureRevision(state, metadata)).state_digest, (await sealFutureRevision({ ...state, parent_oids: [...state.parent_oids].reverse() }, metadata)).state_digest);
});

test('provenance refinements change record identity while observation time does not', async () => {
  const metadata = { system_id: 'system', ref: 'refs/futures/a/work', producer: { actor_id: 'a' }, observed_at: '2026-01-01T00:00:00Z' };
  const a = await sealFutureRevision(state, metadata);
  const b = await sealFutureRevision(state, { ...metadata, observed_at: '/executor/transient' });
  assert.equal(a.record_digest, b.record_digest);
  const c = await sealFutureRevision(state, { ...metadata, producer: { actor_id: 'a', agent_version: '2' } });
  assert.equal(a.state_digest, c.state_digest); assert.notEqual(a.record_digest, c.record_digest);
});

test('candidate composition manifests and selection sets are stably sorted', async () => {
  const value = { base_revisions: { repo: 'a'.repeat(40) }, selected_future_revisions: ['b', 'a', 'a'], composition_manifest: [slice('z', 'b'), slice('a', 'a')], creation_reason: 'composition', effect_summary_digest: sha('a') };
  const a = await sealCandidateSpec(value), b = await sealCandidateSpec({ ...value, selected_future_revisions: [...value.selected_future_revisions].reverse(), composition_manifest: [...value.composition_manifest].reverse() });
  assert.equal(a.spec_digest, b.spec_digest); assert.deepEqual(a.selected_future_revisions, ['a', 'b']);
  await assert.rejects(sealCandidateSpec({ ...value, composition_manifest: [slice('a', 'unselected')] }));
});

test('execution metadata and external storage locations do not alter canonical identities', async () => {
  const candidate = { candidate_spec_id: 'spec', repo_tree_oids: { repo: 'a'.repeat(40) }, materialization_record: { executor_id: 'a', materialized_at: 'now', conflicts_encountered: [] } };
  assert.equal((await sealCandidate(candidate)).candidate_digest, (await sealCandidate({ ...candidate, materialization_record: { executor_id: 'b', materialized_at: 'later', conflicts_encountered: ['diagnostic'] } })).candidate_digest);
  const evidence = { subject_digest: sha('a'), evaluator_id: 'tests', evaluator_version: '1', config_digest: sha('b'), environment_digest: sha('c'), result: 'PASSED' as const, payload_digest: await payloadDigest(new TextEncoder().encode('log')), payload_ref: 'first', retention_class: 'EPHEMERAL' as const, created_at: 'now' };
  const a = await sealEvidence(evidence), b = await sealEvidence({ ...evidence, payload_ref: 'second', retention_class: 'CANONICAL', created_at: 'later' });
  assert.equal(a.evidence_digest, b.evidence_digest);
  assert.notEqual(a.evidence_digest, (await sealEvidence({ ...evidence, payload_digest: await payloadDigest(new TextEncoder().encode('different')) })).evidence_digest);
});

test('system state and coordination records have separate identities', async () => {
  const state = { repositories: { repo: 'a'.repeat(40) }, configuration_digests: { config: sha('b') } };
  const a = await sealSystemRevision(state, { accepted_decision_ids: ['a'], composition_manifest: [slice('a')] });
  const b = await sealSystemRevision(state, { accepted_decision_ids: ['b', 'a'], composition_manifest: [slice('a')] });
  assert.equal(a.state_digest, b.state_digest); assert.notEqual(a.record_digest, b.record_digest);
  const basis = { candidate_digests: [sha('b'), sha('a')], evidence_digests: [sha('c')], material_effect_digest: sha('d'), policy_digest: sha('e'), canonical_ref_oids: { repo: 'a'.repeat(40) }, required_analysis_status: { typescript: 'PARTIAL' as const } };
  assert.equal((await sealDecisionBasis(basis)).basis_digest, (await sealDecisionBasis({ ...basis, candidate_digests: [...basis.candidate_digests].reverse() })).basis_digest);
});

test('typed constraint ordering and attestation storage metadata are stable', async () => {
  const resource = (id: string) => ({ repo_id: 'repo', resource_type: 'service' as const, resource_id: id });
  const value = { system_revision_state_digest: sha('a'), ordering_constraints: [{ before: resource('z'), after: resource('b') }, { before: resource('a'), after: resource('b') }], compatibility_requirements: [], preconditions: [], postconditions: [], forward_only_operations: [] };
  assert.equal((await sealReleaseConstraints(value)).constraints_digest, (await sealReleaseConstraints({ ...value, ordering_constraints: [...value.ordering_constraints].reverse() })).constraints_digest);
  const attestation = { system_revision_state_digest: sha('a'), environment: 'staging', deployer_identity: 'cd', observed_state: 'UNKNOWN' as const, observed_repositories: { repo: 'a'.repeat(40) }, observed_configuration_digests: {}, payload_digest: sha('b'), attestation_payload_ref: 'first', verified_at: 'now' };
  assert.equal((await sealDeploymentAttestation(attestation)).attestation_digest, (await sealDeploymentAttestation({ ...attestation, attestation_payload_ref: 'second', verified_at: 'later' })).attestation_digest);
});

test('NFC normalization cannot silently collapse distinct dictionary keys', async () => {
  assert.deepEqual(canonicalEncode('café'), canonicalEncode('cafe\u0301'));
  assert.throws(() => canonicalEncode({ café: 1, ['cafe\u0301']: 2 }), /collision/);
  assert.notEqual(await payloadDigest(new TextEncoder().encode('café')), await payloadDigest(new TextEncoder().encode('cafe\u0301')));
});

test('unsupported values, cycles and accessors are rejected', () => {
  for (const value of [1.5, Infinity, NaN, -0, '\ud800']) assert.throws(() => canonicalEncode(value));
  const cycle: Record<string, CanonicalValue> = {}; cycle.self = cycle; assert.throws(() => canonicalEncode(cycle));
  const accessors = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => canonicalEncode(accessors), /Accessor/);
});
