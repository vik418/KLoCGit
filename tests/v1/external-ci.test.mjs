import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { LocalWorkspaceSource } from '../../adapters/local/workspace-source.mjs';
import {
  ExternalCIReceiptAdapter,
  ciReceiptSigningBytes,
} from '../../adapters/ci/signed-evidence.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { EvidenceProvider, evidenceEligibility } from '../../core/v1/evidence.mjs';
import { materializedCandidate } from '../../core/v1/materialization.mjs';

function encode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-external-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitAdapter = new LocalGit(root);
  const repository = { id: 'source', canonical_ref: 'refs/heads/main' };
  const directory = gitAdapter.dir(repository);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--bare', '--quiet']);
  async function commit(files, parent = null) {
    const entries = [];
    for (const [path, contents] of Object.entries(files)) {
      const oid = await git(directory, ['hash-object', '-w', '--stdin'], contents);
      entries.push(`100644 blob ${oid}\t${path}`);
    }
    const tree = await git(directory, ['mktree'], entries.join('\n') + '\n');
    const head = await git(directory, [
      'commit-tree',
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      'CI state',
    ]);
    await git(directory, ['update-ref', repository.canonical_ref, head]);
    return {
      schema_version: 1,
      repo_id: repository.id,
      commit_oid: head,
      tree_oid: tree,
      parent_oids: parent ? [parent] : [],
    };
  }
  const snapshot = await commit({ 'a.txt': 'Future A\n', 'b.txt': 'baseline\n' });
  const source = new LocalWorkspaceSource({ adapter: gitAdapter, repository });
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const config_digest = await digestCanonical('evaluation-config', {
    trusted_recipe: 'independent-tests',
  });
  const environment_digest = await digestCanonical('evaluation-environment', { runtime: 'test' });
  const registry = {
    schema_version: 1,
    issuer: 'trusted-ci',
    key_id: 'key-1',
    public_key: encode(await crypto.subtle.exportKey('raw', keys.publicKey)),
    producer_version: '1.0',
    repository_bindings: { source: 'canonical' },
    allowed_config_digests: [config_digest],
  };
  let gitReads = 0;
  const adapter = new ExternalCIReceiptAdapter({
    tenant_id: 'tenant',
    system_id: 'group',
    resolveEvaluator: async ({ issuer, key_id }) =>
      issuer === registry.issuer && key_id === registry.key_id ? registry : null,
    observeSnapshot: async (repo_id, commit_oid) => {
      gitReads += 1;
      return (await source.fetch({ schema_version: 1, repo_id, commit_oid })).identity;
    },
    authorize: async (principal) => principal.actor_id === 'collector',
    retention_class: 'DECISION_RECORD',
    max_receipt_bytes: 16384,
  });
  const principal = { actor_id: 'collector' };
  const observation = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    run_id: 'job-1',
    type: 'tests',
    config_digest,
    environment_digest,
    result: { status: 'PASSING' },
    payload_ref: 'ci:job-1',
    created_at: '2026-10-11T00:00:00Z',
    sources: [snapshot],
  };
  async function sign(overrides = {}, key = keys.privateKey) {
    const unsigned = {
      schema_version: 1,
      issuer: registry.issuer,
      key_id: registry.key_id,
      observation: { ...observation, ...overrides },
    };
    return {
      ...unsigned,
      signature: encode(await crypto.subtle.sign('Ed25519', key, ciReceiptSigningBytes(unsigned))),
    };
  }
  const requirements = {
    schema_version: 1,
    policy_digest: await digestCanonical('policy', { required: ['tests'] }),
    checks: [
      {
        schema_version: 1,
        id: 'tests',
        type: 'tests',
        config_digest,
        environment_digest,
        producers: [
          { schema_version: 1, identity: registry.issuer, versions: [registry.producer_version] },
        ],
      },
    ],
  };
  return {
    directory,
    repository,
    source,
    snapshot,
    keys,
    registry,
    adapter,
    principal,
    observation,
    sign,
    commit,
    requirements,
    gitReads: () => gitReads,
  };
}

test('registered CI observations are reusable for an exact isolated state and remain idempotent', async (t) => {
  const f = await fixture(t);
  const receipt = await f.sign();
  const imported = await f.adapter.ingest(receipt, { principal: f.principal });
  assert.deepEqual(await f.adapter.ingest(receipt, { principal: f.principal }), imported);
  assert.equal(imported.evidence.producer_identity, f.registry.issuer);
  assert.equal(imported.evidence.retention_class, 'DECISION_RECORD');
  const options = {
    verifyProvenance: (record) =>
      f.adapter.verifyProvenance(record, receipt, { principal: f.principal }),
    policyEvaluator: { can_reuse: async (record) => record.result.status === 'PASSING' },
  };
  const facade = new EvidenceProvider({
    provider: { find_reusable: async () => [imported.evidence], evaluate: async () => [] },
    ...options,
    max_records: 10,
  });
  const report = await evidenceEligibility(
    imported.evidence,
    imported.evidence.subject_digest,
    f.requirements,
    options,
  );
  assert.deepEqual(report.eligible_for, ['tests']);
  const candidate = await materializedCandidate(
    'klocgit:candidate-spec:v1:sha256:' + 'a'.repeat(64),
    { canonical: f.snapshot.tree_oid },
    { schema_version: 1, repo_commit_oids: { canonical: f.snapshot.commit_oid } },
  );
  assert.deepEqual(await facade.find_reusable(imported.evidence.subject_digest, f.requirements), [
    imported.evidence,
  ]);
  assert.equal(candidate.repo_tree_oids.canonical, f.snapshot.tree_oid);
});

