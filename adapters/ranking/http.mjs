/** Remote priorities are hints; the scheduler validates the complete unchanged pool. */
import { ProviderHttp } from '../http.mjs';
import { V1Error, assertSchemaVersion } from '../../core/v1/conventions.mjs';
import { copyJsonData } from '../../core/v1/domain.mjs';
import { verifyCandidateSpec } from '../../core/v1/reduction.mjs';

export class HttpRanker {
  constructor({ path, ...http }) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//'))
      throw new V1Error('INVALID_ARGUMENT');
    this.path = path;
    this.http = new ProviderHttp(http);
  }

  async rank(inputs, summaryInput, { signal } = {}) {
    const specs = await Promise.all(copyJsonData(inputs).map(verifyCandidateSpec));
    const summary = copyJsonData(summaryInput);
    assertSchemaVersion(summary);
    try {
      return await this.http.request(
        'POST',
        this.path,
        {
          schema_version: 1,
          candidate_specs: specs,
          evidence_summary: summary,
        },
        {},
        { signal },
      );
    } catch (error) {
      // A lost ranking reply has no Git effect to reconcile.
      if (error instanceof V1Error && error.code !== 'OUTCOME_UNKNOWN') throw error;
      throw new V1Error('PROVIDER_UNAVAILABLE');
    }
  }
}
