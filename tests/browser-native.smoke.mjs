/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'klocgit-browser-'));
const workspaceRoot = path.join(root, 'workspace');
const credential = 'ui-check';
let server;
let browser;
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
  await page.getByRole('button', { name: 'Systems', exact: true }).waitFor();
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
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
    'rgb(11, 13, 16)',
  );
  await assertFitsViewport(page);

  await page.getByRole('button', { name: 'Systems', exact: true }).click();
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

  await page.getByRole('button', { name: 'Open isolated work', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: 'Open isolated work', exact: true });
  await dialog.waitFor();
  const choice = dialog.getByRole('checkbox', { name: 'app', exact: true });
  if (!(await choice.isChecked())) await choice.check();
  const futureCreated = waitForMutation(page, '/futures');
  await dialog.getByRole('button', { name: 'Create future', exact: true }).click();
  const futureResponse = await futureCreated;
  assert.equal(futureResponse.status(), 200);
  const { future } = await futureResponse.json();
  assert.equal(future.repositories.length, 1);
  assert.equal(future.baseline_refs[0].commit, baselineCommit);
  assert.equal(future.status, 'active');
  await dialog.waitFor({ state: 'hidden' });

  // System and Objective metadata are optional at entry, not additional forms.
  let native = await api('/native-state');
  assert.equal(native.systems.length, 1);
  assert.equal(native.objectives.length, 1);
  assert.equal(native.futureRevisions.length, 1);
  const firstRevision = native.futureRevisions[0];
  assert.equal(firstRevision.provenance_state, 'unknown');
  assert.equal(firstRevision.repository_heads[0].commit, baselineCommit);

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
  assert.equal(validation.evidence[0].result.passed, false, 'Unknown repositories have no trusted validation profile');
  await dialog.getByText('Checks did not pass', { exact: true }).waitFor();
  await dialog.getByLabel('Why choose this candidate?', { exact: true }).fill('Review selected work.');
  assert.equal(await dialog.getByRole('button', { name: 'Apply candidate', exact: true }).isDisabled(), true);
  assert.equal((await api('/native-state')).repositories.find((entry) => entry.id === 'app').head, baselineCommit);
  await assertFitsViewport(page);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
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

  // A System can contain repositories whose current Git state is not ready.
  await api('/repositories', { id: 'empty-member', request_id: 'empty-member' });
  await api('/systems', {
    name: 'Mixed readiness',
    repository_ids: ['app', 'empty-member'],
    request_id: 'mixed-system',
  });
  await authenticate(page, url);
  await page.getByRole('button', { name: 'Systems', exact: true }).click();
  const systemCard = page.locator('[data-slot="card"]').filter({
    has: page.getByRole('heading', { name: 'Mixed readiness', exact: true }),
  });
  const systemWork = systemCard.getByRole('button', { name: 'Open isolated work', exact: true });
  await systemWork.click();
  dialog = page.getByRole('dialog', { name: 'Open isolated work', exact: true });
  assert.equal(await dialog.getByRole('checkbox', { name: 'app', exact: true }).isChecked(), true);
  const unready = dialog.getByRole('checkbox', { name: /empty-member/ });
  assert.equal(await unready.isChecked(), false);
  assert.equal(await unready.isDisabled(), true);
  assert.equal(
    await dialog.getByRole('button', { name: 'Create future', exact: true }).isEnabled(),
    true,
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, systemWork);

  // Exercise responsive layout and Radix dismissal on the same real state.
  await page.setViewportSize({ width: 390, height: 844 });
  await assertFitsViewport(page);
  await page.getByRole('button', { name: 'Systems', exact: true }).click();
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
  console.log(
    'Browser workflow passed: authenticated repository creation, ordinary Git push, isolated Future, immutable revision history, selected-commit composition, untrusted validation blocking, rewind, keyboard focus, mobile layout.',
  );
} catch (error) {
  console.error(serverOutput);
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  // Every fixture and checkout lives under this unique test root.
  await rm(root, { recursive: true, force: true });
}
