import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {git} from '../server/git.mjs';
import {createApplicationRunner} from '../server/runner.mjs';
import {copyApplicationFixture, copyPolicyFixture, applyApplicationChange} from '../fixtures/application.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'decision-application-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const application = path.join(root, 'checkout-api');
  const policy = path.join(root, 'payment-policy');
  await copyApplicationFixture(application); await copyPolicyFixture(policy);
  for (const repository of [application, policy]) {
    await git(repository, ['init', '--quiet', '-b', 'main']);
    await git(repository, ['add', '.']); await git(repository, ['commit', '--quiet', '-m', 'Baseline']);
  }
  const base = await git(application, ['rev-parse', 'HEAD']);
  const policyCommit = await git(policy, ['rev-parse', 'HEAD']);
  const runner = await createApplicationRunner({repositoryPath: application, policyRepositoryPath: policy, policyCommit});
  return {root, application, policy, base, policyCommit, runner};
}
async function commitChange(f, name, change) {
  await git(f.application, ['checkout', '--quiet', '-b', name, f.base]);
  await applyApplicationChange(f.application, change);
  await git(f.application, ['add', '.']); await git(f.application, ['commit', '--quiet', '-m', name]);
  return git(f.application, ['rev-parse', 'HEAD']);
}

test('real HTTP app: baseline, A and B pass alone; textually clean A+B duplicates a trusted external effect', async t => {
  const f = await fixture(t);
  const a = await commitChange(f, 'producer-retry', 'retry');
  const b = await commitChange(f, 'producer-confirmation', 'confirmation-before-dedupe');
  await git(f.application, ['checkout', '--quiet', '-b', 'combined', f.base]);
  await git(f.application, ['merge', '--quiet', '--no-ff', a, b, '-m', 'Clean Git composition']);
  const combined = await git(f.application, ['rev-parse', 'HEAD']);
  for (const [label, commit, attempts] of [['baseline', f.base, 1], ['A', a, 2], ['B', b, 1]]) {
    const result = await f.runner.validate(commit);
    assert.equal(result.passed, true, `${label}: ${JSON.stringify(result.checks)}`);
    assert.equal(result.observations.lostResponse.attempts, attempts);
    assert.equal(result.observations.lostResponse.charges, 1);
    assert.equal(result.observations.lostResponse.confirmations, 1);
    assert.equal(result.policy.commit, f.policyCommit);
  }
  const result = await f.runner.validate(combined);
  assert.equal(result.passed, false);
  assert.equal(result.observations.lostResponse.charges, 1);
  assert.equal(result.observations.lostResponse.confirmations, 2);
  assert.equal(result.observations.lostResponse.suppressedResponses, 1);
  assert.match(result.observations.source, /platform-owned external/);
  assert.equal(result.suite.ownership, 'platform');
  assert.equal(await git(f.application, ['rev-parse', `${combined}^{tree}`]), result.tree_hash);
});

test('producer-fabricated ledger and passing test output do not replace observed provider effects', async t => {
  const f = await fixture(t);
  await applyApplicationChange(f.application, 'retry');
  await applyApplicationChange(f.application, 'confirmation-before-dedupe');
  const app = path.join(f.application, 'app.mjs');
  await writeFile(app, (await readFile(app, 'utf8')).replace('send(response, 200, snapshot(state))', "send(response, 200, {charges: [{orderId: 'order-lost-response'}], confirmations: [{orderId: 'order-lost-response'}]})"));
  await writeFile(path.join(f.application, 'producer-tests.mjs'), "console.log(JSON.stringify({passed: true, confirmations: 1}));\n");
  await git(f.application, ['add', '.']); await git(f.application, ['commit', '--quiet', '-m', 'Fake producer ledger and tests']);
  const result = await f.runner.validate(await git(f.application, ['rev-parse', 'HEAD']));
  assert.equal(result.passed, false);
  assert.equal(result.observations.lostResponse.confirmations, 2);
  assert.equal(result.isolation.producerTestsExecuted, false);
});

test('candidate cannot inherit a secret, read host files or reach a non-loopback network', async t => {
  const f = await fixture(t);
  const key = 'DECISION_APPLICATION_TEST_SECRET';
  const prior = process.env[key]; process.env[key] = 'must-never-be-in-candidate';
  t.after(() => {if (prior === undefined) delete process.env[key]; else process.env[key] = prior;});
  const app = path.join(f.application, 'app.mjs');
  const probe = `import {readFileSync as readHostFile} from 'node:fs';
if (process.env.${key}) throw new Error('Environment secret escaped');
let denied = false; try {readHostFile('/etc/passwd');} catch (error) {denied = error.code === 'ERR_ACCESS_DENIED';}
if (!denied) throw new Error('Host filesystem escaped');
let offline = false; try {await fetch('http://203.0.113.1', {signal: AbortSignal.timeout(300)});} catch {offline = true;}
if (!offline) throw new Error('External network escaped');
`;
  await writeFile(app, probe + await readFile(app, 'utf8'));
  await git(f.application, ['add', '.']); await git(f.application, ['commit', '--quiet', '-m', 'Isolation probes']);
  const result = await f.runner.validate(await git(f.application, ['rev-parse', 'HEAD']));
  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.equal(result.isolation.network, 'private-loopback-only');
  assert.equal(result.isolation.environment, 'scrubbed');
});

test('symlinks are rejected before candidate execution and the ordinary repository remains usable', async t => {
  const f = await fixture(t);
  await symlink('/etc/passwd', path.join(f.application, 'host-file'));
  await git(f.application, ['add', '.']); await git(f.application, ['commit', '--quiet', '-m', 'Unsafe producer entry']);
  const result = await f.runner.validate(await git(f.application, ['rev-parse', 'HEAD']));
  assert.equal(result.passed, false);
  assert.equal(result.status, 'validation-unavailable');
  assert.match(result.checks[0].detail, /Symlinks/);
  await git(f.application, ['fsck', '--full']);
});
