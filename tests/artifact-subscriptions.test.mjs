import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactSubscriptions } from '../worker/artifact-subscriptions.mjs';
import { repositoryOperationDescription } from '../core/repository-input.mjs';

const account = 'a'.repeat(32),
  queue = 'b'.repeat(32);
const operation = 'request_' + 'c'.repeat(64);
const input = {
  id: 'future-repo',
  ref: 'refs/heads/main',
  operation_id: operation,
  repository_operation_id: operation,
};

function fixture() {
  const calls = [],
    records = [];
  let description = repositoryOperationDescription('Isolated work', operation);
  let remote = 'https://' + account + '.artifacts.cloudflare.net/git/klocgit/future-repo.git';
  let lostReply = false,
    changedReadback = false,
    disposed = 0;
  const env = {
    CLOUDFLARE_ACCOUNT_ID: account,
    ARTIFACTS_EVENTS_QUEUE_ID: queue,
    ARTIFACTS_NAMESPACE: 'klocgit',
    ARTIFACTS_SUBSCRIPTION_TOKEN: 'inert-private-subscription-token',
    ARTIFACTS: {
      get: async () => ({
        info: async () => ({ description, remote }),
        [Symbol.dispose]() {
          disposed++;
        },
      }),
    },
  };
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method });
    assert.equal(new URL(url).hostname, 'api.cloudflare.com');
    assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname;
    if (options.method === 'POST') {
      const value = { ...JSON.parse(options.body), id: 'subscription-001' };
      records.push(value);
      if (lostReply) throw new Error(env.ARTIFACTS_SUBSCRIPTION_TOKEN);
      return Response.json({ success: true, result: value });
    }
    if (path.endsWith('/subscriptions'))
      return Response.json({ success: true, result: records, result_info: { total_pages: 1 } });
    const value = structuredClone(records.find((entry) => path.endsWith('/' + entry.id)));
    if (changedReadback && value) value.destination.queue_id = 'd'.repeat(32);
    return Response.json({ success: true, result: value });
  };
  const controller = new ArtifactSubscriptions(env, fetcher);
  return {
    env,
    calls,
    records,
    controller,
    get disposed() {
      return disposed;
    },
    loseReply() {
      lostReply = true;
    },
    changeReadback() {
      changedReadback = true;
    },
    description(value) {
      description = value;
    },
    remote(value) {
      remote = value;
    },
  };
}

test('native delivery is read back against exact repository, account, namespace, queue and event', async () => {
  const f = fixture();
  const receipt = await f.controller.ensure(input);
  assert.equal(receipt.status, 'ready');
  assert.equal(receipt.repo_id, input.id);
  assert.equal(receipt.queue_id, queue);
  assert.equal(receipt.basis, 'observed');
  assert.equal(f.calls.filter((entry) => entry.method === 'POST').length, 1);
  assert.equal(f.disposed, 1);
  assert.deepEqual(f.records[0].events, ['cf.artifacts.repo.pushed']);
  assert.deepEqual(await f.controller.ensure(input), receipt);
  assert.equal(f.calls.filter((entry) => entry.method === 'POST').length, 1);
  assert.equal(JSON.stringify(receipt).includes(f.env.ARTIFACTS_SUBSCRIPTION_TOKEN), false);
});

test('lost acknowledgements reconcile a confirmed subscription without repeating POST', async () => {
  const f = fixture();
  f.loseReply();
  await assert.rejects(
    () => f.controller.ensure(input),
    (error) =>
      error.code === 'EVENT_SUBSCRIPTION_UNAVAILABLE' &&
      !error.message.includes(f.env.ARTIFACTS_SUBSCRIPTION_TOKEN),
  );
  const recovered = await f.controller.inspect(input);
  assert.equal(recovered.subscription_id, 'subscription-001');
  assert.equal(f.calls.filter((entry) => entry.method === 'POST').length, 1);
});

test('missing or changed subscriptions cannot turn uncertain effects into successful recovery', async () => {
  const f = fixture();
  await assert.rejects(() => f.controller.inspect(input), { code: 'RECOVERY_REQUIRED' });
  assert.equal(
    f.calls.some((entry) => entry.method === 'POST'),
    false,
  );
  await f.controller.ensure(input);
  f.changeReadback();
  await assert.rejects(() => f.controller.inspect(input), {
    code: 'EVENT_SUBSCRIPTION_UNAVAILABLE',
  });
});

test('operator configuration and authoritative repository ownership gate all control-plane effects', async () => {
  const f = fixture();
  delete f.env.ARTIFACTS_SUBSCRIPTION_TOKEN;
  assert.throws(() => f.controller.preflight(), { code: 'EVENT_SUBSCRIPTION_NOT_CONFIGURED' });
  assert.equal(f.calls.length, 0);
  const g = fixture();
  g.description(repositoryOperationDescription('Other work', 'request_' + 'e'.repeat(64)));
  await assert.rejects(() => g.controller.ensure(input), { code: 'RECOVERY_REQUIRED' });
  assert.equal(g.calls.length, 0);
  g.description(null);
  await assert.rejects(() => g.controller.ensure(input), { code: 'RECOVERY_REQUIRED' });
  const adopted = await g.controller.ensure({ ...input, repository_operation_id: null });
  assert.equal(adopted.status, 'ready');
  const h = fixture();
  h.remote('https://' + account + '.artifacts.cloudflare.net/git/other/future-repo.git');
  await assert.rejects(() => h.controller.ensure(input), { code: 'SUBSCRIPTION_SCOPE_MISMATCH' });
  assert.equal(h.calls.length, 0);
});

test('wrong queue, disabled and non-push subscriptions never satisfy native delivery', async () => {
  const f = fixture();
  await f.controller.ensure(input);
  f.records[0].enabled = false;
  await assert.rejects(() => f.controller.inspect(input), { code: 'RECOVERY_REQUIRED' });
  f.records[0].enabled = true;
  f.records[0].events = ['cf.artifacts.repo.cloned'];
  await assert.rejects(() => f.controller.inspect(input), { code: 'RECOVERY_REQUIRED' });
  f.records[0].events = ['cf.artifacts.repo.pushed'];
  f.records[0].destination.queue_id = 'f'.repeat(32);
  await assert.rejects(() => f.controller.inspect(input), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.calls.filter((entry) => entry.method === 'POST').length, 1);
});
