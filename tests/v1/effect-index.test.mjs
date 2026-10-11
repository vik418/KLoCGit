import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEffectSet } from '../../core/v1/extractors.mjs';
import { indexEffects, securityOverride } from '../../core/v1/effect-index.mjs';

const id = (number) => 'klocgit:future-revision:v1:sha256:' + number.toString(16).padStart(64, '0');
const effect = (target, role = null) => ({
  schema_version: 1,
  kind: role ? 'security-surface' : 'path',
  target,
  operation: 'modified',
  attributes: role ? { role, basis: 'INFERRED' } : { basis: 'OBSERVED' },
  references: [],
});
const record = (number, effects, security_effects = [], status = 'COMPLETE') =>
  buildEffectSet({
    schema_version: 1,
    future_revision_id: id(number),
    extractor_id: 'paths',
    extractor_version: '1',
    capability: 'PATH',
    status,
    effects,
    security_effects,
  });

test('every protected security surface bypasses non-critical hub suppression', async () => {
  const roles = ['dependency', 'build', 'ci', 'auth', 'iam', 'schema', 'migration', 'secret'];
  const security = roles.map((role) => effect(role + '/shared', role));
  const inputs = await Promise.all(
    [1, 2, 3].map((number) => record(number, [effect('shared-docs'), ...security], security)),
  );
  const targets = Object.fromEntries(inputs.map((entry) => [entry.future_revision_id, 'repo']));
  const index = await indexEffects(inputs, targets, { schema_version: 1, hub_min_degree: 2 });
  assert.equal(index.interactions.length, roles.length);
  assert.ok(index.interactions.every(({ security_sensitive }) => security_sensitive));
  assert.deepEqual(
    index.suppressed.map(({ target }) => target),
    ['shared-docs'],
  );
  assert.deepEqual((await securityOverride(inputs)).protected_revision_ids, [id(1), id(2), id(3)]);
});

test('a dense shared target remains one hyperedge without pairwise expansion', async () => {
  const count = 1000;
  const inputs = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      record(index + 1, [effect('common'), effect('secure', 'auth')], [effect('secure', 'auth')]),
    ),
  );
  const targets = Object.fromEntries(inputs.map((entry) => [entry.future_revision_id, 'repo']));
  const index = await indexEffects(inputs, targets, { schema_version: 1, hub_min_degree: 10 });
  assert.equal(index.interactions.length, 1);
  assert.equal(index.interactions[0].member_revision_ids.length, count);
  assert.equal(index.suppressed.length, 1);
  assert.equal(index.metrics.pairwise_expansions, 0);
  assert.equal(index.metrics.memberships, count * 2);
  assert.equal(index.metrics.pairwise_comparisons_avoided, count * (count - 1));
});

test('scope separation, ordering and incomplete capability remain explicit', async () => {
  const inputs = await Promise.all([
    record(1, [effect('same')]),
    record(2, [effect('same')], [], 'PARTIAL'),
    record(3, [effect('same')]),
  ]);
  const targets = { [id(1)]: 'one', [id(2)]: 'one', [id(3)]: 'two' };
  const options = { schema_version: 1, hub_min_degree: 3 };
  const index = await indexEffects(inputs, targets, options);
  assert.deepEqual(index, await indexEffects([...inputs].reverse(), targets, options));
  assert.deepEqual(index.interactions[0].member_revision_ids, [id(1), id(2)]);
  assert.deepEqual(index.incomplete_revision_ids, [id(2)]);
  assert.equal((await securityOverride(inputs)).protected_revision_ids.length, 0);
});

test('substituted effect bodies and ambiguous extractor versions cannot enter the index', async () => {
  const input = await record(1, [effect('one')]);
  const targets = { [id(1)]: 'repo' },
    options = { schema_version: 1, hub_min_degree: 2 };
  await assert.rejects(
    indexEffects([{ ...input, security_effects: [effect('auth', 'auth')] }], targets, options),
    { code: 'INTEGRITY_MISMATCH' },
  );
  await assert.rejects(indexEffects([input, input], targets, options), {
    code: 'INVALID_ARGUMENT',
  });
});
