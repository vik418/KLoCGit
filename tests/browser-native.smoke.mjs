/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { stable } from '../core/hash.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'klocgit-browser-'));
const workspaceRoot = path.join(root, 'workspace');
const credential = 'ui-check';
const evaluatorSecret = 'browser-ci-fixture-secret';
let server;
let browser;
let page;
const pageErrors = [];
let serverOutput = '';

async function git(directory, ...args) {
  const result = await exec('git', ['-C', directory, ...args], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

function startServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Local server did not start: ' + serverOutput)),
      60000,
    );
    server = spawn(process.execPath, ['server/local.mjs'], {
      cwd: project,
      env: {
        ...process.env,
        KLOCGIT_ROOT: workspaceRoot,
        LOCAL_ACTOR_ID: 'browser-tests',
        LOCAL_OWNER_TOKEN: credential,
        EVALUATOR_SERVICES: JSON.stringify({
          'browser-ci': { secret: evaluatorSecret, key_id: 'browser-key', repo_ids: ['app'] },
        }),
        HOST: '127.0.0.1',
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    function output(chunk) {
      serverOutput += chunk.toString();
      const match = serverOutput.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[0].replace('localhost', '127.0.0.1'));
    }
    server.stdout.on('data', output);
    server.stderr.on('data', (chunk) => {
      serverOutput += chunk.toString();
    });
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Local server exited (' + code + '): ' + serverOutput));
    });
  });
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    server.kill('SIGTERM');
  });
}

async function authenticate(page, url) {
  await page.goto(url);
  await page.getByLabel('Owner credential', { exact: true }).fill(credential);
  await page.getByRole('button', { name: 'Connect to workspace', exact: true }).click();
  const sourceRepository = new URL(url).searchParams.get('repo');
  if (sourceRepository)
    await page.getByRole('dialog', { name: sourceRepository + ' · source', exact: true }).waitFor();
  else await page.getByRole('button', { name: 'Repositories', exact: true }).waitFor();
}

async function waitForFocus(page, control) {
  // Radix restores focus during unmount, after the dialog leaves the document.
  const element = await control.elementHandle();
  await page.waitForFunction((node) => node === document.activeElement, element, {
    timeout: 5000,
  });
}

async function assertFitsViewport(page) {
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.width + 1, 'Page overflows horizontally');
  const dialogs = await page.getByRole('dialog').all();
  for (const dialog of dialogs) {
    const box = await dialog.boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= dimensions.width + 1,
      'Dialog exceeds the viewport',
    );
  }
}

function waitForMutation(page, suffix) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return new URL(response.url()).pathname === '/api' + suffix && request.method() === 'POST';
  });
}

