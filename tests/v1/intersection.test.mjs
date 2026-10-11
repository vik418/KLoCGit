import assert from 'node:assert/strict';
import test from 'node:test';
import { ConservativeIntersection } from '../../core/v1/intersection.mjs';
import { Extractor, buildEffectSet } from '../../core/v1/extractors.mjs';
import { TypeScriptSemanticPlugin } from '../../adapters/analysis/typescript.mjs';
import { objectId } from '../../core/v1/conventions.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';

async function fixture(changes = {}) {
  const baseFiles = { 'left.ts': 'export const left = 1;', 'right.ts': 'export const right = 1;' };
  const subjects = [];
  for (const index of [0, 1, 2])
    subjects.push({
      schema_version: 1,
      id: objectId('future-revision', await digestCanonical('object-future-revision', { index })),
      system_id: 'group',
      repo_id: 'repo',
      ref: 'refs/heads/main',
      commit_oid: (index + 1).toString().repeat(40),
      tree_oid: (index + 1).toString().repeat(40),
      parent_oids: [],
      producer: null,
      observed_at: '2026-10-11T00:00:00Z',
    });
  const projects = new Map(
    subjects.map((subject, index) => [
      subject.id,
      {
        schema_version: 1,
        repo_id: subject.repo_id,
        commit_oid: subject.commit_oid,
        tree_oid: subject.tree_oid,
        complete: true,
        files: Object.entries({
          ...baseFiles,
          ...(index === 1
            ? { 'left.ts': 'export const left = 2;', ...changes.left }
            : index === 2
              ? { 'right.ts': 'export const right = 2;', ...changes.right }
              : changes.base),
        }).map(([path, contents]) => ({ path, contents })),
      },
    ]),
  );
  const extractor = new Extractor({
    plugin: new TypeScriptSemanticPlugin({ loadProject: (subject) => projects.get(subject.id) }),
    language: 'typescript',
    toolchain_version: '6.0.3',
  });
  const path = (revision, target) =>
    buildEffectSet({
      schema_version: 1,
      future_revision_id: revision.id,
      extractor_id: 'paths',
      extractor_version: '1',
      capability: 'PATH',
      status: 'COMPLETE',
      effects: [
        {
          schema_version: 1,
          kind: 'git-path',
          target,
          operation: 'modified',
          attributes: { basis: 'OBSERVED' },
          references: [],
        },
      ],
      security_effects: [],
    });
  const input = {
    schema_version: 1,
    proposed_effects: [
      await path(subjects[1], 'left.ts'),
      await extractor.analyze(subjects[0], subjects[1]),
    ],
    intervening_effects: [
      await path(subjects[2], 'right.ts'),
      await extractor.analyze(subjects[0], subjects[2]),
    ],
    targets: Object.fromEntries(subjects.map((subject) => [subject.id, subject.repo_id])),
  };
  const options = {
    policyEvaluator: {
      required_analysis: (_subject, effects) =>
        effects.map((set) => set.future_revision_id + '/' + set.extractor_id),
    },
    max_effect_sets: 20,
    max_targets: 1000,
  };
  return { input, options };
}

test('independent compiler-observed changes are disjoint within their declared static scope', async () => {
  const f = await fixture();
  const result = await new ConservativeIntersection(f.options).compare(f.input);
  assert.equal(result.classification, 'DISJOINT');
  assert.deepEqual(result.reasons, []);
  assert.ok(result.claims[0].includes('does not establish runtime compatibility'));
});

test('compiler-resolved dependency changes intersect even when changed paths differ', async () => {
  const f = await fixture({
    base: { 'left.ts': "import { right } from './right.js'; export const left = right + 1;" },
    left: { 'left.ts': "import { right } from './right.js'; export const left = right + 2;" },
  });
  const result = await new ConservativeIntersection(f.options).compare(f.input);
  assert.equal(result.classification, 'POSSIBLE_INTERACTION');
  assert.ok(result.reasons.includes('SHARED_EFFECT_OR_REFERENCE'));
});

test('every incomplete language capability and missing semantic coverage stays uncertain', async () => {
  for (const status of ['PARTIAL', 'FAILED', 'UNSUPPORTED']) {
    const f = await fixture();
    const { digest, ...set } = f.input.proposed_effects[1];
    assert.ok(digest);
    f.input.proposed_effects[1] = await buildEffectSet({ ...set, status });
    assert.equal(
      (await new ConservativeIntersection(f.options).compare(f.input)).classification,
      'POSSIBLE_INTERACTION',
    );
  }
  const f = await fixture();
  f.input.proposed_effects.pop();
  assert.ok(
    (await new ConservativeIntersection(f.options).compare(f.input)).reasons.includes(
      'MISSING_CAPABILITY',
    ),
  );
});

test('security hints, changed analysis scope and exhausted budgets cannot establish disjointness', async () => {
  const f = await fixture();
  const { digest, ...set } = f.input.proposed_effects[0];
  assert.ok(digest);
  f.input.proposed_effects[0] = await buildEffectSet({
    ...set,
    security_effects: [
      {
        ...set.effects[0],
        kind: 'security-surface',
        attributes: { basis: 'INFERRED', role: 'auth' },
      },
    ],
  });
  assert.ok(
    (await new ConservativeIntersection(f.options).compare(f.input)).reasons.includes(
      'SECURITY_SENSITIVE_CHANGE',
    ),
  );
  f.options.max_targets = 1;
  assert.ok(
    (await new ConservativeIntersection(f.options).compare(f.input)).reasons.includes(
      'BUDGET_EXHAUSTED',
    ),
  );
});

test('unobserved cross-repo dependency scope and substituted effects remain unsafe', async () => {
  const f = await fixture();
  const id = f.input.intervening_effects[0].future_revision_id;
  f.input.targets[id] = 'another-repo';
  assert.ok(
    (await new ConservativeIntersection(f.options).compare(f.input)).reasons.includes(
      'CROSS_REPOSITORY_UNCERTAINTY',
    ),
  );
  f.input.proposed_effects[0] = { ...f.input.proposed_effects[0], effects: [] };
  await assert.rejects(new ConservativeIntersection(f.options).compare(f.input), {
    code: 'INTEGRITY_MISMATCH',
  });
});