test('Future A CI cannot validate a novel composed Candidate A+B', async (t) => {
  const f = await fixture(t);
  const receipt = await f.sign();
  const { evidence } = await f.adapter.ingest(receipt, { principal: f.principal });
  const composition = await f.commit(
    { 'a.txt': 'Future A\n', 'b.txt': 'Future B\n' },
    f.snapshot.commit_oid,
  );
  const candidate = await materializedCandidate(
    'klocgit:candidate-spec:v1:sha256:' + 'b'.repeat(64),
    { canonical: composition.tree_oid },
    { schema_version: 1, repo_commit_oids: { canonical: composition.commit_oid } },
  );
  const facade = new EvidenceProvider({
    provider: { find_reusable: async () => [evidence], evaluate: async () => [evidence] },
    verifyProvenance: (record) =>
      f.adapter.verifyProvenance(record, receipt, { principal: f.principal }),
    policyEvaluator: { can_reuse: async () => true },
    max_records: 10,
  });
  await assert.rejects(facade.evaluate(candidate, f.requirements), { code: 'POLICY_REJECTED' });
  assert.equal(
    await git(f.directory, ['rev-parse', f.repository.canonical_ref]),
    composition.commit_oid,
  );
});

test('forged signatures, substituted results and retired evaluator keys fail before Git access', async (t) => {
  const f = await fixture(t);
  const receipt = await f.sign();
  await assert.rejects(
    f.adapter.ingest(
      { ...receipt, observation: { ...receipt.observation, result: { status: 'FAKE' } } },
      { principal: f.principal },
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
  const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  await assert.rejects(
    f.adapter.ingest(await f.sign({}, other.privateKey), { principal: f.principal }),
    { code: 'INTEGRITY_MISMATCH' },
  );
  await assert.rejects(
    f.adapter.ingest({ ...receipt, key_id: 'retired' }, { principal: f.principal }),
    { code: 'FORBIDDEN' },
  );
  assert.equal(f.gitReads(), 0);
});

test('a signed receipt with false Git facts is rejected after rereading exact Git state', async (t) => {
  const f = await fixture(t);
  const wrong = await f.commit({ 'a.txt': 'different\n' });
  const receipt = await f.sign({ sources: [{ ...f.snapshot, tree_oid: wrong.tree_oid }] });
  await assert.rejects(f.adapter.ingest(receipt, { principal: f.principal }), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.equal(f.gitReads(), 1);
});

test('tenant, actor, repository and trusted-recipe grants are enforced independently of signatures', async (t) => {
  const f = await fixture(t);
  const receipt = await f.sign();
  await assert.rejects(f.adapter.ingest(receipt), { code: 'UNAUTHENTICATED' });
  await assert.rejects(f.adapter.ingest(receipt, { principal: { actor_id: 'producer' } }), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    f.adapter.ingest(await f.sign({ tenant_id: 'other-tenant' }), { principal: f.principal }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    f.adapter.ingest(await f.sign({ sources: [{ ...f.snapshot, repo_id: 'other' }] }), {
      principal: f.principal,
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    f.adapter.ingest(
      await f.sign({
        config_digest: await digestCanonical('evaluation-config', { producer_tests: true }),
      }),
      { principal: f.principal },
    ),
    { code: 'POLICY_REJECTED' },
  );
  assert.equal(f.gitReads(), 0);
});

test('failed and cancelled CI observations retain history without becoming passing Evidence', async (t) => {
  const f = await fixture(t);
  for (const status of ['FAILED', 'CANCELLED', 'PENDING']) {
    const receipt = await f.sign({ result: { status } });
    const { evidence } = await f.adapter.ingest(receipt, { principal: f.principal });
    assert.equal(evidence.result.status, status);
    const report = await evidenceEligibility(evidence, evidence.subject_digest, f.requirements, {
      verifyProvenance: (record) =>
        f.adapter.verifyProvenance(record, receipt, { principal: f.principal }),
      policyEvaluator: { can_reuse: async (record) => record.result.status === 'PASSING' },
    });
    assert.deepEqual(report.eligible_for, []);
  }
});

test('stale environment and changed receipt identity cannot float onto previous Evidence', async (t) => {
  const f = await fixture(t);
  const receipt = await f.sign();
  const { evidence } = await f.adapter.ingest(receipt, { principal: f.principal });
  const later = await f.sign({
    environment_digest: await digestCanonical('evaluation-environment', { runtime: 'changed' }),
  });
  assert.equal(
    await f.adapter.verifyProvenance(evidence, later, { principal: f.principal }),
    false,
  );
  const next = await f.commit({ 'a.txt': 'moved ref\n' }, f.snapshot.commit_oid);
  assert.equal(
    (await f.adapter.ingest(receipt, { principal: f.principal })).evidence.id,
    evidence.id,
  );
  assert.equal(await git(f.directory, ['rev-parse', f.repository.canonical_ref]), next.commit_oid);
});
