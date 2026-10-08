import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLiveManifest, liveAcceptancePassed, nativePromotionInput, NATIVE_LIVE_CHECKS } from '../scripts/cloudflare-live.mjs';

const account = 'a'.repeat(32);
const fixture = () => ({
  account_id: account,
  namespace: 'klocgit',
  queue: 'klocgit-git-events',
  url: 'https://klocgit.example',
  executorControlUrl: 'https://executor-test.example',
  allowCanonicalMutation: true,
  repositories: ['app', 'policy'].map((name) => ({
    name,
    remote: 'https://' + account + '.artifacts.cloudflare.net/git/klocgit/' + name + '.git',
    tokenEnv: 'LIVE_' + name.toUpperCase() + '_TOKEN',
    disposable: true,
  })),
});

test('live native check requires a dedicated explicitly mutable two-repository fixture before network effects', () => {
  assert.equal(validateLiveManifest(fixture(), 'check').repositories.length, 2);
  for (const change of [
    { allowCanonicalMutation: false },
    { repositories: fixture().repositories.map((repo) => ({ ...repo, disposable: false })) },
    { repositories: [fixture().repositories[0]] },
    { repositories: [fixture().repositories[0], fixture().repositories[0]] },
    { executorControlUrl: undefined }, { queue: undefined },
  ]) assert.throws(() => validateLiveManifest({ ...fixture(), ...change }, 'check'));
});

test('live manifest cannot direct scoped Git credentials to another account, namespace or repository', () => {
  const invalidRemotes = [
    'https://' + 'b'.repeat(32) + '.artifacts.cloudflare.net/git/klocgit/app.git',
    'https://' + account + '.artifacts.cloudflare.net/git/other/app.git',
    'https://' + account + '.artifacts.cloudflare.net/git/klocgit/policy.git',
    'https://user:secret@' + account + '.artifacts.cloudflare.net/git/klocgit/app.git',
    'https://' + account + '.artifacts.cloudflare.net/git/klocgit/app.git?token=secret',
    'http://' + account + '.artifacts.cloudflare.net/git/klocgit/app.git',
    'https://' + account + '.artifacts.cloudflare.net:444/git/klocgit/app.git',
  ];
  for (const remote of invalidRemotes) {
    const manifest = fixture();
    manifest.repositories[0].remote = remote;
    assert.throws(() => validateLiveManifest(manifest, 'check'), /INVALID_ARTIFACTS_REMOTE/);
  }
  const manifest = fixture();
  manifest.repositories[0].tokenEnv = 'TOKEN=value';
  assert.throws(() => validateLiveManifest(manifest, 'check'), /INVALID_CREDENTIAL_VARIABLE_NAME/);
});

test('provisioning and preflight cannot masquerade as complete live verification', () => {
  const checks = NATIVE_LIVE_CHECKS.map((name) => ({ name, passed: true }));
  const complete = { mode: 'check', live: true, status: 'passed', checks };
  assert.equal(liveAcceptancePassed(complete), true);
  for (const change of [
    { mode: 'preflight' }, { mode: 'provision-events' }, { mode: 'verify' },
    { live: false }, { status: 'blocked' }, { checks: checks.slice(0, -1) },
    { checks: checks.map((entry, index) => index === 4 ? { ...entry, passed: false } : entry) },
  ]) assert.equal(liveAcceptancePassed({ ...complete, ...change }), false);
});

test('promotion request pins the displayed native basis and head vector without refreshing stale review', () => {
  const review = {
    validation_passing: true, sources_current: true, heads_current: true,
    promotion_supported: true, decision_basis_hash: 'immutable-reviewed-basis',
    expected_heads: { app: 'a'.repeat(40), policy: 'b'.repeat(40) },
  };
  const input = nativePromotionInput(review, 'live-request');
  assert.equal(input.decision_basis_hash, review.decision_basis_hash);
  assert.equal(input.request_id, 'live-request');
  assert.deepEqual(input.expected_heads, review.expected_heads);
  input.expected_heads.app = 'c'.repeat(40);
  assert.equal(review.expected_heads.app, 'a'.repeat(40));
  for (const changed of ['validation_passing', 'sources_current', 'heads_current', 'promotion_supported'])
    assert.throws(() => nativePromotionInput({ ...review, [changed]: false }, 'live-request'),
      /LIVE_CANDIDATE_NOT_PROMOTABLE/);
});
