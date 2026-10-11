/** Dispatch a registered external deployment workflow, then observe its execution. */
import { V1Error } from '../../core/v1/conventions.mjs';
import { ProviderHttp } from './http.mjs';

const headers = { 'x-github-api-version': '2026-03-10' };

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}

export class GitHubActionsDeploymentTransport {
  constructor({ http, owner, repository, workflow_id, ref, run_name_prefix }) {
    valid(http instanceof ProviderHttp);
    for (const value of [owner, repository, workflow_id])
      valid(typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value));
    valid(
      typeof ref === 'string' &&
        ref.length > 0 &&
        typeof run_name_prefix === 'string' &&
        run_name_prefix.length > 0,
    );
    this.http = http;
    this.workflow_id = workflow_id;
    this.ref = ref;
    this.run_name_prefix = run_name_prefix;
    this.endpoint =
      '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repository) + '/actions';
  }

  async submit(revision, constraints, context) {
    // The registered workflow must consume and enforce the complete contract.
    // Its run-name includes operation_id so an unrelated run cannot satisfy observation.
    const result = await this.http.request(
      'POST',
      this.endpoint + '/workflows/' + encodeURIComponent(this.workflow_id) + '/dispatches',
      {
        ref: this.ref,
        inputs: {
          system_revision: JSON.stringify(revision),
          release_constraints: JSON.stringify(constraints),
          operation_id: context.operation_id,
        },
      },
      headers,
    );
    valid(
      Number.isSafeInteger(result?.workflow_run_id) && result.workflow_run_id > 0,
      'OUTCOME_UNKNOWN',
    );
    return { schema_version: 1, external_run_id: String(result.workflow_run_id) };
  }

  async observe(handle) {
    valid(/^[1-9][0-9]*$/.test(handle.external_run_id));
    const run = await this.http.request(
      'GET',
      this.endpoint + '/runs/' + handle.external_run_id,
      undefined,
      headers,
    );
    valid(
      String(run.id) === handle.external_run_id &&
        run.display_title === this.run_name_prefix + handle.operation_id &&
        run.head_branch === this.ref,
      'INTEGRITY_MISMATCH',
    );
    // A filename is an API workflow selector. The returned numeric identity is
    // checked when the registration uses a numeric selector.
    if (/^[1-9][0-9]*$/.test(this.workflow_id))
      valid(String(run.workflow_id) === this.workflow_id, 'INTEGRITY_MISMATCH');
    else
      valid(
        typeof run.path === 'string' &&
          run.path.split('@')[0] === '.github/workflows/' + this.workflow_id,
        'INTEGRITY_MISMATCH',
      );
    let status = 'UNKNOWN';
    if (['queued', 'requested', 'waiting', 'pending'].includes(run.status)) status = 'SUBMITTED';
    else if (run.status === 'in_progress') status = 'RUNNING';
    else if (run.status === 'completed') {
      if (run.conclusion === 'success') status = 'SUCCEEDED';
      else if (run.conclusion === 'cancelled') status = 'CANCELLED';
      else if (['failure', 'startup_failure', 'action_required'].includes(run.conclusion))
        status = 'FAILED';
    }
    // A timed-out workflow does not establish the final deployment outcome.
    return { schema_version: 1, status, method: 'github-actions-run', observed_repositories: null };
  }
}
