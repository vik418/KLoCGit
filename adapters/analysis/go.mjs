/** Go semantic analysis runs only through an explicitly supplied trusted sandbox runner. */
import { analysisProject, extractorCapabilities } from '../../core/v1/extractors.mjs';
import { V1Error } from '../../core/v1/conventions.mjs';
import { copyJsonData } from '../../core/v1/domain.mjs';

export const GO_SUPPORTED_VERSIONS = Object.freeze(['1.26.9', '1.27.2']);

function result(status, effects = [], security_effects = []) {
  return { capability: 'SEMANTIC', status, effects, security_effects };
}

/**
 * runner accepts data, never shell arguments or repository-controlled commands.
 * Its provider must run the prebuilt trusted helper with a cleared environment,
 * denied network, no credentials, bounded resources and trusted GOROOT only.
 * This adapter does not launch a host process or inherit the server environment.
 */
export function createGoSemanticExtractor({ toolchain_version, loadProject, runner }) {
  if (
    typeof toolchain_version !== 'string' ||
    typeof loadProject !== 'function' ||
    typeof runner !== 'function'
  )
    throw new V1Error('INVALID_ARGUMENT');
  return Object.freeze({
    id: 'go-semantic',
    version: '1.0.0',
    capability: 'SEMANTIC',
    capabilities(language, version) {
      return extractorCapabilities({
        schema_version: 1,
        language,
        toolchain_version: version,
        supported_versions: GO_SUPPORTED_VERSIONS,
        capability: 'SEMANTIC',
        status:
          language === 'go' &&
          version === toolchain_version &&
          GO_SUPPORTED_VERSIONS.includes(version)
            ? 'COMPLETE'
            : 'UNSUPPORTED',
      });
    },
    async analyze(base, revision) {
      if (!GO_SUPPORTED_VERSIONS.includes(toolchain_version)) return result('UNSUPPORTED');
      try {
        const baseline = analysisProject(await loadProject(base), base);
        const observed = analysisProject(await loadProject(revision), revision);
        const response = copyJsonData(
          await runner({
            schema_version: 1,
            toolchain_version,
            base: baseline,
            revision: observed,
          }),
        );
        const fields = [
          'schema_version',
          'toolchain_version',
          'capability',
          'status',
          'effects',
          'security_effects',
        ];
        if (
          Object.keys(response).length !== fields.length ||
          !fields.every((field) => Object.hasOwn(response, field)) ||
          response.schema_version !== 1 ||
          response.toolchain_version !== toolchain_version ||
          response.capability !== 'SEMANTIC' ||
          !['COMPLETE', 'PARTIAL', 'UNSUPPORTED', 'FAILED'].includes(response.status) ||
          !Array.isArray(response.effects) ||
          !Array.isArray(response.security_effects)
        )
          return result('FAILED');
        if ((!baseline.complete || !observed.complete) && response.status === 'COMPLETE')
          return result('PARTIAL', response.effects, response.security_effects);
        return result(response.status, response.effects, response.security_effects);
      } catch {
        return result('FAILED');
      }
    },
  });
}
