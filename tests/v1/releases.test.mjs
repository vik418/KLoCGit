import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSystemRevision,
  verifySystemRevision,
  buildReleaseConstraints,
  verifyReleaseConstraints,
} from '../../core/v1/releases.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { objectId } from '../../core/v1/conventions.mjs';

async function fixture() {
  const decisions = await Promise.all(
    ['first', 'second'].map(async (name) =>
      objectId('decision', await digestCanonical('object-decision', { name })),
    ),
  );
  const body = {
    schema_version: 1,
    repositories: { api: 'a'.repeat(40), web: 'b'.repeat(40) },
    configuration_digests: { policy: await digestCanonical('policy', { version: 1 }) },
    accepted_decisions: decisions,
  };
  const revision = await buildSystemRevision(body);
  const constraints = {
    schema_version: 1,
    system_revision_digest: revision.digest,
    ordering_constraints: [{ schema_version: 1, before: 'api', after: 'web' }],
    compatibility_requirements: [{ schema_version: 1, contract: 'api-v2', consumers: ['web'] }],
    preconditions: [
      { schema_version: 1, condition: 'database-backup', evidence_ref: 'backup:verified' },
    ],
    postconditions: [
      { schema_version: 1, condition: 'health', observation: 'registered-http-check' },
    ],
    forward_only_operations: [
      { schema_version: 1, operation: 'schema-migration', id: 'schema-v2' },
    ],
  };
  return { body, revision, constraints };
}

test('accepted multi-repository states have deterministic identities and immutable exact OIDs', async () => {
  const f = await fixture();
  const reordered = await buildSystemRevision({
    ...f.body,
    repositories: { web: f.body.repositories.web, api: f.body.repositories.api },
    accepted_decisions: [...f.body.accepted_decisions].reverse(),
  });
  assert.deepEqual(reordered, f.revision);
  assert.deepEqual(await verifySystemRevision(f.revision), f.revision);
  f.body.repositories.api = 'c'.repeat(40);
  assert.equal(f.revision.repositories.api, 'a'.repeat(40));
  assert.notEqual((await buildSystemRevision(f.body)).digest, f.revision.digest);
});

test('branches, abbreviated OIDs, duplicate decisions and extra state fields are rejected', async () => {
  const f = await fixture();
  for (const repositories of [
    { api: 'main' },
    { api: 'a'.repeat(7) },
    { api: 'a'.repeat(40), web: 'not-an-oid' },
  ])
    await assert.rejects(buildSystemRevision({ ...f.body, repositories }), {
      code: 'INVALID_ARGUMENT',
    });
  await assert.rejects(
    buildSystemRevision({
      ...f.body,
      accepted_decisions: [f.body.accepted_decisions[0], f.body.accepted_decisions[0]],
    }),
    { code: 'INVALID_ARGUMENT' },
  );
  await assert.rejects(buildSystemRevision({ ...f.body, branch: 'main' }), {
    code: 'INVALID_ARGUMENT',
  });
});

test('copied accepted-state identities cannot conceal changed repository state', async () => {
  const f = await fixture();
  await assert.rejects(
    verifySystemRevision({
      ...f.revision,
      repositories: { ...f.revision.repositories, api: 'c'.repeat(40) },
    }),
    { code: 'INTEGRITY_MISMATCH' },
  );
});

test('release constraints retain provider-neutral semantics and declared sequence order', async () => {
  const f = await fixture();
  const constraints = await buildReleaseConstraints(f.constraints);
  assert.deepEqual(await verifyReleaseConstraints(constraints, f.revision), constraints);
  for (const field of [
    'ordering_constraints',
    'compatibility_requirements',
    'preconditions',
    'postconditions',
    'forward_only_operations',
  ])
    assert.deepEqual(constraints[field], f.constraints[field]);
  const sequence = [
    f.constraints.ordering_constraints[0],
    { schema_version: 1, before: 'web', after: 'metrics' },
  ];
  assert.notEqual(
    (await buildReleaseConstraints({ ...f.constraints, ordering_constraints: sequence })).digest,
    (
      await buildReleaseConstraints({
        ...f.constraints,
        ordering_constraints: [...sequence].reverse(),
      })
    ).digest,
  );
});

test('a release contract cannot be substituted or bound to another accepted system state', async () => {
  const f = await fixture();
  const constraints = await buildReleaseConstraints(f.constraints);
  await assert.rejects(
    verifyReleaseConstraints({ ...constraints, forward_only_operations: [] }, f.revision),
    { code: 'INTEGRITY_MISMATCH' },
  );
  const other = await buildSystemRevision({
    ...f.body,
    repositories: { ...f.body.repositories, api: 'd'.repeat(40) },
  });
  await assert.rejects(verifyReleaseConstraints(constraints, other), {
    code: 'INTEGRITY_MISMATCH',
  });
  await assert.rejects(buildReleaseConstraints({ ...f.constraints, execute_rollback: true }), {
    code: 'INVALID_ARGUMENT',
  });
});
