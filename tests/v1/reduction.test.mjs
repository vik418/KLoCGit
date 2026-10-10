import assert from 'node:assert/strict';
import test from 'node:test';
import { FutureRevision } from '../../core/v1/domain.mjs';
import {
  reduceExactImplementations,
  buildCandidateSpec,
  verifyCandidateSpec,
  wholeFutureSelection,
} from '../../core/v1/reduction.mjs';

function revision(
  number,
  { tree = number, repo = 'producer-' + number, ref = 'refs/heads/main' } = {},
) {
  return FutureRevision({
    schema_version: 1,
    id: 'klocgit:future-revision:v1:sha256:' + number.toString(16).padStart(64, '0'),
    system_id: 'group',
    repo_id: repo,
    ref,
    commit_oid: number.toString(16).padStart(40, '0'),
    tree_oid: tree.toString(16).padStart(40, '0'),
    parent_oids: [],
    producer: null,
    observed_at: '2026-10-10T00:00:00Z',
  });
}

function options(revisions, overrides = {}) {
  return {
    bindings: Object.fromEntries(
      revisions.map(({ id }) => [
        id,
        {
          schema_version: 1,
          repo_id: 'canonical',
          base_commit_oid: 'a'.repeat(40),
          base_tree_oid: 'b'.repeat(40),
        },
      ]),
    ),
    supersession: [],
    ...overrides,
  };
}

test('tree-identical implementations share work while retaining all origins', () => {
  const inputs = [revision(1), revision(2, { tree: 1 }), revision(3)];
  const result = reduceExactImplementations(inputs, options(inputs));
  assert.equal(result.implementations.length, 2);
  assert.deepEqual(result.implementations[0].future_revision_ids, [inputs[0].id, inputs[1].id]);
  assert.deepEqual(result, reduceExactImplementations([...inputs].reverse(), options(inputs)));
  assert.equal(inputs.length, 3);
  assert.ok(Object.isFrozen(result.implementations[0].future_revision_ids));
});

test('equal effects cannot erase materially distinct trees or separate targets/bases', () => {
  const inputs = [revision(1), revision(2), revision(3, { tree: 1 }), revision(4, { tree: 1 })];
  const config = options(inputs);
  config.bindings[inputs[2].id].repo_id = 'other-canonical';
  config.bindings[inputs[3].id].base_commit_oid = 'c'.repeat(40);
  assert.equal(reduceExactImplementations(inputs, config).implementations.length, 4);
});

test('explicit supersession removes old alternatives without deleting revision history', () => {
  const inputs = [
    revision(1, { repo: 'future' }),
    revision(2, { repo: 'future' }),
    revision(3, { repo: 'future' }),
  ];
  const edges = inputs.slice(0, 2).map((before, index) => ({
    schema_version: 1,
    from_revision: before.id,
    to_revision: inputs[index + 1].id,
  }));
  const result = reduceExactImplementations(inputs, options(inputs, { supersession: edges }));
  assert.deepEqual(
    result.implementations.map(({ representative_revision_id }) => representative_revision_id),
    [inputs[2].id],
  );
  assert.deepEqual(result.superseded, edges);
  assert.equal(reduceExactImplementations(inputs, options(inputs)).implementations.length, 3);
});

test('supersession cannot cross futures or create cycles', () => {
  for (const inputs of [
    [revision(1), revision(2)],
    [revision(1, { repo: 'future' }), revision(2, { repo: 'future' })],
  ]) {
    const edge = { schema_version: 1, from_revision: inputs[0].id, to_revision: inputs[1].id };
    const supersession =
      inputs[0].repo_id === inputs[1].repo_id
        ? [edge, { ...edge, from_revision: edge.to_revision, to_revision: edge.from_revision }]
        : [edge];
    assert.throws(() => reduceExactImplementations(inputs, options(inputs, { supersession })), {
      code: 'INVALID_ARGUMENT',
    });
  }
});

test('CandidateSpec identity is order-independent for sets and preserves selection order', async () => {
  const inputs = [revision(1), revision(2)];
  const config = options(inputs);
  const body = {
    schema_version: 1,
    base_revision: 'klocgit:system-revision:v1:sha256:' + 'a'.repeat(64),
    selected_future_revisions: inputs.map(({ id }) => id),
    selections: inputs.map((input) => wholeFutureSelection(input, config.bindings[input.id])),
    required_dependencies: [],
    effect_summary_digest: 'sha256:material-effect:v1:' + 'a'.repeat(64),
    creation_reason: 'Independent implementations',
  };
  const spec = await buildCandidateSpec(body);
  assert.deepEqual(await verifyCandidateSpec(spec), spec);
  assert.equal(
    (
      await buildCandidateSpec({
        ...body,
        selected_future_revisions: [...body.selected_future_revisions].reverse(),
      })
    ).id,
    spec.id,
  );
  assert.notEqual(
    (await buildCandidateSpec({ ...body, selections: [...body.selections].reverse() })).id,
    spec.id,
  );
  await assert.rejects(verifyCandidateSpec({ ...spec, creation_reason: 'Substituted plan' }), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('missing bindings and duplicate revisions are rejected before reduction', () => {
  const input = revision(1);
  assert.throws(() => reduceExactImplementations([input], { bindings: {}, supersession: [] }), {
    code: 'INVALID_ARGUMENT',
  });
  assert.throws(() => reduceExactImplementations([input, input], options([input])), {
    code: 'INVALID_ARGUMENT',
  });
});
