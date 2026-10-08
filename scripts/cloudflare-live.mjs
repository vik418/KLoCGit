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

const invoked = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked && (process.env.HTTP_PROXY || process.env.HTTPS_PROXY)) setGlobalDispatcher(new EnvHttpProxyAgent());
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
  live: false,
  live_verified: false,
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
  validateLiveManifest(m, mode);
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
  report.live = true;
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

export const NATIVE_LIVE_CHECKS = [
  'native-future-git-push-ingested',
  'reviewed-evidence-basis-rejected',
  'external-git-push-invalidates-evidence',
  'native-concurrent-promotion',
  'native-lost-reply-cold-cache-recovery',
  'ordinary-native-artifacts-git-integrity',
];

/** A control-plane success or a partial run is never full live acceptance. */
export function liveAcceptancePassed(value, requiredChecks = NATIVE_LIVE_CHECKS) {
  return value.mode === 'check' && value.live === true && value.status === 'passed' &&
    requiredChecks.every((name) => value.checks.some((check) => check.name === name && check.passed === true));
}

export function validateLiveManifest(m, operation, env = process.env) {
  const account = m.account_id ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[a-f0-9]{32}$/i.test(account ?? '')) throw new Error('INVALID_ACCOUNT_ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(m.namespace ?? ''))
    throw new Error('INVALID_ARTIFACTS_NAMESPACE');
  if (!Array.isArray(m.repositories) || m.repositories.length < 2 ||
      new Set(m.repositories.map((repo) => repo.name)).size !== m.repositories.length)
    throw new Error('LIVE_TWO_UNIQUE_REPOSITORIES_REQUIRED');
  for (const repo of m.repositories) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo.name ?? ''))
      throw new Error('INVALID_REPOSITORY_NAME');
    if (repo.remote) {
      const remote = new URL(repo.remote);
      if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search ||
          remote.hash || remote.port || remote.hostname !== account + '.artifacts.cloudflare.net' ||
          remote.pathname !== '/git/' + m.namespace + '/' + repo.name + '.git')
        throw new Error('INVALID_ARTIFACTS_REMOTE');
    }
    if (repo.tokenEnv && !/^[A-Z][A-Z0-9_]*$/.test(repo.tokenEnv))
      throw new Error('INVALID_CREDENTIAL_VARIABLE_NAME');
  }
  for (const value of [m.url, m.executorControlUrl].filter(Boolean)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('INVALID_WORKER_URL');
  }
  if (['check', 'verify'].includes(operation) && (m.allowCanonicalMutation !== true ||
      m.repositories.some((repo) => repo.disposable !== true)))
    throw new Error('LIVE_DISPOSABLE_FIXTURES_REQUIRED');
  if (operation === 'check' && (!m.url || !m.executorControlUrl || !m.queue))
    throw new Error('LIVE_NATIVE_CONFIGURATION_REQUIRED');
  for (const name of [m.ownerTokenEnv, m.testTokenEnv].filter(Boolean))
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('INVALID_CREDENTIAL_VARIABLE_NAME');
  return m;
}

export function nativePromotionInput(review, requestId) {
  if (!review?.validation_passing || !review.sources_current || !review.heads_current ||
      !review.promotion_supported || typeof review.decision_basis_hash !== 'string')
    throw new Error('LIVE_CANDIDATE_NOT_PROMOTABLE');
  return {
    request_id: requestId,
    decision_basis_hash: review.decision_basis_hash,
    expected_heads: structuredClone(review.expected_heads),
    rationale: 'Live acceptance: apply the exact currently validated candidate.',
  };
}

async function nativeState(m) {
  const result = await api(m, '/api/native-state');
  assert.equal(result.status, 200, 'Authenticated native state read failed');
  report.live = true;
  return result.data;
}

