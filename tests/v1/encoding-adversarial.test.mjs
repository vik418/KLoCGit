import test from 'node:test';
import assert from 'node:assert/strict';
import { decode } from 'cbor2';
import {
  digestCanonical,
  encodeCanonical,
  materialEffectDigest,
  normalizeEffectSet,
} from '../../core/v1/encoding.mjs';

function effects(effect) {
  return {
    schema_version: 1,
    future_revision_id: 'klocgit:future-revision:v1:sha256:' + '1'.repeat(64),
    extractor_id: 'git.path',
    extractor_version: '1.0.0',
    capability: 'PATH',
    status: 'COMPLETE',
    effects: [
      {
        schema_version: 1,
        kind: 'path',
        target: 'src/retry.js',
        operation: 'modify',
        attributes: {},
        references: [],
        ...effect,
      },
    ],
    security_effects: [],
    digest: 'sha256:effect-set:v1:' + '2'.repeat(64),
  };
}

test('encoder-like and prototype keys remain data rather than changing CBOR dispatch', async () => {
  const input = JSON.parse(
    '{"constructor":null,"__proto__":{"polluted":true},"toCBOR":"source","toJSON":0}',
  );
  const encoded = encodeCanonical(input);
  const decoded = decode(encoded, { preferMap: true });
  assert.equal(decoded.get('constructor'), null);
  assert.equal(decoded.get('toCBOR'), 'source');
  assert.equal(decoded.get('toJSON'), 0);
  assert.equal(decoded.get('__proto__').get('polluted'), true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(encodeCanonical(Object.assign(Object.create(null), input)), encoded);
  assert.notEqual(
    await digestCanonical('payload', input),
    await digestCanonical('payload', { ...input, toCBOR: 'different source' }),
  );
});

test('producer accessors and encoder hooks are rejected without execution', () => {
  let calls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      calls += 1;
      return 'producer value';
    },
  });
  const hooks = {
    toCBOR() {
      calls += 1;
      return [null, 'replacement'];
    },
    toJSON() {
      calls += 1;
      return 'replacement';
    },
  };
  for (const input of [accessor, hooks, { nested: accessor }, effects({ attributes: hooks })]) {
    assert.throws(() => encodeCanonical(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(calls, 0);
});

test('only the declared annotations container is non-material', async () => {
  const input = effects({
    attributes: { trace_id: 'behavioral value', annotations: { order: ['a', 'b'] } },
    annotations: { trace_id: 'trace-a' },
  });
  const initial = await materialEffectDigest(input);
  const changed = structuredClone(input);
  changed.effects[0].annotations.trace_id = 'trace-b';
  assert.equal(await materialEffectDigest(changed), initial);
  changed.effects[0].attributes.trace_id = 'changed behavioral value';
  assert.notEqual(await materialEffectDigest(changed), initial);
  changed.effects[0].attributes.trace_id = 'behavioral value';
  changed.effects[0].attributes.annotations.order.reverse();
  assert.notEqual(await materialEffectDigest(changed), initial);

  // Otherwise two producer records could collide and silently select annotations.
  const duplicate = structuredClone(input);
  duplicate.effects.push({ ...duplicate.effects[0], annotations: { trace_id: 'trace-b' } });
  assert.throws(() => normalizeEffectSet(duplicate), { code: 'INVALID_ARGUMENT' });
});
