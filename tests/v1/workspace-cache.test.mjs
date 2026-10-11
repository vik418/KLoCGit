import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedWorkspaceCache } from '../../core/v1/workspace-cache.mjs';

const policy = Object.freeze({ schema_version: 1, max_entries: 2, max_bytes: 5, ttl_ms: 100 });

test('entry and byte bounds evict least-recently-used objects without exposing mutable buffers', async () => {
  const cache = new BoundedWorkspaceCache({ policy });
  const bytes = new Uint8Array([1, 2]);
  await cache.put('a', bytes);
  bytes[0] = 9;
  await cache.put('b', new Uint8Array([3, 4]));
  const first = await cache.get('a');
  assert.equal(first[0], 1);
  first[0] = 8;
  await cache.put('c', new Uint8Array([5, 6, 7]));
  assert.equal(await cache.get('b'), null);
  assert.equal((await cache.get('a'))[0], 1);
  assert.equal(cache.stats().payload_bytes, 5);
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.stats().retention_class, 'REBUILDABLE');
});

test('expiration is absolute and cache loss returns a miss rather than supplying stale bytes', async () => {
  let time = 0;
  const cache = new BoundedWorkspaceCache({ policy, now: () => time });
  await cache.put('a', new Uint8Array([1]));
  time = 99;
  assert.deepEqual(await cache.get('a'), new Uint8Array([1]));
  time = 100;
  assert.equal(await cache.get('a'), null);
  assert.equal(cache.stats().expirations, 1);
  await cache.put('b', new Uint8Array([2]));
  cache.clear();
  assert.equal(await cache.get('b'), null);
  assert.equal(cache.stats().payload_bytes, 0);
});

test('oversized and disabled cache policies do not retain payloads', async () => {
  for (const disabled of [
    policy,
    { ...policy, max_bytes: 0 },
    { ...policy, max_entries: 0 },
    { ...policy, ttl_ms: 0 },
  ]) {
    const cache = new BoundedWorkspaceCache({ policy: disabled });
    await cache.put('large', new Uint8Array(6));
    assert.equal(await cache.get('large'), null);
    assert.equal(cache.stats().entries, 0);
  }
});

test('invalid policies and non-byte payloads fail explicitly', async () => {
  for (const invalid of [
    { ...policy, ttl_ms: -1 },
    { ...policy, max_bytes: Infinity },
    { ...policy, extra: true },
  ])
    assert.throws(() => new BoundedWorkspaceCache({ policy: invalid }), {
      code: 'INVALID_ARGUMENT',
    });
  const cache = new BoundedWorkspaceCache({ policy });
  await assert.rejects(cache.put('a', 'unverified text'), { code: 'INVALID_ARGUMENT' });
});
