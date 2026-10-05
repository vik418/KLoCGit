// Exercise native Git events and canonical transitions against a real account.
// Run `node scripts/cloudflare-live.mjs preflight` before any provisioning.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent());
const exec = promisify(execFile),
  root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'preflight';
const required = (name) => {
  if (!process.env[name]) throw new Error(`MISSING_CONFIGURATION:${name}`);
  return process.env[name];
};
const report = {
  version: 0,
  mode,
  started_at: new Date().toISOString(),
  live: true,
  checks: [],
  resources: [],
};
const reportPath =
  process.env.LIVE_REPORT_PATH ??
  path.join(root, '.klocgit-workspace', 'live-cloudflare-report.json');
const emit = (entry) => {
  report.checks.push(entry);
  console.log(JSON.stringify(entry));
};
async function command(file, args, options = {}) {
  try {
    return await exec(file, args, {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120000,
      ...options,
    });
  } catch (e) {
    throw new Error(`COMMAND_FAILED:${file}:${e.code ?? 'unknown'}`);
  }
}
async function readiness() {
  let authenticated = false;
  try {
    const { stdout } = await command(path.join(root, 'node_modules', '.bin', 'wrangler'), [
      'whoami',
    ]);
    authenticated = !/not authenticated/i.test(stdout) && /Account ID/i.test(stdout);
  } catch {}
  const result = {
    name: 'cloudflare-authentication',
    passed: authenticated,
    credential_variable_names: Object.keys(process.env).filter((k) =>
      /^(CLOUDFLARE_|CF_|ARTIFACTS_|GIT_BRIDGE_TOKEN|AUTH_TOKEN|INGEST_TOKEN|LIVE_TEST_TOKEN)/.test(
        k,
      ),
    ),
    reason: authenticated ? undefined : 'Wrangler did not establish an authenticated account.',
  };
  emit(result);
  return authenticated;
}
async function manifest() {
  const filename = process.argv[3];
  if (!filename) throw new Error('A non-secret deployment manifest path is required.');
  const m = JSON.parse(await readFile(filename, 'utf8'));
  if (!Array.isArray(m.repositories) || m.repositories.length < 2)
    throw new Error('Manifest must name at least two repositories.');
  for (const r of m.repositories) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(r.name ?? ''))
      throw new Error('INVALID_REPOSITORY_NAME');
    if (r.remote) {
      const u = new URL(r.remote);
      if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        !u.hostname.endsWith('.artifacts.cloudflare.net')
      )
        throw new Error('INVALID_ARTIFACTS_REMOTE');
    }
  }
  if (m.url) {
    const u = new URL(m.url);
    if (u.protocol !== 'https:' || u.username || u.password) throw new Error('INVALID_WORKER_URL');
  }
  return m;
}
async function cf(m, route, method = 'GET', body) {
  const account = m.account_id ?? required('CLOUDFLARE_ACCOUNT_ID');
  if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('INVALID_ACCOUNT_ID');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${route}`, {
    method,
    headers: {
      Authorization: 'Bearer ' + required('CLOUDFLARE_API_TOKEN'),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    const e = new Error(
      `CLOUDFLARE_API_FAILED:${response.status}:${data.errors?.map((e) => e.code).join(',') ?? 'unknown'}`,
    );
    e.status = response.status;
    throw e;
  }
  return data.result;
}
async function provisionEvents(m) {
  // Authentication + API account selection are checked before the first mutation.
  if (!(await readiness())) throw new Error('CLOUDFLARE_NOT_AUTHENTICATED');
  required('CLOUDFLARE_API_TOKEN');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(m.namespace ?? '') ||
    !/^[A-Za-z0-9_-]+$/.test(m.queue ?? '')
  )
    throw new Error('INVALID_RESOURCE_NAMES');
  await cf(m, '/workers/subdomain');
  const ns = '/artifacts/namespaces/' + encodeURIComponent(m.namespace);
  for (const repo of m.repositories) {
    let info;
    try {
      info = await cf(m, `${ns}/repos/${encodeURIComponent(repo.name)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      info = await cf(m, `${ns}/repos`, 'POST', {
        name: repo.name,
        default_branch: 'main',
        description: 'klocgit live acceptance repository',
      });
    }
    // Create returns a token. Deliberately retain only the public remote and name.
    report.resources.push({ type: 'artifacts-repository', name: repo.name, remote: info.remote });
  }
  const queues = await cf(m, '/queues?per_page=100');
  let queue = queues.find((q) => q.queue_name === m.queue);
  if (!queue) queue = await cf(m, '/queues', 'POST', { queue_name: m.queue });
  report.resources.push({ type: 'queue', name: m.queue, id: queue.queue_id });
  const list = await cf(
    m,
    `/event_subscriptions/subscriptions?queue_id=${encodeURIComponent(queue.queue_id)}&per_page=100`,
  );
  for (const repo of m.repositories) {
    const source = { type: 'artifacts.repo', namespace: m.namespace, repo_name: repo.name };
    let subscription = list.find(
      (s) =>
        s.enabled &&
        s.source?.type === source.type &&
        s.source.namespace === source.namespace &&
        s.source.repo_name === source.repo_name &&
        s.events?.includes('cf.artifacts.repo.pushed'),
    );
    if (!subscription)
      subscription = await cf(m, '/event_subscriptions/subscriptions', 'POST', {
        name: `${m.queue}:${repo.name}:push`,
        enabled: true,
        source,
        destination: { type: 'queues.queue', queue_id: queue.queue_id },
        events: ['cf.artifacts.repo.pushed'],
      });
    report.resources.push({
      type: 'native-push-subscription',
      repo: repo.name,
      id: subscription.id,
    });
  }
  emit({
    name: 'native-event-resources',
    passed: true,
    note: 'Control-plane resources exist. Event delivery and Worker/Container deployment are not established by this command.',
  });
}
async function api(m, route, body) {
  const response = await fetch(new URL(route, m.url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + required(m.ownerTokenEnv ?? 'AUTH_TOKEN'),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function workspace(m) {
  const result = await api(m, '/api/workspace');
  assert.equal(result.status, 200, 'Authenticated live workspace read failed');
  return result.data;
}
async function git(repo, cwd, args) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Bearer ' + required(repo.tokenEnv),
    GIT_AUTHOR_NAME: 'Live acceptance',
    GIT_AUTHOR_EMAIL: 'live-acceptance@klocgit.invalid',
    GIT_COMMITTER_NAME: 'Live acceptance',
    GIT_COMMITTER_EMAIL: 'live-acceptance@klocgit.invalid',
  };
  return (await command('git', args, { cwd, env })).stdout.trim();
}
async function clone(repo) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'klocgit-live-'));
  await git(repo, root, ['clone', '--quiet', repo.remote, dir]);
  return dir;
}
async function poll(fn, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error('LIVE_OBSERVATION_TIMEOUT');
}
function choice(component) {
  const alternative = component.alternatives.find(
    (a) => a.validation === 'passed' || a.validation?.passed === true,
  );
  if (!alternative) throw new Error('NO_VALIDATED_ALTERNATIVE');
  return {
    alternative_id: alternative.id,
    basis_hash: component.basis_hash,
    expected_canonical_head: component.canonical_head_seen,
    rationale: 'Live acceptance: select a currently passing composed candidate.',
  };
}
function operationsFor(workspace, componentId) {
  const ids = new Set(
    workspace.decisions.filter((d) => d.component_id === componentId).map((d) => d.id),
  );
  return workspace.operations.filter((o) => ids.has(o.decision_id));
}
async function verify(m) {
  if (!m.url) throw new Error('Manifest must specify the deployed Worker URL.');
  const repo = m.repositories.find((r) => r.name === m.test_repo) ?? m.repositories[0];
  if (!repo.remote || !repo.tokenEnv)
    throw new Error('Live test repository needs remote and tokenEnv.');
  required(repo.tokenEnv);
  required(m.ownerTokenEnv ?? 'AUTH_TOKEN');
  const temp = await clone(repo);
  try {
    const before = await workspace(m),
      oldHead = before.repositories.find((r) => r.id === repo.name)?.head;
    if (!oldHead) throw new Error('LIVE_REPOSITORY_NOT_REGISTERED');
    const branch = 'live-native-' + Date.now();
    await git(repo, temp, ['checkout', '--quiet', '-b', branch, oldHead]);
    await writeFile(
      path.join(temp, 'LIVE_ACCEPTANCE.md'),
      `Native Git producer acceptance ${branch}\n`,
    );
    await git(repo, temp, ['add', 'LIVE_ACCEPTANCE.md']);
    await git(repo, temp, ['commit', '--quiet', '-m', 'Native Git ingress acceptance']);
    const nativeHead = await git(repo, temp, ['rev-parse', 'HEAD']);
    await git(repo, temp, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
    const ingested = await poll(async () => {
      const w = await workspace(m);
      return w.revisions?.find((r) => r.head_commit === nativeHead) ? w : false;
    });
    emit({
      name: 'native-git-push-ingested',
      passed: true,
      repo: repo.name,
      ref: 'refs/heads/' + branch,
      commit: nativeHead,
      provenance: ingested.revisions.find((r) => r.head_commit === nativeHead).provenance_state,
      note: 'No POST /api/events or owner-created decision was used.',
    });
    const analyzed = await api(m, '/api/analysis', {});
    assert.ok(analyzed.status >= 200 && analyzed.status < 300, 'Live generic analysis failed');
    let current = await workspace(m);
    const component = current.decisionComponents.find(
      (c) => c.status === 'open' && c.alternatives.some((a) => a.repo === repo.name),
    );
    if (!component) throw new Error('NO_GENERATED_COMPONENT_FOR_LIVE_TEST');
    const reviewed = structuredClone(component),
      reviewedInput = choice(reviewed);
    await git(repo, temp, ['checkout', '--quiet', '--detach', reviewed.canonical_head_seen]);
    await git(repo, temp, [
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'External canonical Git client acceptance',
    ]);
    const external = await git(repo, temp, ['rev-parse', 'HEAD']);
    await git(repo, temp, [
      'push',
      '--quiet',
      `--force-with-lease=refs/heads/main:${reviewed.canonical_head_seen}`,
      'origin',
      'HEAD:refs/heads/main',
    ]);
    const stale = await api(m, `/api/decisions/${reviewed.id}/resolve`, reviewedInput);
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'DECISION_STALE');
    assert.equal(
      (await git(repo, temp, ['ls-remote', 'origin', 'refs/heads/main'])).split(/\s/)[0],
      external,
    );
    emit({
      name: 'stale-basis-and-external-push',
      passed: true,
      head: external,
      response: stale.status,
    });
    const refreshed = await api(m, `/api/decisions/${reviewed.id}/refresh`, {});
    assert.equal(refreshed.status, 200);
    current = await workspace(m);
    const ready = current.decisionComponents.find((c) => c.id === reviewed.id),
      input = choice(ready);
    const resolutions = await Promise.all([
      api(m, `/api/decisions/${ready.id}/resolve`, input),
      api(m, `/api/decisions/${ready.id}/resolve`, input),
    ]);
    assert.equal(resolutions.filter((r) => r.status >= 200 && r.status < 300).length, 1);
    assert.equal(resolutions.filter((r) => r.status === 409).length, 1);
    current = await workspace(m);
    const applied = operationsFor(current, ready.id).filter((o) => o.status === 'applied');
    assert.equal(applied.length, 1);
    assert.equal(
      (await git(repo, temp, ['ls-remote', 'origin', 'refs/heads/main'])).split(/\s/)[0],
      applied[0].target_commit,
    );
    emit({
      name: 'concurrent-resolution',
      passed: true,
      statuses: resolutions.map((r) => r.status),
      target: applied[0].target_commit,
    });
    await recovery(m);
    const final = await workspace(m);
    assert.equal(final.metrics.staleEvidenceAccepted, 0);
    await git(repo, temp, ['fetch', '--quiet', 'origin', 'refs/heads/main']);
    await git(repo, temp, ['fsck', '--full']);
    emit({
      name: 'ordinary-artifacts-git-integrity',
      passed: true,
      staleEvidenceAccepted: final.metrics.staleEvidenceAccepted,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
async function recovery(m) {
  if (!m.executorControlUrl || !process.env[m.testTokenEnv ?? 'LIVE_TEST_TOKEN'])
    throw new Error(
      'LIVE_RECOVERY_NOT_CONFIGURED: separate test gateway URL and credential required',
    );
  const control = async (route, body) => {
    const response = await fetch(new URL(route, m.executorControlUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + required(m.testTokenEnv ?? 'LIVE_TEST_TOKEN'),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    assert.equal(response.status, 200, 'Live test gateway control failed');
    return data;
  };
  const w = await workspace(m),
    c = w.decisionComponents.find((c) => c.status === 'open');
  if (!c) throw new Error('A second generated open component is required for recovery.');
  const refreshed = await api(m, `/api/decisions/${c.id}/refresh`, {});
  assert.equal(refreshed.status, 200);
  const current = (await workspace(m)).decisionComponents.find((x) => x.id === c.id),
    input = choice(current),
    a = current.alternatives.find((a) => a.id === input.alternative_id);
  await control('/control/arm', {
    kind: 'drop-cas-response-once',
    repo: a.repo,
    expected: current.canonical_head_seen,
  });
  const lost = await api(m, `/api/decisions/${c.id}/resolve`, input);
  assert.ok(lost.status >= 500, 'Expected an uncertain executor outcome');
  const receipt = (await control('/control/status')).receipt;
  assert.equal(receipt.updated, true, 'Real remote CAS did not succeed before response loss');
  await control('/control/restart', {});
  const recovered = await api(m, '/api/recover', {});
  assert.equal(recovered.status, 200);
  const final = await workspace(m),
    operation = operationsFor(final, c.id).find((o) => o.target_commit === receipt.target);
  assert.equal(operation?.status, 'applied');
  const repo = m.repositories.find((r) => r.name === a.repo);
  if (!repo?.tokenEnv)
    throw new Error('Recovery repository requires scoped Git credential in manifest.');
  assert.equal(
    (await git(repo, root, ['ls-remote', repo.remote, 'refs/heads/main'])).split(/\s/)[0],
    receipt.target,
  );
  emit({
    name: 'lost-cas-response-container-restart-recovery',
    passed: true,
    target: receipt.target,
    note: 'Real CAS, withheld response, container disk loss, and exact authoritative-ref recovery. Coordinator process kill is a separate untested failure window.',
  });
}

try {
  if (mode === 'preflight') {
    if (!(await readiness())) process.exitCode = 2;
  } else if (mode === 'provision-events') await provisionEvents(await manifest());
  else if (mode === 'verify') await verify(await manifest());
  else throw new Error('Use preflight, provision-events, or verify.');
  report.status = process.exitCode ? 'blocked' : 'passed';
} catch (e) {
  report.status = 'blocked';
  report.failure = e.message;
  emit({ name: mode, passed: false, reason: e.message });
  process.exitCode = 2;
} finally {
  report.completed_at = new Date().toISOString();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ report: reportPath, status: report.status }));
}
