import assert from 'node:assert/strict';

/** Shared behavioral contract; adapters supply repositories, not filesystem layouts. */
export async function gitStoreContract(fixture) {
  const { store, repo_id, ref, initial, next, external, advance } = fixture;
  assert.equal(await store.observe_ref(repo_id, ref), initial.commit_oid);
  const tree = await store.read_tree(initial.tree_oid);
  assert.equal(tree.tree_oid, initial.tree_oid);
  assert.ok(Object.isFrozen(tree.entries));
  const source = await store.fetch(
    { schema_version: 1, repo_id, commit_oid: initial.commit_oid },
    {},
  );
  assert.deepEqual(source.identity, initial);
  assert.equal(
    await store.compare_and_swap_ref(ref, initial.commit_oid, next.commit_oid, {
      idempotency_key: 'first-promotion',
    }),
    true,
  );
  assert.equal(await store.observe_ref(repo_id, ref), next.commit_oid);
  await advance(external.commit_oid);
  assert.equal(
    await store.compare_and_swap_ref(ref, next.commit_oid, initial.commit_oid, {
      idempotency_key: 'raced-promotion',
    }),
    false,
  );
  assert.equal(await store.observe_ref(repo_id, ref), external.commit_oid);
  await assert.rejects(store.observe_ref(repo_id + '-other', ref), { code: 'FORBIDDEN' });
  await assert.rejects(store.observe_ref(repo_id, '--upload-pack=arbitrary'), {
    code: 'INVALID_ARGUMENT',
  });
  await assert.rejects(
    store.compare_and_swap_ref(ref, initial.commit_oid.slice(0, 7), next.commit_oid, {
      idempotency_key: 'invalid',
    }),
    { code: 'INVALID_ARGUMENT' },
  );
  await assert.rejects(
    store.fetch({ schema_version: 1, repo_id: 'other', commit_oid: initial.commit_oid }, {}),
    { code: 'FORBIDDEN' },
  );
}
