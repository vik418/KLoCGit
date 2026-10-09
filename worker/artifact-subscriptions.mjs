import { artifactRemote } from '../server/source-authority.mjs';
import { DomainError } from '../core/hash.mjs';
import { repositoryDescriptionOperation, repositoryRef } from '../core/repository-input.mjs';

const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const identifier = /^[a-f0-9]{32}$/i;
const pushed = 'cf.artifacts.repo.pushed';
const route = '/event_subscriptions/subscriptions';

function unavailable(code = 'EVENT_SUBSCRIPTION_UNAVAILABLE') {
  return new DomainError(code, 'Repository push subscriptions require operator configuration or reconciliation', 503);
}

/** Manage repository-scoped push delivery; credentials never enter coordination records. */
export class ArtifactSubscriptions {
  #env;
  #fetch;
  constructor(env, fetcher = globalThis.fetch) {
    this.#env = env;
    this.#fetch = fetcher;
  }

  preflight() {
    const env = this.#env;
    const missing = [];
    if (!identifier.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) missing.push('CLOUDFLARE_ACCOUNT_ID');
    if (!identifier.test(env.ARTIFACTS_EVENTS_QUEUE_ID ?? '')) missing.push('ARTIFACTS_EVENTS_QUEUE_ID');
    if (!name.test(env.ARTIFACTS_NAMESPACE ?? '')) missing.push('ARTIFACTS_NAMESPACE');
    if (typeof env.ARTIFACTS_SUBSCRIPTION_TOKEN !== 'string' ||
        env.ARTIFACTS_SUBSCRIPTION_TOKEN.length < 16 ||
        env.ARTIFACTS_SUBSCRIPTION_TOKEN.length > 8192 ||
        /\s/.test(env.ARTIFACTS_SUBSCRIPTION_TOKEN)) missing.push('ARTIFACTS_SUBSCRIPTION_TOKEN');
    if (missing.length)
      throw new DomainError('EVENT_SUBSCRIPTION_NOT_CONFIGURED',
        'Configure ' + missing.join(', ') + ' before creating repositories', 503, { missing });
    return { account_id: env.CLOUDFLARE_ACCOUNT_ID, namespace: env.ARTIFACTS_NAMESPACE,
      queue_id: env.ARTIFACTS_EVENTS_QUEUE_ID };
  }

  async authorize(input) {
    if (!name.test(input.id ?? '') || !/^request_[a-f0-9]{64}$/.test(input.operation_id ?? '') ||
        (input.repository_operation_id !== null &&
         !/^request_[a-f0-9]{64}$/.test(input.repository_operation_id ?? '')))
      throw new DomainError('INVALID_SUBSCRIPTION_INPUT', 'A journaled repository identity is required', 422);
    repositoryRef(input.ref);
    let capability, info;
    try {
      capability = await this.#env.ARTIFACTS.get(input.id);
      info = await capability.info();
    } catch {
      throw unavailable();
    } finally {
      capability?.[Symbol.dispose]?.();
    }
    const config = this.preflight();
    const remote = artifactRemote(info.remote, input.id);
    if (remote.namespace !== config.namespace ||
        remote.origin !== 'https://' + config.account_id + '.artifacts.cloudflare.net')
      throw new DomainError('SUBSCRIPTION_SCOPE_MISMATCH', 'Repository storage differs from the configured event account or namespace', 409);
    if (repositoryDescriptionOperation(info.description) !== input.repository_operation_id)
      throw new DomainError('RECOVERY_REQUIRED', 'Repository ownership changed before subscription', 409);
  }

  async api(config, suffix = '', method = 'GET', body) {
    try {
      const response = await this.#fetch(
        'https://api.cloudflare.com/client/v4/accounts/' + config.account_id + route + suffix,
        { method, redirect: 'error',
          headers: { Authorization: 'Bearer ' + this.#env.ARTIFACTS_SUBSCRIPTION_TOKEN,
            'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw unavailable();
      const raw = await response.text();
      if (raw.length > 512000) throw unavailable('EVENT_SUBSCRIPTION_BUDGET');
      const data = JSON.parse(raw);
      if (data.success !== true || data.result === undefined) throw unavailable();
      return data;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw unavailable();
    }
  }

  matches(value, config, id) {
    return value?.enabled === true && typeof value.id === 'string' && value.id.length <= 200 &&
      value.source?.type === 'artifacts.repo' && value.source.namespace === config.namespace &&
      value.source.repo_name === id && value.destination?.type === 'queues.queue' &&
      value.destination.queue_id === config.queue_id && Array.isArray(value.events) &&
      value.events.includes(pushed);
  }

  async find(config, id) {
    // Bound control-plane scans explicitly. Queue sharding is required beyond this limit.
    for (let page = 1; page <= 10; page++) {
      const data = await this.api(config,
        '?queue_id=' + config.queue_id + '&per_page=100&page=' + page);
      if (!Array.isArray(data.result)) throw unavailable();
      const match = data.result.filter((value) => this.matches(value, config, id))
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (match) return match;
      const pages = data.result_info?.total_pages;
      if (Number.isInteger(pages) ? page >= pages : data.result.length < 100) return null;
    }
    throw unavailable('EVENT_SUBSCRIPTION_BUDGET');
  }

  async receipt(config, input, subscription) {
    const data = await this.api(config, '/' + encodeURIComponent(subscription.id));
    if (!this.matches(data.result, config, input.id)) throw unavailable();
    return { repo_id: input.id, status: 'ready', subscription_id: data.result.id,
      namespace: config.namespace, queue_id: config.queue_id, basis: 'observed' };
  }

  async ensure(input) {
    const config = this.preflight();
    await this.authorize(input);
    let subscription = await this.find(config, input.id);
    if (!subscription) {
      const created = await this.api(config, '', 'POST', {
        name: ('klocgit:' + config.namespace + ':' + input.id).slice(0, 100),
        enabled: true, source: { type: 'artifacts.repo', namespace: config.namespace, repo_name: input.id },
        destination: { type: 'queues.queue', queue_id: config.queue_id }, events: [pushed],
      });
      subscription = created.result;
      if (!this.matches(subscription, config, input.id)) throw unavailable();
    }
    return this.receipt(config, input, subscription);
  }

  /** Reconciliation reads existing delivery only; it never retries an uncertain POST. */
  async inspect(input) {
    const config = this.preflight();
    await this.authorize(input);
    const subscription = await this.find(config, input.id);
    if (!subscription) throw new DomainError('RECOVERY_REQUIRED',
      'No repository push subscription confirms the issued operation', 409);
    return this.receipt(config, input, subscription);
  }
}
