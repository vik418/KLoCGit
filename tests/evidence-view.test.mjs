import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, emptyState } from '../core/engine.mjs';
import { stable } from '../core/hash.mjs';

const owner = { actor_id: 'owner', kind: 'human', auth_method: 'owner-token' };
const base = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const tree = 'c'.repeat(40);

function fixture() {
  const state = emptyState();
  state.workspace.owner_id = 'owner';
  state.repositories.push({
    id: 'app', name: 'Application', canonical_ref: 'refs/heads/main',
    head: base, baseline: base, tree: 'd'.repeat(40),
  });
  state.candidateStates = [{
    id: 'candidate', selection_ids: [], base_heads: { app: base },
    repositories: [{ repo_id: 'app', commit, tree }],
  }];
  let time = Date.now();
  const engine = new Engine(state, {
    configHash: 'trusted-config',
    ref: async () => base,
    facts: async (_repo, head) => ({ head, base: head, tree }),
  }, async () => {}, {
    evaluators: {
      clock: () => time,
      services: { ci: {
        secret: 'independent-ci-test-signing-secret',
        key_id: 'key-one', repo_ids: ['app'],
      } },
    },
  });
  return { engine, state, advance: (milliseconds) => { time += milliseconds; } };
}

async function register(engine, config = 'ci-config-v0') {
  return engine.evaluators.register({
    key: 'independent-quality', repo_ids: ['app'], mode: 'external',
    config_hash: config, service_id: 'ci', required_checks: ['regression'],
    required: true, enabled: true,
  }, 'owner', owner);
}

async function report(engine, run, state, eventId) {
  const body = {
    event_id: eventId, run_id: run.id, pins: run.pins, pins_hash: run.pins_hash,
    state, result: { checks: [{ id: 'regression', state }] },
  };
  const key = await crypto.subtle.importKey('raw',
    new TextEncoder().encode(engine.evaluators.services.ci.secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(stable({ run_id: run.id, body })))).toString('hex');
  return engine.evaluators.report(run.id, body, { service_id: 'ci', signature });
}

test('external evidence view follows actual signed runs, reruns and evaluator policy without changing historical facts', async () => {
  const f = fixture();
  const { profile } = await register(f.engine);
  const first = await f.engine.evaluators.run('candidate', {
    profile_id: profile.id, request_id: 'first-run',
  }, 'owner');
  const signed = await report(f.engine, first.run, 'passing', 'first-result');
  const historical = structuredClone(signed.evidence);
  let view = await f.engine.view();
  assert.equal(view.evidence.find((entry) => entry.id === signed.evidence.id).validity.status, 'current');
  assert.equal(view.evidence.find((entry) => entry.id === signed.evidence.id).result.passed, true);
  assert.equal(signed.evidence.source, 'evaluator:ci');
  assert.equal(signed.evidence.basis, 'observed');
  assert.match(signed.evidence.claim, /only these checks/);

  const second = await f.engine.evaluators.run('candidate', {
    profile_id: profile.id, request_id: 'second-run',
  }, 'owner');
  view = await f.engine.view();
  assert.equal(view.evidence.find((entry) => entry.id === signed.evidence.id).validity.status, 'stale');
  assert.equal((await f.engine.evaluators.eligibility('candidate')).passing, false);

  const failed = await report(f.engine, second.run, 'failed', 'second-result');
  view = await f.engine.view();
  assert.equal(view.evidence.find((entry) => entry.id === failed.evidence.id).validity.status, 'current');
  assert.equal(view.evidence.find((entry) => entry.id === failed.evidence.id).result.passed, false);
  assert.equal((await f.engine.evaluators.eligibility('candidate')).passing, false);

  await register(f.engine, 'ci-config-v1');
  view = await f.engine.view();
  assert.equal(view.evidence.length, 2);
  assert.ok(view.evidence.every((entry) => entry.validity.status === 'stale'));
  assert.deepEqual(f.state.evidence.find((entry) => entry.id === signed.evidence.id), historical);
  assert.equal(f.state.repositories[0].head, base);
  assert.equal(f.state.evaluationEvents.filter((event) => event.state === 'passing').length, 1);
});

test('external evidence expiry is projected as stale while its signed observation remains available', async () => {
  const f = fixture();
  const { profile } = await register(f.engine);
  const issued = await f.engine.evaluators.run('candidate', {
    profile_id: profile.id, request_id: 'expiry-run',
  }, 'owner');
  const signed = await report(f.engine, issued.run, 'passing', 'expiry-result');
  f.advance(profile.timeout_ms + 1);
  const view = await f.engine.view();
  const shown = view.evidence.find((entry) => entry.id === signed.evidence.id);
  assert.equal(shown.validity.status, 'stale');
  assert.ok(shown.validity.reasons.includes('Evaluation validity expired.'));
  assert.equal(shown.result.passed, true);
  assert.equal(f.state.evidence.length, 1);
});