async function success(m, route, body) {
  const result = await api(m, route, body);
  if (result.status < 200 || result.status >= 300)
    throw new Error('LIVE_API_FAILED:' + route.split('/')[2] + ':' + result.status + ':' +
      (typeof result.data.error === 'string' && /^[A-Z_]{1,80}$/.test(result.data.error) ? result.data.error : 'unknown'));
  return result.data;
}

async function nativeCheck(m) {
  validateLiveManifest(m, 'check');
  required('CLOUDFLARE_API_TOKEN');
  required(m.ownerTokenEnv ?? 'AUTH_TOKEN');
  required(m.testTokenEnv ?? 'LIVE_TEST_TOKEN');
  const runId = 'live-' + Date.now();
  const requestId = (step) => runId + '-' + step;
  const tokens = [], clones = [];
  const namespace = '/artifacts/namespaces/' + encodeURIComponent(m.namespace);
  const initial = await nativeState(m);
  if (initial.promotions.some((entry) => ['prepared', 'recovery-required'].includes(entry.status)))
    throw new Error('LIVE_WORKSPACE_RECOVERY_REQUIRED');
  const repositories = m.repositories.map((entry) => {
    const actual = initial.repositories.find((repo) => repo.id === entry.name && repo.status === 'ready');
    if (!actual || actual.remote !== entry.remote || !actual.head)
      throw new Error('LIVE_REPOSITORY_NOT_READY:' + entry.name);
    required(entry.tokenEnv);
    return { ...entry, ref: actual.canonical_ref };
  });
  const primary = repositories.find((repo) => repo.name === m.test_repo) ?? repositories[0];
  const queue = (await cf(m, '/queues?per_page=100')).find((entry) => entry.queue_name === m.queue);
  if (!queue) throw new Error('LIVE_QUEUE_NOT_FOUND');
  const system = (await success(m, '/api/systems', {
    name: runId, repository_ids: repositories.map((repo) => repo.name), request_id: requestId('system'),
  })).system;
  const objective = (await success(m, '/api/objectives', {
    system_id: system.id, statement: 'Verify native concurrent Git and exact reviewed canonical advancement.',
    request_id: requestId('objective'),
  })).objective;
  report.resources.push({ type: 'native-system', id: system.id }, { type: 'native-objective', id: objective.id });

  const control = async (route, body) => {
    const response = await fetch(new URL(route, m.executorControlUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + required(m.testTokenEnv ?? 'LIVE_TEST_TOKEN'),
        'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, 'Separate live test control failed');
    return response.json();
  };

  async function subscribe(repoId) {
    const subscriptions = await cf(m, '/event_subscriptions/subscriptions?queue_id=' + queue.queue_id + '&per_page=100');
    const existing = subscriptions.find((entry) => entry.enabled &&
      entry.source?.type === 'artifacts.repo' && entry.source.namespace === m.namespace &&
      entry.source.repo_name === repoId && entry.events?.includes('cf.artifacts.repo.pushed'));
    if (existing) return;
    const created = await cf(m, '/event_subscriptions/subscriptions', 'POST', {
      name: (runId + ':' + repoId).slice(0, 100), enabled: true,
      source: { type: 'artifacts.repo', namespace: m.namespace, repo_name: repoId },
      destination: { type: 'queues.queue', queue_id: queue.queue_id },
      events: ['cf.artifacts.repo.pushed'],
    });
    report.resources.push({ type: 'fixture-native-push-subscription', repo: repoId, id: created.id });
  }

  async function producerToken(repository) {
    const token = await cf(m, namespace + '/tokens', 'POST', {
      repo: repository.repo_id, scope: 'write', ttl: 900,
    });
    tokens.push(token);
    const expiry = Date.parse(token.expires_at);
    if (token.scope !== 'write' || typeof token.plaintext !== 'string' || !token.plaintext ||
        /[\r\n\0]/.test(token.plaintext) || !Number.isFinite(expiry) ||
        expiry <= Date.now() || expiry > Date.now() + 930000)
      throw new Error('LIVE_PRODUCER_CREDENTIAL_INVALID');
    return { remote: repository.remote, token: token.plaintext };
  }

  async function producerGit(repository, cwd, args) {
    const credential = repository.token ?? required(repository.tokenEnv);
    const transport = Object.fromEntries([
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy',
      'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO',
    ].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    const env = {
      ...transport, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8',
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer ' + credential,
      GIT_AUTHOR_NAME: 'Live acceptance', GIT_AUTHOR_EMAIL: 'live-acceptance@klocgit.invalid',
      GIT_COMMITTER_NAME: 'Live acceptance', GIT_COMMITTER_EMAIL: 'live-acceptance@klocgit.invalid',
    };
    return (await command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=',
      '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgSign=false', ...args], { cwd, env })).stdout.trim();
  }

  async function nativeWork(label) {
    const created = await success(m, '/api/futures', {
      objective_id: objective.id, name: runId + '-' + label,
      producer: { kind: 'unknown' }, request_id: requestId('future-' + label),
    });
    const futureId = created.future.id;
    report.resources.push({ type: 'native-future', id: futureId });
    let current = created.future;
    if (current.status === 'preparing') {
      current = await poll(async () => {
        const read = await success(m, '/api/futures/' + futureId);
        const result = await api(m, '/api/futures/' + futureId + '/observe', {
          expected_version: read.future.version, request_id: requestId('ready-' + label + '-' + Date.now()),
        });
        if (result.status === 409 && result.data.error === 'FUTURE_NOT_READY') return false;
        if (result.status !== 200) throw new Error('LIVE_FUTURE_READINESS_FAILED:' + result.status);
        return result.data.future.status === 'active' ? result.data.future : false;
      }, 120000);
    }
    assert.equal(current.status, 'active');
    assert.equal(current.provenance_state, 'unknown');
    for (const repository of current.repositories) await subscribe(repository.repo_id);
    const fork = current.repositories.find((repo) => repo.canonical_repo_id === primary.name);
    assert.ok(fork?.remote, 'Native Future must expose an ordinary scoped Git remote');
    const producer = await producerToken(fork);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'klocgit-native-live-'));
    clones.push(directory);
    await producerGit(producer, root, ['clone', '--quiet', producer.remote, directory]);
    await producerGit(producer, directory, ['checkout', '--quiet', primary.ref.slice(11)]);
    const filename = 'LIVE_ACCEPTANCE_' + runId + '_' + label + '.md';
    await writeFile(path.join(directory, filename), 'Native producer acceptance ' + runId + ' ' + label + '\n');
    await producerGit(producer, directory, ['add', filename]);
    await producerGit(producer, directory, ['commit', '--quiet', '-m', 'Ordinary Git producer without provenance']);
    const head = await producerGit(producer, directory, ['rev-parse', 'HEAD']);
    await producerGit(producer, directory, ['push', '--quiet', 'origin', 'HEAD:' + fork.ref]);
    // No explicit observe, owner ingress or synthetic event follows this push.
    const observed = await poll(async () => {
      const state = await nativeState(m);
      const revision = state.futureRevisions.find((entry) => entry.future_id === futureId &&
        entry.repository_heads.some((repo) => repo.source_repo_id === fork.repo_id && repo.commit === head));
      return revision ? { state, revision } : false;
    }, 120000);
    const selected = await success(m, '/api/selections', {
      future_revision_id: observed.revision.id, kind: 'future', request_id: requestId('selection-' + label),
    });
    assert.equal(observed.revision.provenance_state, 'unknown');
    return { futureId, revision: observed.revision, selectionId: selected.selection.id, producer, directory, head };
  }

  async function candidate(selectionId, label) {
    const created = await success(m, '/api/candidates', {
      selection_ids: [selectionId], request_id: requestId('candidate-' + label),
    });
    const id = created.candidate.id;
    const validation = await success(m, '/api/candidates/' + id + '/validate', {
      request_id: requestId('validate-' + label),
    });
    assert.ok(validation.evidence.length, 'Trusted exact-tree evidence is required');
    const review = await success(m, '/api/candidates/' + id + '/review');
    nativePromotionInput(review, requestId('review-' + label));
    return { id, review };
  }

  const canonicalHead = async (directory) =>
    (await producerGit(primary, directory, ['ls-remote', primary.remote, primary.ref])).split(/\s/)[0];

  try {
    // Fail before touching canonical refs unless the separate, explicitly enabled fault gate exists.
    await control('/control/status');
    const work = await nativeWork('first');
    emit({ name: NATIVE_LIVE_CHECKS[0], passed: true, future_id: work.futureId,
      revision_id: work.revision.id, head: work.head, provenance: 'unknown',
      note: 'Actual Artifacts Git push → native push subscription → Queue → Worker → durable Future revision. No POST /events or post-push observe.' });
    const first = await candidate(work.selectionId, 'first');
    const reviewed = nativePromotionInput(first.review, requestId('old-evidence'));
    const originalHead = await canonicalHead(work.directory);
    await success(m, '/api/candidates/' + first.id + '/validate', { request_id: requestId('new-evidence') });
    const newReview = await success(m, '/api/candidates/' + first.id + '/review');
    assert.equal(await canonicalHead(work.directory), originalHead);
    assert.notEqual(newReview.decision_basis_hash, first.review.decision_basis_hash);
    const oldEvidence = await api(m, '/api/candidates/' + first.id + '/promote', reviewed);
    assert.equal(oldEvidence.status, 409);
    assert.equal(oldEvidence.data.error, 'DECISION_STALE');
    assert.equal(await canonicalHead(work.directory), originalHead);
    emit({ name: NATIVE_LIVE_CHECKS[1], passed: true, canonical_head: originalHead,
      response: oldEvidence.status, note: 'New exact-tree evidence changes reviewed basis while Git head stays identical.' });

    await producerGit(primary, work.directory, ['fetch', '--quiet', primary.remote, primary.ref]);
    await producerGit(primary, work.directory, ['checkout', '--quiet', '--detach', newReview.expected_heads[primary.name]]);
    await producerGit(primary, work.directory, ['commit', '--quiet', '--allow-empty', '-m', 'External canonical Git client']);
    const external = await producerGit(primary, work.directory, ['rev-parse', 'HEAD']);
    await producerGit(primary, work.directory, ['push', '--quiet',
      '--force-with-lease=' + primary.ref + ':' + newReview.expected_heads[primary.name],
      primary.remote, 'HEAD:' + primary.ref]);
    const stale = await api(m, '/api/candidates/' + first.id + '/promote',
      nativePromotionInput(newReview, requestId('external-stale')));
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'DECISION_STALE');
    assert.equal(await canonicalHead(work.directory), external);
    const staleReview = await success(m, '/api/candidates/' + first.id + '/review');
    assert.equal(staleReview.heads_current, false);
    assert.ok(staleReview.evidence.every((entry) => entry && entry.validity.status !== 'current'));
    emit({ name: NATIVE_LIVE_CHECKS[2], passed: true, external_head: external,
      stale_evidence_ids: staleReview.evidence.map((entry) => entry.id), response: stale.status });

    const fresh = await candidate(work.selectionId, 'fresh');
    const attempts = await Promise.all([
      api(m, '/api/candidates/' + fresh.id + '/promote', nativePromotionInput(fresh.review, requestId('concurrent-a'))),
      api(m, '/api/candidates/' + fresh.id + '/promote', nativePromotionInput(fresh.review, requestId('concurrent-b'))),
    ]);
    assert.equal(attempts.filter((entry) => entry.status >= 200 && entry.status < 300).length, 1);
    assert.equal(attempts.filter((entry) => entry.status === 409).length, 1);
    const state = await nativeState(m);
    const applied = state.promotions.filter((entry) => entry.candidate_id === fresh.id && entry.status === 'applied');
    assert.equal(applied.length, 1);
    assert.equal(await canonicalHead(work.directory), applied[0].target_commit);
    emit({ name: NATIVE_LIVE_CHECKS[3], passed: true, statuses: attempts.map((entry) => entry.status),
      operation_id: applied[0].id, target: applied[0].target_commit });

    const recoveryWork = await nativeWork('recovery');
    const recoverable = await candidate(recoveryWork.selectionId, 'recoverable');
    const expected = recoverable.review.expected_heads[primary.name];
    await control('/control/arm', { kind: 'drop-cas-response-once', repo: primary.name, expected });
    const lost = await api(m, '/api/candidates/' + recoverable.id + '/promote',
      nativePromotionInput(recoverable.review, requestId('lost-reply')));
    assert.ok(lost.status >= 500, 'Withheld real successful CAS must remain uncertain');
    const receipt = (await control('/control/status')).receipt;
    assert.equal(receipt.updated, true);
    assert.equal(receipt.repo, primary.name);
    assert.equal(receipt.expected, expected);
    assert.equal(await canonicalHead(recoveryWork.directory), receipt.target);
    await control('/control/restart', {});
    await success(m, '/api/recover', {});
    const recovered = (await nativeState(m)).promotions.find((entry) =>
      entry.candidate_id === recoverable.id && entry.target_commit === receipt.target);
    assert.equal(recovered?.status, 'applied');
    // Re-running trusted validation forces the cold executor to fetch retained objects.
    await success(m, '/api/candidates/' + recoverable.id + '/validate', {
      request_id: requestId('cold-cache-validate'),
    });
    assert.equal(await canonicalHead(recoveryWork.directory), receipt.target);
    emit({ name: NATIVE_LIVE_CHECKS[4], passed: true, operation_id: recovered.id,
      target: receipt.target, note: 'Real remote CAS, deliberately lost acknowledgement, Container disk destruction, authoritative-ref recovery and trusted cold-cache validation. Coordinator process kill remains separately untested.' });

    const final = await workspace(m);
    assert.equal(final.metrics.staleEvidenceAccepted, 0);
    await producerGit(primary, recoveryWork.directory, ['fetch', '--quiet', primary.remote, primary.ref]);
    await producerGit(primary, recoveryWork.directory, ['fsck', '--full']);
    emit({ name: NATIVE_LIVE_CHECKS[5], passed: true, staleEvidenceAccepted: 0,
      canonical_head: await canonicalHead(recoveryWork.directory) });
  } finally {
    for (const token of tokens) {
      try { await cf(m, namespace + '/tokens/' + encodeURIComponent(token.id), 'DELETE'); } catch {}
    }
    for (const directory of clones) await rm(directory, { recursive: true, force: true });
  }
}

if (invoked) {
  try {
    if (mode === 'preflight') {
      if (!(await readiness())) process.exitCode = 2;
    } else if (mode === 'provision-events') await provisionEvents(await manifest());
    else if (mode === 'verify') await verify(await manifest());
    else if (mode === 'check') await nativeCheck(await manifest());
    else throw new Error('Use preflight, provision-events, verify, or check.');
    report.status = process.exitCode ? 'blocked' : 'passed';
  } catch (error) {
    report.status = 'blocked';
    report.failure = error.message;
    emit({ name: mode, passed: false, reason: error.message });
    process.exitCode = 2;
  } finally {
    report.live_verified = liveAcceptancePassed(report);
    report.completed_at = new Date().toISOString();
    report.limitations = [
      'Dry runs and resource provisioning do not establish live acceptance.',
      'Fixture subscriptions are provisioned by this harness; automatic product subscription lifecycle is not established.',
      'Coordinator process termination and cross-repository atomic promotion are not tested.',
      'Passing checks establish their stated code and environment scope only.',
    ];
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ report: reportPath, status: report.status, live_verified: report.live_verified }));
  }
}
