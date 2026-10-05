import test from 'node:test';
import assert from 'node:assert/strict';
import { handleNativeRequest, ownsNativePath } from '../server/native-api.mjs';

function request(engine, path, method = 'GET', input = {}, actor = 'owner') {
  return handleNativeRequest(engine, {
    method,
    url: new URL(path, 'http://localhost'),
    input,
    actor,
  });
}

test('native routes require identity before service reads and leave compatibility routes to their dispatcher', async () => {
  let reads = 0;
  const engine = {
    get native() {
      reads++;
      throw new Error('Unauthorized read');
    },
  };
  for (const path of [
    '/api/native-state',
    '/api/repositories',
    '/api/systems',
    '/api/objectives',
    '/api/futures',
    '/api/repository-requests/id',
  ])
    await assert.rejects(() => request(engine, path, 'GET', {}, ''), { code: 'UNAUTHENTICATED' });
  assert.equal(reads, 0);
  assert.equal(await request(engine, '/api/merge-requests', 'GET', {}, ''), null);
  assert.equal(ownsNativePath('/api/repositories/repo/policy'), false);
  assert.equal(ownsNativePath('/api/decisions/id/resolve'), false);
});

test('direct Future creation accepts ordinary Git work without requiring an Objective or producer declaration', async () => {
  const calls = [];
  const engine = {
    native: {
      async createFuture(input, actor) {
        calls.push({ input, actor });
        return { future: { id: 'future' }, revision: null };
      },
    },
  };
  const result = await request(
    engine,
    '/api/futures',
    'POST',
    {
      repository_ids: ['application'],
      request_id: 'new-future',
      actor: 'administrator',
      provenance_state: 'observed',
      trusted: true,
    },
    'authenticated-owner',
  );
  assert.equal(result.future.id, 'future');
  assert.deepEqual(calls, [
    {
      input: { repository_ids: ['application'], request_id: 'new-future' },
      actor: 'authenticated-owner',
    },
  ]);
});

test('manual observation carries the displayed Future version and cannot substitute producer-selected actor', async () => {
  const calls = [];
  const engine = {
    native: {
      async observeFuture(id, input, actor) {
        calls.push({ id, input, actor });
        return { changed: false };
      },
    },
  };
  await request(engine, '/api/futures/future/observe', 'POST', {
    expected_version: 7,
    request_id: 'observe',
    actor: 'other',
    force: true,
  });
  assert.deepEqual(calls, [
    { id: 'future', input: { expected_version: 7, request_id: 'observe' }, actor: 'owner' },
  ]);
});

test('repository creation/import and recovery use separate authenticated commands', async () => {
  const calls = [];
  const engine = {
    native: {
      async registerRepository(input, actor) {
        calls.push({ operation: 'register', input, actor });
        return { repository: { id: input.id, status: 'empty' } };
      },
      async recoverRequest(id, input, actor) {
        calls.push({ operation: 'recover', id, input, actor });
        return { repository: { id: 'repo', status: 'empty' } };
      },
    },
  };
  await request(engine, '/api/repositories', 'POST', {
    id: 'repo',
    mode: 'create',
    request_id: 'create',
    credentials: 'not-a-git-token',
  });
  await request(engine, '/api/repository-requests/prepared/recover', 'POST', {
    request_id: 'inspect',
    force: true,
    commit: 'invented',
  });
  assert.deepEqual(calls, [
    {
      operation: 'register',
      input: { id: 'repo', mode: 'create', request_id: 'create' },
      actor: 'owner',
    },
    { operation: 'recover', id: 'prepared', input: { request_id: 'inspect' }, actor: 'owner' },
  ]);
});

test('known native endpoints reject unsupported methods rather than falling through to another mutation route', async () => {
  const engine = { native: {} };
  await assert.rejects(() => request(engine, '/api/native-state', 'POST'), {
    code: 'METHOD_NOT_ALLOWED',
  });
  await assert.rejects(() => request(engine, '/api/futures/id/observe', 'GET'), {
    code: 'METHOD_NOT_ALLOWED',
  });
  await assert.rejects(() => request(engine, '/api/objectives', 'POST', []), {
    code: 'INVALID_REQUEST',
  });
  await assert.rejects(() => request(engine, '/api/futures/id/unknown', 'POST'), {
    code: 'NOT_FOUND',
  });
});

test('read projections expose immutable revision history while request inspection omits original payload and duplicate result', async () => {
  const future = { id: 'future', current_revision_id: 'rev2' };
  const revisions = [
    { id: 'rev1', future_id: 'future' },
    { id: 'rev2', future_id: 'future' },
  ];
  const receipt = {
    id: 'prepared',
    status: 'recovery_required',
    input: { source: 'private-input' },
    result: { historical: true },
    effects: [{ status: 'prepared' }],
  };
  const engine = {
    native: {
      future: () => future,
      state: { futureRevisions: revisions },
      object: () => receipt,
    },
  };
  const result = await request(engine, '/api/futures/future');
  result.revisions[0].id = 'caller-mutated';
  assert.equal(revisions[0].id, 'rev1');
  const inspected = await request(engine, '/api/repository-requests/prepared');
  assert.equal(Object.hasOwn(inspected.request, 'input'), false);
  assert.equal(Object.hasOwn(inspected.request, 'result'), false);
  assert.deepEqual(inspected.request.effects, [{ status: 'prepared' }]);
});