try {
  const url = await startServer();
  const api = async (suffix, input) => {
    const response = await fetch(url + '/api' + suffix, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + credential,
        'content-type': 'application/json',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const accessibilityWarnings = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (
      ['warning', 'error'].includes(message.type()) &&
      /DialogTitle|DialogDescription|aria-describedby|Missing.*Description/i.test(message.text())
    ) {
      accessibilityWarnings.push(message.text());
    }
  });

  await authenticate(page, url);
  const empty = await api('/native-state');
  assert.equal(empty.repositories.length, 0, 'Fresh startup must not seed demo repositories');
  assert.equal(empty.futures.length, 0);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    'rgb(13, 10, 11)',
  );
  await assertFitsViewport(page);

  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  const addRepository = page
    .getByRole('button', { name: /^(Add|Create) (a )?repository$/i })
    .first();
  await addRepository.click();
  let dialog = page.getByRole('dialog', { name: 'Add a repository', exact: true });
  await dialog.waitFor();
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() =>
      Boolean(document.activeElement.closest('[data-slot="dialog-content"]')),
    ),
    true,
    'Dialog must trap keyboard focus',
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, addRepository);
  assert.equal(
    await addRepository.evaluate((element) => element === document.activeElement),
    true,
    'Escape must restore focus to the invoking control',
  );

  await addRepository.click();
  dialog = page.getByRole('dialog', { name: 'Add a repository', exact: true });
  await dialog.getByLabel('Repository name', { exact: true }).fill('app');
  const created = waitForMutation(page, '/repositories');
  await dialog.getByRole('button', { name: 'Create repository', exact: true }).click();
  const createdResponse = await created;
  assert.equal(createdResponse.status(), 200);
  const { repository } = await createdResponse.json();
  assert.equal(repository.status, 'empty');
  assert.ok(!repository.head && !repository.tree, 'Empty repositories must not invent Git state');
  assert.ok(
    repository.remote.startsWith(workspaceRoot + path.sep),
    'Fixture remote must belong to this test workspace',
  );
  await dialog.waitFor({ state: 'hidden' });

  // Use ordinary Git against the actual repository created by the browser.
  const checkout = path.join(root, 'canonical-client');
  await exec('git', ['clone', repository.remote, checkout], { timeout: 15000 });
  await git(checkout, 'config', 'user.name', 'klocgit browser tests');
  await git(checkout, 'config', 'user.email', 'tests@localhost');
  await git(checkout, 'checkout', '-B', 'main');
  await writeFile(path.join(checkout, 'app.mjs'), 'export const value = 0;\n');
  await git(checkout, 'add', 'app.mjs');
  await git(checkout, 'commit', '-m', 'Add baseline application');
  await git(checkout, 'push', 'origin', 'HEAD:refs/heads/main');
  const baselineCommit = await git(checkout, 'rev-parse', 'HEAD');
  const baselineTree = await git(checkout, 'rev-parse', 'HEAD^{tree}');

  const refreshed = waitForMutation(page, '/repositories/app/refresh');
  await page.getByRole('button', { name: 'Refresh Git state', exact: true }).click();
  assert.equal((await refreshed).status(), 200);
  const ready = (await api('/native-state')).repositories.find((item) => item.id === 'app');
  assert.equal(ready.head, baselineCommit);
  assert.equal(ready.tree, baselineTree);
  assert.equal(ready.status, 'ready');

  const browse = page.getByRole('button', { name: 'Browse code', exact: true });
  await browse.click();
  let sourceDialog = page.getByRole('dialog', { name: 'app · source', exact: true });
  await sourceDialog.waitFor();
  await sourceDialog.getByText('1 files · 0 directories · 0 submodules', { exact: true }).waitFor();
  await sourceDialog.getByRole('button', { name: /^app\.mjs/ }).click();
  await sourceDialog
    .getByRole('region', { name: 'File contents' })
    .getByText('export const value = 0;', { exact: true })
    .waitFor();
  await sourceDialog.getByRole('button', { name: 'Raw view', exact: true }).click();
  assert.equal(
    await sourceDialog.getByLabel('Raw file contents', { exact: true }).inputValue(),
    'export const value = 0;\n',
  );
  await sourceDialog.getByRole('button', { name: 'Commits', exact: true }).click();
  await sourceDialog
    .getByRole('region', { name: 'Commit history' })
    .getByRole('heading', { name: 'Add baseline application', exact: true })
    .waitFor();
  await assertFitsViewport(page);
  await page.keyboard.press('Escape');
  await sourceDialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, browse);

  // Permalinks bind to immutable Git state and reopen after authentication.
  await authenticate(
    page,
    url + '/?' + new URLSearchParams({ repo: 'app', commit: baselineCommit, path: 'app.mjs' }),
  );
  sourceDialog = page.getByRole('dialog', { name: 'app · source', exact: true });
  await sourceDialog
    .getByRole('region', { name: 'File contents' })
    .getByText('export const value = 0;', { exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await assertFitsViewport(page);
  await page.keyboard.press('Escape');
  await sourceDialog.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();

  await page.getByRole('button', { name: 'Fork repository', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Fork repositories', exact: true });
  await dialog.waitFor();
  const choice = dialog.getByRole('checkbox', { name: 'app', exact: true });
  assert.equal(await choice.isChecked(), true, 'Repository fork action must preselect its source');
  const futureCreated = waitForMutation(page, '/futures');
  await dialog.getByRole('button', { name: 'Fork repositories', exact: true }).click();
  const futureResponse = await futureCreated;
  assert.equal(futureResponse.status(), 200);
  const { future } = await futureResponse.json();
  assert.equal(future.repositories.length, 1);
  assert.notEqual(
    future.repositories[0].remote,
    repository.remote,
    'Fork must have its own Git remote',
  );
  assert.equal(future.baseline_refs[0].commit, baselineCommit);
  assert.equal(future.status, 'active');
  await dialog.waitFor({ state: 'hidden' });

  // Groups and objectives are optional at entry, not additional forms.
  let native = await api('/native-state');
  assert.equal(native.systems.length, 1);
  assert.equal(native.objectives.length, 1);
  assert.equal(native.futureRevisions.length, 1);
  const firstRevision = native.futureRevisions[0];
  assert.equal(firstRevision.provenance_state, 'unknown');
  assert.equal(firstRevision.repository_heads[0].commit, baselineCommit);

  const forkRemote = page.getByLabel('Git remote', { exact: true });
  await forkRemote.waitFor();
  assert.equal(await forkRemote.inputValue(), future.repositories[0].remote);
  const futureCheckout = path.join(root, 'future-client');
  await exec('git', ['clone', future.repositories[0].remote, futureCheckout], { timeout: 15000 });
  await git(futureCheckout, 'config', 'user.name', 'independent Git producer');
  await git(futureCheckout, 'config', 'user.email', 'tests@localhost');
  await writeFile(path.join(futureCheckout, 'app.mjs'), 'export const value = 1;\n');
  await git(futureCheckout, 'add', 'app.mjs');
  await git(futureCheckout, 'commit', '-m', 'Change isolated application');
  await git(futureCheckout, 'push', 'origin', 'HEAD:refs/heads/main');
  const changedCommit = await git(futureCheckout, 'rev-parse', 'HEAD');
  const changedTree = await git(futureCheckout, 'rev-parse', 'HEAD^{tree}');

  await page.getByRole('button', { name: 'Futures', exact: true }).click();
  async function observe() {
    const response = waitForMutation(page, '/futures/' + future.id + '/observe');
    const control = page.getByRole('button', { name: 'Observe Git state', exact: true });
    await control.click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    const value = await result.json();
    await control.waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    return value;
  }
  const observed = await observe();
  assert.equal(observed.changed, true);
  assert.equal(observed.revision.repository_heads[0].commit, changedCommit);
  assert.equal(observed.revision.tree_hashes[0].tree, changedTree);
  native = await api('/native-state');
  assert.equal(native.futureRevisions.length, 2);
  assert.equal(
    native.repositories.find((item) => item.id === 'app').head,
    baselineCommit,
    'Observing isolated work must not promote it',
  );
  assert.deepEqual(
    native.futureRevisions[0],
    firstRevision,
    'Historical revisions must remain immutable',
  );
  assert.equal(
    (await observe()).changed,
    false,
    'Repeated observation of the same Git state is idempotent',
  );

  // Compose a selected commit through the native UI; producer code cannot grant itself validation.
  await page.getByRole('button', { name: 'Compose candidate', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Compose a candidate', exact: true });
  await dialog.getByRole('checkbox', { name: future.name, exact: true }).check();
  await dialog.getByLabel('Selection for ' + future.name, { exact: true }).selectOption('commits');
  await dialog.getByLabel('Repository for ' + future.name, { exact: true }).selectOption('app');
  await dialog.getByLabel('Commit hashes for ' + future.name, { exact: true }).fill(changedCommit);
  const composed = waitForMutation(page, '/candidates');
  await dialog.getByRole('button', { name: 'Create candidate', exact: true }).click();
  const composedResponse = await composed;
  assert.equal(composedResponse.status(), 200, await composedResponse.text());
  const { candidate } = await composedResponse.json();
  dialog = page.getByRole('dialog', { name: 'Apply this candidate?', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Run validation', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  const validated = waitForMutation(page, '/candidates/' + candidate.id + '/validate');
  await dialog.getByRole('button', { name: 'Run validation', exact: true }).click();
  const validationResponse = await validated;
  assert.equal(validationResponse.status(), 200, await validationResponse.text());
  const validation = await validationResponse.json();
  assert.equal(
    validation.evidence[0].result.passed,
    false,
    'Unknown repositories have no trusted validation profile',
  );
  await dialog.getByText('Checks did not pass', { exact: true }).waitFor();
  await dialog
    .getByLabel('Why choose this candidate?', { exact: true })
    .fill('Review selected work.');
  assert.equal(
    await dialog.getByRole('button', { name: 'Apply candidate', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    (await api('/native-state')).repositories.find((entry) => entry.id === 'app').head,
    baselineCommit,
  );
  // An admitted evaluator checks the composed tree independently of the producer.
  await api('/evaluators', {
    key: 'browser-ci',
    repo_ids: ['app'],
    mode: 'external',
    service_id: 'browser-ci',
    config_hash: 'browser-composed-file-v0',
    required_checks: ['selected-content'],
  });
  await dialog.getByRole('button', { name: 'Refresh review', exact: true }).click();
  const issued = waitForMutation(page, '/evaluation-runs');
  await dialog.getByRole('button', { name: 'Issue run', exact: true }).click();
  const issuedResponse = await issued;
  assert.equal(issuedResponse.status(), 200, await issuedResponse.text());
  const { run } = await issuedResponse.json();
  const composedRepository = candidate.repositories.find((entry) => entry.repo_id === 'app');
  assert.equal(
    await git(repository.remote, 'show', composedRepository.commit + ':app.mjs'),
    'export const value = 1;',
  );
  assert.equal(
    await git(repository.remote, 'rev-parse', composedRepository.commit + '^{tree}'),
    composedRepository.tree,
  );
  const report = {
    event_id: 'browser-composition-checked',
    run_id: run.id,
    pins: run.pins,
    pins_hash: run.pins_hash,
    state: 'passing',
    result: {
      checks: [{ id: 'selected-content', state: 'passing' }],
    },
  };
  const signature = createHmac('sha256', evaluatorSecret)
    .update(stable({ run_id: run.id, body: report }))
    .digest('hex');
  const reported = await fetch(url + '/api/evaluation-runs/' + run.id + '/report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Klocgit-Evaluator-Service': 'browser-ci',
      'X-Klocgit-Evaluator-Signature': signature,
    },
    body: JSON.stringify(report),
  });
  assert.equal(reported.status, 200, await reported.text());
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  const refreshedReview = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/candidates/' + candidate.id + '/review' &&
      response.request().method() === 'GET',
  );
  await dialog.getByRole('button', { name: 'Refresh review', exact: true }).click();
  const refreshedResponse = await refreshedReview;
  assert.equal(refreshedResponse.status(), 200, await refreshedResponse.text());
  assert.deepEqual(pageErrors, [], 'Candidate review must not throw browser errors');
  await dialog
    .getByLabel('Why choose this candidate?', { exact: true })
    .fill('The admitted evaluator checked the selected content on this exact tree.');
  const promoted = waitForMutation(page, '/candidates/' + candidate.id + '/promote');
  await dialog.getByRole('button', { name: 'Apply candidate', exact: true }).click();
  const promotedResponse = await promoted;
  assert.equal(promotedResponse.status(), 200, await promotedResponse.text());
  const promotedHead = await git(repository.remote, 'rev-parse', 'refs/heads/main');
  assert.equal(promotedHead, composedRepository.commit);
  await git(repository.remote, 'fsck', '--full');
  await dialog.waitFor({ state: 'hidden' });
  await assertFitsViewport(page);
  await page.getByRole('button', { name: 'Futures', exact: true }).click();

  // A rewind is another observation; it must not overwrite the first A revision.
  await git(futureCheckout, 'reset', '--hard', baselineCommit);
  await git(futureCheckout, 'push', '--force', 'origin', 'HEAD:refs/heads/main');
  const rewind = await observe();
  assert.equal(rewind.changed, true);
  assert.equal(rewind.revision.repository_heads[0].commit, baselineCommit);
  assert.notEqual(rewind.revision.id, firstRevision.id);
  native = await api('/native-state');
  assert.equal(native.futureRevisions.length, 3);
  await page.getByText('Git state and revision history', { exact: true }).click();
  await page.getByText(rewind.revision.id, { exact: true }).waitFor();
  await assertFitsViewport(page);

  // Select actual branches and annotated tags, rather than treating every ref as a branch.
  await git(futureCheckout, 'push', 'origin', changedCommit + ':refs/heads/ref-choice');
  await git(futureCheckout, 'tag', '-a', 'review-state', changedCommit, '-m', 'Observed candidate');
  const annotatedTag = await git(futureCheckout, 'rev-parse', 'refs/tags/review-state');
  await git(futureCheckout, 'update-ref', 'refs/tags/tree-only', changedTree);
  await git(futureCheckout, 'push', 'origin', 'refs/tags/review-state', 'refs/tags/tree-only');
  const sourceRepository = future.repositories[0];
  const listed = await api('/repositories/' + sourceRepository.repo_id + '/refs?limit=50');
  assert.equal(
    listed.refs.find((entry) => entry.ref === 'refs/tags/tree-only').available_for_future,
    false,
  );
  assert.equal(
    listed.refs.find((entry) => entry.ref === 'refs/tags/review-state').commit,
    changedCommit,
  );

  async function chooseSource(ref) {
    const control = page.getByRole('button', { name: 'Choose source refs', exact: true });
    await control.click();
    const sourceDialog = page.getByRole('dialog', { name: 'Choose source refs', exact: true });
    await sourceDialog.waitFor();
    const blocked = sourceDialog.getByRole('button', { name: /refs\/tags\/tree-only/ });
    await blocked.waitFor();
    assert.equal(await blocked.isDisabled(), true, 'A tree tag cannot become a Future revision');
    await sourceDialog.getByRole('button', { name: new RegExp(ref) }).click();
    await assertFitsViewport(page);
    const completed = waitForMutation(page, '/futures/' + future.id + '/observe');
    await sourceDialog.getByRole('button', { name: 'Observe selected refs', exact: true }).click();
    const response = await completed;
    assert.equal(response.status(), 200, await response.text());
    const result = await response.json();
    await sourceDialog.waitFor({ state: 'hidden' });
    await waitForFocus(page, control);
    return result;
  }

  const branchRevision = await chooseSource('refs/heads/ref-choice');
  assert.equal(branchRevision.revision.repository_heads[0].ref, 'refs/heads/ref-choice');
  assert.equal(branchRevision.revision.repository_heads[0].commit, changedCommit);
  const tagRevision = await chooseSource('refs/tags/review-state');
  assert.equal(tagRevision.changed, true);
  assert.equal(tagRevision.revision.repository_heads[0].object_id, annotatedTag);
  assert.equal(tagRevision.revision.repository_heads[0].object_type, 'tag');
  assert.equal(tagRevision.revision.repository_heads[0].commit, changedCommit);
  assert.notEqual(tagRevision.revision.id, branchRevision.revision.id);
  native = await api('/native-state');
  assert.equal(native.repositories.find((item) => item.id === 'app').head, promotedHead);
  assert.deepEqual(native.futureRevisions[0], firstRevision);
  assert.equal(native.futureRevisions.length, 5);
  const retainedTag = native.retentions.find(
    (entry) =>
      entry.subject.source_repo_id === sourceRepository.repo_id &&
      entry.subject.object_ids.includes(annotatedTag) &&
      entry.status === 'retained',
  );
  assert.ok(retainedTag, 'An annotated tag and its commit must have an archive receipt');
  assert.equal(
    await git(
      repository.remote,
      'rev-parse',
      'refs/klocgit/observations/' + sourceRepository.repo_id + '/' + annotatedTag,
    ),
    annotatedTag,
    'The archive must pin the tag object itself, not only its peeled commit',
  );
  const provenance = await api('/provenance/revision/' + tagRevision.revision.id);
  assert.equal(provenance.version, 0);
  const provenanceRevision = provenance.records.find(
    (record) => record.kind === 'revision' && record.id === tagRevision.revision.id,
  );
  assert.equal(provenanceRevision.basis, 'observed');
  assert.equal(
    provenanceRevision.provenance_state,
    'unknown',
    'Observed Git facts must not invent producer provenance',
  );
  assert.deepEqual(provenanceRevision.repository_heads, tagRevision.revision.repository_heads);
  assert.deepEqual(provenanceRevision.tree_hashes, tagRevision.revision.tree_hashes);
  assert.ok(
    provenance.records.some(
      (record) =>
        record.kind === 'objective' &&
        record.id === future.objective_id &&
        record.basis === 'unknown',
    ),
  );
  assert.ok(
    provenance.links.some(
      (link) =>
        link.from.kind === 'objective' &&
        link.from.id === future.objective_id &&
        link.to.kind === 'revision' &&
        link.to.id === tagRevision.revision.id,
    ),
    'The recorded outcome must remain linked to this exact revision',
  );

  const tagHistory = page.getByRole('region', {
    name: 'Revision history for ' + future.name,
    exact: true,
  });
  const tagRecord = tagHistory.locator('div.rounded-md.border.p-3').filter({
    has: page.getByText(tagRevision.revision.id, { exact: true }),
  });
  const inspect = tagRecord.getByRole('button', { name: 'Inspect provenance', exact: true });
  await inspect.click();
  const provenanceDialog = page.getByRole('dialog', { name: 'Provenance', exact: true });
  await provenanceDialog.waitFor();
  const revisionSummary = provenanceDialog
    .getByRole('region', { name: 'Provenance records', exact: true })
    .locator('summary')
    .filter({ hasText: 'revision · ' + tagRevision.revision.id });
  await revisionSummary.click();
  await revisionSummary.locator('..').getByText('Basis: observed', { exact: true }).waitFor();
  await assertFitsViewport(page);
  await page.keyboard.press('Escape');
  await provenanceDialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, inspect);

  const restoredMain = await chooseSource('refs/heads/main');
  assert.equal(restoredMain.revision.repository_heads[0].commit, baselineCommit);
  assert.equal(restoredMain.revision.repository_heads[0].ref, 'refs/heads/main');
  await git(
    futureCheckout,
    'push',
    'origin',
    '--delete',
    'refs/heads/ref-choice',
    'refs/tags/review-state',
  );
  assert.equal(
    await git(
      repository.remote,
      'rev-parse',
      'refs/klocgit/observations/' + sourceRepository.repo_id + '/' + changedCommit,
    ),
    changedCommit,
    'Deleting source refs must not discard objects referenced by historical revisions',
  );

  // A group can contain repositories whose current Git state is not ready.
  await api('/repositories', { id: 'empty-member', request_id: 'empty-member' });
  await api('/systems', {
    name: 'Mixed readiness',
    repository_ids: ['app', 'empty-member'],
    request_id: 'mixed-system',
  });
  await authenticate(page, url);
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  const systemCard = page.locator('[data-slot="card"]').filter({
    has: page.getByRole('heading', { name: 'Mixed readiness', exact: true }),
  });
  const systemWork = systemCard.getByRole('button', { name: 'Fork repositories', exact: true });
  await systemWork.click();
  dialog = page.getByRole('dialog', { name: 'Fork repositories', exact: true });
  assert.equal(await dialog.getByRole('checkbox', { name: 'app', exact: true }).isChecked(), true);
  const unready = dialog.getByRole('checkbox', { name: /empty-member/ });
  assert.equal(await unready.isChecked(), false);
  assert.equal(await unready.isDisabled(), true);
  assert.equal(
    await dialog.getByRole('button', { name: 'Fork repositories', exact: true }).isEnabled(),
    true,
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, systemWork);

  // Exercise responsive layout and Radix dismissal on the same real state.
  await page.setViewportSize({ width: 390, height: 844 });
  await assertFitsViewport(page);
  await page.getByRole('button', { name: 'Futures', exact: true }).click();
  const mobileSourceControl = page.getByRole('button', { name: 'Choose source refs', exact: true });
  await mobileSourceControl.click();
  const mobileSourceDialog = page.getByRole('dialog', { name: 'Choose source refs', exact: true });
  await mobileSourceDialog.waitFor();
  await assertFitsViewport(page);
  await page.keyboard.press('Escape');
  await mobileSourceDialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, mobileSourceControl);
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await addRepository.click();
  dialog = page.getByRole('dialog', { name: 'Add a repository', exact: true });
  await dialog.waitFor();
  await assertFitsViewport(page);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, addRepository);
  assert.equal(await addRepository.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(pageErrors, [], 'Browser must not throw runtime errors');
  assert.deepEqual(
    accessibilityWarnings,
    [],
    'Radix titles and descriptions must be wired correctly',
  );

  async function capture(label) {
    const image = await page.screenshot({ fullPage: true, animations: 'disabled' });
    if (process.env.BROWSER_ARTIFACT_DIR) {
      await mkdir(process.env.BROWSER_ARTIFACT_DIR, { recursive: true });
      await writeFile(
        path.join(process.env.BROWSER_ARTIFACT_DIR, 'native-' + label + '.png'),
        image,
      );
    }
    if (process.env.BROWSER_SCREENSHOT_LOG === '1') {
      const encoded = image.toString('base64');
      for (let offset = 0; offset < encoded.length; offset += 3500)
        console.log('KLOCGIT_SCREENSHOT:' + label + ':' + encoded.slice(offset, offset + 3500));
    }
  }
  await capture('mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Futures', exact: true }).click();
  await capture('desktop');
  // A policy in another repository must be retrieved and answered before this Future is created.
  const policyResult = await api('/repositories', {
    id: 'policy',
    mode: 'create',
    request_id: 'browser-policy-repository',
  });
  const policyCheckout = path.join(root, 'policy-client');
  await exec('git', ['clone', policyResult.repository.remote, policyCheckout], { timeout: 15000 });
  await git(policyCheckout, 'config', 'user.name', 'klocgit browser tests');
  await git(policyCheckout, 'config', 'user.email', 'tests@localhost');
  await git(policyCheckout, 'checkout', '-B', 'main');
  const policyDocument = {
    constraints: [
      {
        id: 'retry-contract',
        version: 'v0',
        visibility: 'coordination',
        statement: 'Retries require an explicit failure policy.',
        scope: [{ repo_id: 'app', path: 'app.mjs' }],
        choice: {
          key: 'retry',
          question: 'May a failed request be retried?',
          options: [
            {
              id: 'retry',
              label: 'Retry once',
              effects: ['A failed request can produce a second attempt'],
            },
            { id: 'once', label: 'Attempt once', effects: ['A failed request ends the operation'] },
          ],
        },
      },
    ],
  };
  await writeFile(
    path.join(policyCheckout, 'context.json'),
    JSON.stringify(policyDocument, null, 2) + '\n',
  );
  await git(policyCheckout, 'add', 'context.json');
  await git(policyCheckout, 'commit', '-m', 'Record retry policy');
  await git(policyCheckout, 'push', 'origin', 'HEAD:refs/heads/main');
  const policyCommit = await git(policyCheckout, 'rev-parse', 'HEAD');
  await api('/repositories/policy/refresh', { request_id: 'browser-policy-refresh' });
  const contextState = await api('/native-state');
  const applicationSystem = contextState.systems.find(
    (system) => system.repository_ids.length === 1 && system.repository_ids[0] === 'app',
  );
  const { objective } = await api('/objectives', {
    system_id: applicationSystem.id,
    statement: 'Apply retry policy',
    scope: ['app.mjs'],
    request_id: 'browser-retry-objective',
  });
  const futureCountBeforeContext = contextState.futures.length;
  await authenticate(page, url);
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  const objectiveCard = page
    .getByRole('region', { name: 'Objectives', exact: true })
    .locator('[data-slot="card"]')
    .filter({
      has: page.getByRole('heading', { name: 'Apply retry policy', exact: true }),
    });
  await objectiveCard.getByRole('button', { name: 'Prepare context', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Context before work', exact: true });
  await dialog.getByRole('button', { name: 'Add context file', exact: true }).click();
  await dialog.getByLabel('Repository for source 1', { exact: true }).selectOption('policy');
  await dialog.getByLabel('Path for source 1', { exact: true }).fill('context.json');
  const prepared = waitForMutation(page, '/objectives/' + objective.id + '/context');
  await dialog.getByRole('button', { name: 'Retrieve context', exact: true }).click();
  const preparedResponse = await prepared;
  assert.equal(preparedResponse.status(), 200, await preparedResponse.text());
  const { preparation } = await preparedResponse.json();
  assert.equal(
    preparation.questions.length,
    1,
    'Only the declared material ambiguity should become a question',
  );
  assert.equal(preparation.sources[0].repo_id, 'policy');
  assert.equal(preparation.sources[0].commit, policyCommit);
  await dialog.getByLabel('May a failed request be retried?', { exact: true }).waitFor();
  assert.equal(
    (await api('/native-state')).futures.length,
    futureCountBeforeContext,
    'Preparing context must not start work before the answer',
  );
  await dialog.getByLabel('May a failed request be retried?', { exact: true }).selectOption('once');
  const answered = waitForMutation(page, '/context/' + preparation.id + '/resolve');
  await dialog.getByRole('button', { name: 'Record answers', exact: true }).click();
  const answeredResponse = await answered;
  assert.equal(answeredResponse.status(), 200, await answeredResponse.text());
  const { snapshot } = await answeredResponse.json();
  assert.equal(snapshot.resolutions.length, 1);
  assert.equal(snapshot.resolutions[0].basis, 'declared');
  assert.equal(snapshot.resolutions[0].value.option_id, 'once');
  assert.deepEqual(snapshot.assumption_refs, []);
  dialog = page.getByRole('dialog', { name: 'Fork repositories', exact: true });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByLabel('Objective (optional)', { exact: true }).inputValue(),
    objective.id,
  );
  assert.equal(await dialog.getByLabel('Objective (optional)', { exact: true }).isDisabled(), true);
  const contextFutureCreated = waitForMutation(page, '/futures');
  await dialog.getByRole('button', { name: 'Fork repositories', exact: true }).click();
  const contextFutureResponse = await contextFutureCreated;
  assert.equal(contextFutureResponse.status(), 200, await contextFutureResponse.text());
  const contextFuture = await contextFutureResponse.json();
  assert.equal(contextFuture.future.objective_id, objective.id);
  assert.equal(contextFuture.future.context_snapshot_id, snapshot.id);
  assert.equal(contextFuture.revision.context_snapshot, snapshot.id);
  assert.equal(contextFuture.revision.context_binding_state, 'bound');
  await dialog.waitFor({ state: 'hidden' });
  const contextGraph = await api('/provenance/revision/' + contextFuture.revision.id);
  assert.ok(contextGraph.records.some((record) => record.id === snapshot.id));
  assert.ok(
    contextGraph.records.some(
      (record) => record.id === snapshot.resolutions[0].id && record.basis === 'declared',
    ),
  );
  assert.equal(
    (await api('/native-state')).repositories.find((entry) => entry.id === 'app').head,
    promotedHead,
  );
  await assertFitsViewport(page);
  assert.deepEqual(pageErrors, [], 'Context workflow must not throw browser errors');
  assert.deepEqual(
    accessibilityWarnings,
    [],
    'Context and Future dialogs must use accessible titles and descriptions',
  );
  await capture('context-desktop');

  console.log(
    'Browser workflow passed: authenticated repository creation, exact-state source/raw/history browsing and permalinks, ordinary Git push, isolated Future, immutable revision history, selected-commit composition, untrusted validation blocking, admitted CI and reviewed Git promotion, rewind, branch/tag selection, structured provenance, historical object retention, cross-repo context and one declared answer before forking, keyboard focus, mobile layout.',
  );
} catch (error) {
  console.error(serverOutput);
  console.error('Browser errors:', pageErrors);
  if (page) console.error('Open dialogs:', await page.getByRole('dialog').allTextContents());
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  // Every fixture and checkout lives under this unique test root.
  await rm(root, { recursive: true, force: true });
}
