import assert from 'node:assert/strict';
import test from 'node:test';
import { FutureRevision } from '../../core/v1/domain.mjs';
import {
  Extractor,
  analysisProject,
  buildEffectSet,
  verifyEffectSet,
} from '../../core/v1/extractors.mjs';
import { buildDecisionBasis, makeReviewable, makeResolvable } from '../../core/v1/decisions.mjs';

const digest = (domain) => 'sha256:' + domain + ':v1:' + 'a'.repeat(64);
const revision = (character) =>
  FutureRevision({
    schema_version: 1,
    id: 'klocgit:future-revision:v1:sha256:' + character.repeat(64),
    system_id: 'group',
    repo_id: 'repo',
    ref: 'refs/heads/main',
    commit_oid: character.repeat(40),
    tree_oid: character.repeat(40),
    parent_oids: [],
    producer: null,
    observed_at: '2026-10-10T00:00:00Z',
  });

function fixture(changes = {}, resultChanges = {}) {
  let calls = 0;
  const plugin = {
    id: 'compiler',
    version: '1.0.0',
    capability: 'SEMANTIC',
    capabilities: (language, toolchain_version) => ({
      schema_version: 1,
      language,
      toolchain_version,
      supported_versions: ['1.0.0'],
      capability: 'SEMANTIC',
      status: 'COMPLETE',
      ...changes,
    }),
    analyze: async () => {
      calls += 1;
      return {
        capability: 'SEMANTIC',
        status: 'COMPLETE',
        effects: [],
        security_effects: [],
        ...resultChanges,
      };
    },
  };
  return {
    plugin,
    calls: () => calls,
    extractor: new Extractor({ plugin, language: 'fixture-language', toolchain_version: '1.0.0' }),
  };
}

test('successful analysis binds exact revision and registered extractor identity', async () => {
  const { extractor } = fixture();
  const result = await extractor.analyze(revision('a'), revision('b'));
  assert.equal(result.future_revision_id, revision('b').id);
  assert.equal(result.extractor_id, 'compiler');
  assert.equal(result.extractor_version, '1.0.0');
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(await verifyEffectSet(result), result);
});

for (const status of ['PARTIAL', 'FAILED', 'UNSUPPORTED']) {
  test(status + ' capability cannot authorize a required semantic decision', async () => {
    const f = fixture({ status }, { status });
    const effect = await f.extractor.analyze(revision('a'), revision('b'));
    assert.equal(effect.status, status);
    if (status !== 'PARTIAL') assert.equal(f.calls(), 0);
    const basis = await buildDecisionBasis({
      schema_version: 1,
      candidate_digests: [digest('object-candidate')],
      evidence_digests: [],
      material_effect_digest: digest('material-effect'),
      policy_digest: digest('policy'),
      canonical_ref_oids: { repo: { 'refs/heads/main': 'a'.repeat(40) } },
      required_analysis_status: { compiler: effect.status },
    });
    const decision = await makeReviewable(
      {
        schema_version: 1,
        id: 'klocgit:decision:v1:sha256:' + 'a'.repeat(64),
        state: 'DISCOVERED',
        basis: null,
        resolution: null,
      },
      basis,
    );
    await assert.rejects(
      makeResolvable(decision, basis, {
        policyEvaluator: { required_analysis: () => ['compiler'], can_resolve: () => true },
        subject: {},
        effects: [effect],
      }),
      { code: 'INCOMPLETE_ANALYSIS' },
    );
  });
}

test('failures and attempted tier downgrades stay explicit analysis failures', async () => {
  for (const changes of [
    { capability: 'PATH' },
    { status: 'green' },
    { effects: [{ unversioned: true }] },
    { future_revision_id: revision('a').id },
  ]) {
    assert.equal(
      (await fixture({}, changes).extractor.analyze(revision('a'), revision('b'))).status,
      'FAILED',
    );
  }
  const f = fixture();
  f.extractor.run = async () => {
    throw new Error('private compiler diagnostic');
  };
  const result = await f.extractor.analyze(revision('a'), revision('b'));
  assert.equal(result.status, 'FAILED');
  assert.ok(!JSON.stringify(result).includes('private compiler diagnostic'));
  assert.equal(
    (await fixture({ status: 'PARTIAL' }).extractor.analyze(revision('a'), revision('b'))).status,
    'FAILED',
  );
});

test('unsupported toolchain is reported without running the plugin', async () => {
  const f = fixture({ status: 'UNSUPPORTED' });
  assert.equal((await f.extractor.analyze(revision('a'), revision('b'))).status, 'UNSUPPORTED');
  assert.equal(f.calls(), 0);
  await assert.rejects(
    fixture({ toolchain_version: 'another-version' }).extractor.capabilities(
      'fixture-language',
      '1.0.0',
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
});

test('capability discovery failure remains a failed declared tier', async () => {
  const f = fixture();
  f.extractor.describe = async () => {
    throw new Error('private capability failure');
  };
  const result = await f.extractor.analyze(revision('a'), revision('b'));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.capability, 'SEMANTIC');
  assert.equal(f.calls(), 0);
  assert.ok(!JSON.stringify(result).includes('private capability failure'));
});

test('effect identities normalize sets and reject copied digests after substitution', async () => {
  const effect = (target) => ({
    schema_version: 1,
    kind: 'path',
    target,
    operation: 'modified',
    attributes: {},
    references: [],
  });
  const input = {
    schema_version: 1,
    future_revision_id: revision('a').id,
    extractor_id: 'paths',
    extractor_version: '1',
    capability: 'PATH',
    status: 'COMPLETE',
    effects: [effect('b'), effect('a')],
    security_effects: [],
  };
  const first = await buildEffectSet(input);
  const other = await buildEffectSet({ ...input, effects: [...input.effects].reverse() });
  assert.deepEqual(first, other);
  await assert.rejects(verifyEffectSet({ ...first, status: 'PARTIAL' }), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('analysis projects bind source identity and expose hydration limits', () => {
  const subject = revision('a');
  const project = {
    schema_version: 1,
    repo_id: subject.repo_id,
    commit_oid: subject.commit_oid,
    tree_oid: subject.tree_oid,
    complete: false,
    files: [{ path: 'source.js', contents: 'export const value = 1;' }],
  };
  const accepted = analysisProject(project, subject);
  assert.equal(accepted.complete, false);
  project.files[0].contents = 'changed';
  assert.equal(accepted.files[0].contents, 'export const value = 1;');
  assert.throws(() => analysisProject({ ...project, tree_oid: 'b'.repeat(40) }, subject), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.throws(
    () => analysisProject({ ...project, files: [...project.files, ...project.files] }, subject),
    { code: 'INVALID_ARGUMENT' },
  );
  assert.throws(
    () =>
      analysisProject({ ...project, files: [{ path: '../outside.js', contents: '' }] }, subject),
    { code: 'INVALID_ARGUMENT' },
  );
});
