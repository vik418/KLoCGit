/** Argo CD owns synchronization; this adapter updates and observes desired state. */
import { V1Error, assertSchemaVersion } from '../../core/v1/conventions.mjs';
import { copyJsonData } from '../../core/v1/domain.mjs';
import { ProviderHttp } from './http.mjs';

const prefix = 'klocgit.dev/';
const fields = [
  'ordering_constraints',
  'compatibility_requirements',
  'preconditions',
  'postconditions',
  'forward_only_operations',
];

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}

function pointer(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

export class ArgoDeploymentTransport {
  constructor({ http, application, project, namespace, repositories, translateConstraints }) {
    valid(
      http instanceof ProviderHttp &&
        typeof application === 'string' &&
        application.length > 0 &&
        typeof project === 'string' &&
        project.length > 0 &&
        typeof namespace === 'string' &&
        namespace.length > 0,
    );
    valid(repositories && Object.keys(repositories).length > 0);
    this.http = http;
    this.application = application;
    this.project = project;
    this.namespace = namespace;
    this.repositories = copyJsonData(repositories);
    for (const source of Object.values(this.repositories))
      valid(typeof source.repo_url === 'string' && typeof source.path === 'string');
    valid(translateConstraints === undefined || typeof translateConstraints === 'function');
    this.translateConstraints = translateConstraints;
    this.endpoint =
      '/api/v1/applications/' +
      encodeURIComponent(application) +
      '?project=' +
      encodeURIComponent(project) +
      '&appNamespace=' +
      encodeURIComponent(namespace);
  }

  async #application() {
    const app = await this.http.request('GET', this.endpoint);
    valid(
      app?.metadata?.name === this.application &&
        app.metadata.namespace === this.namespace &&
        app.spec?.project === this.project,
      'FORBIDDEN',
    );
    valid(
      typeof app.metadata.uid === 'string' &&
        app.metadata.uid.length > 0 &&
        typeof app.metadata.resourceVersion === 'string',
      'PROVIDER_UNAVAILABLE',
    );
    return app;
  }

  #sources(app, revision) {
    const sources = app.spec.sources ?? [app.spec.source];
    valid(
      Array.isArray(sources) && sources.length === Object.keys(revision.repositories).length,
      'UNSUPPORTED_CAPABILITY',
    );
    const seen = new Set();
    const selected = sources.map((source, index) => {
      valid(source && !source.chart, 'UNSUPPORTED_CAPABILITY');
      const repo = Object.keys(revision.repositories).find(
        (id) =>
          this.repositories[id]?.repo_url === source.repoURL &&
          this.repositories[id]?.path === source.path,
      );
      valid(repo && !seen.has(repo), 'UNSUPPORTED_CAPABILITY');
      seen.add(repo);
      return {
        repo,
        index,
        source,
        path: app.spec.sources ? '/spec/sources/' + index : '/spec/source',
      };
    });
    valid(seen.size === Object.keys(revision.repositories).length, 'UNSUPPORTED_CAPABILITY');
    return selected;
  }

  async submit(revision, constraints, context) {
    const app = await this.#application();
    const selected = this.#sources(app, revision);
    const annotations = app.metadata.annotations ?? {};
    if (annotations[prefix + 'operation'] === context.operation_id) {
      valid(
        annotations[prefix + 'system-revision'] === revision.digest &&
          annotations[prefix + 'release-constraints'] === constraints.digest &&
          selected.every(
            ({ repo, source }) => source.targetRevision === revision.repositories[repo],
          ),
        'IDEMPOTENCY_CONFLICT',
      );
      return {
        schema_version: 1,
        external_run_id: JSON.stringify([app.metadata.uid, context.operation_id]),
      };
    }
    valid(app.spec.syncPolicy?.automated, 'UNSUPPORTED_CAPABILITY');
    valid(
      !app.operation && !['Running', 'Terminating'].includes(app.status?.operationState?.phase),
      'CONFLICT',
    );
    let translated = [];
    if (fields.some((field) => constraints[field].length > 0)) {
      // Native Argo alone cannot enforce arbitrary cross-repository release constraints.
      valid(this.translateConstraints, 'UNSUPPORTED_CAPABILITY');
      const result = copyJsonData(
        await this.translateConstraints(revision, constraints, copyJsonData(app)),
      );
      assertSchemaVersion(result);
      valid(
        Object.keys(result).length === 2 && Array.isArray(result.patches),
        'UNSUPPORTED_CAPABILITY',
      );
      translated = result.patches;
      for (const patch of translated)
        valid(
          ['add', 'replace', 'remove', 'test'].includes(patch.op) &&
            typeof patch.path === 'string' &&
            /^\/(spec|metadata\/annotations)\//.test(patch.path) &&
            !patch.path.includes(prefix),
          'UNSUPPORTED_CAPABILITY',
        );
    }
    const patches = [
      { op: 'test', path: '/metadata/resourceVersion', value: app.metadata.resourceVersion },
      ...translated,
    ];
    for (const { repo, path } of selected)
      patches.push({
        op: 'add',
        path: path + '/targetRevision',
        value: revision.repositories[repo],
      });
    if (!app.metadata.annotations)
      patches.push({ op: 'add', path: '/metadata/annotations', value: {} });
    for (const [name, value] of Object.entries({
      operation: context.operation_id,
      'system-revision': revision.digest,
      'release-constraints': constraints.digest,
    }))
      patches.push({ op: 'add', path: '/metadata/annotations/' + pointer(prefix + name), value });
    const updated = await this.http.request('PATCH', this.endpoint, {
      name: this.application,
      project: this.project,
      appNamespace: this.namespace,
      patchType: 'json',
      patch: JSON.stringify(patches),
    });
    valid(
      updated?.metadata?.uid === app.metadata.uid &&
        updated.metadata.annotations?.[prefix + 'operation'] === context.operation_id,
      'OUTCOME_UNKNOWN',
    );
    return {
      schema_version: 1,
      external_run_id: JSON.stringify([app.metadata.uid, context.operation_id]),
    };
  }

  async observe(handle) {
    const app = await this.#application();
    let identity;
    try {
      identity = JSON.parse(handle.external_run_id);
    } catch {
      throw new V1Error('INVALID_ARGUMENT');
    }
    valid(Array.isArray(identity) && identity.length === 2, 'INVALID_ARGUMENT');
    const annotations = app.metadata.annotations ?? {};
    const unknown = {
      schema_version: 1,
      status: 'UNKNOWN',
      method: 'argo-application-status',
      observed_repositories: null,
    };
    if (
      identity[0] !== app.metadata.uid ||
      identity[1] !== handle.operation_id ||
      annotations[prefix + 'operation'] !== handle.operation_id ||
      annotations[prefix + 'system-revision'] !== handle.system_revision_digest ||
      annotations[prefix + 'release-constraints'] !== handle.release_constraints_digest
    )
      return unknown;
    const sources = app.spec.sources ?? [app.spec.source];
    const reported = app.spec.sources ? app.status?.sync?.revisions : [app.status?.sync?.revision];
    if (!Array.isArray(sources) || !Array.isArray(reported) || sources.length !== reported.length)
      return unknown;
    const repositories = {};
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      const repo = Object.keys(this.repositories).find(
        (id) =>
          this.repositories[id].repo_url === source?.repoURL &&
          this.repositories[id].path === source?.path,
      );
      if (
        !repo ||
        Object.hasOwn(repositories, repo) ||
        source.targetRevision !== reported[index] ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(reported[index])
      )
        return unknown;
      repositories[repo] = reported[index];
    }
    const synced = app.status?.sync?.status === 'Synced';
    const health = app.status?.health?.status;
    const status =
      synced && health === 'Healthy'
        ? 'SUCCEEDED'
        : synced && health === 'Degraded'
          ? 'FAILED'
          : 'RUNNING';
    return {
      schema_version: 1,
      status,
      method: 'argo-application-status',
      observed_repositories: synced ? repositories : null,
    };
  }
}
