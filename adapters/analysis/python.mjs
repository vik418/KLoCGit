/**
 * CPython compiler/symbol-table analysis observes static bindings, not runtime behavior.
 * The runner is a trusted isolation adapter; this module never launches producer code.
 */
import { V1Error } from '../../core/v1/conventions.mjs';
import { copyJsonData } from '../../core/v1/domain.mjs';
import { normalizeEffectSet } from '../../core/v1/encoding.mjs';
import { analysisProject, extractorCapabilities } from '../../core/v1/extractors.mjs';

export const PYTHON_SUPPORTED_VERSIONS = Object.freeze(['3.12.14']);
export const PYTHON_ANALYSIS_PROTOCOL = 'klocgit-python-analysis-v1';
export const PYTHON_SEMANTIC_SCOPE = Object.freeze({
  compiler: 'cpython-compile-and-symtable',
  claims: Object.freeze([
    'static-lexical-binding',
    'static-import-binding',
    'static-call-reference',
  ]),
  excludes: Object.freeze(['runtime-execution', 'type-inference', 'behavioral-equivalence']),
});

const empty = (status) => ({
  capability: 'SEMANTIC',
  status,
  effects: [],
  security_effects: [],
});

function fields(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((field) => Object.hasOwn(value, field))
  );
}

/**
 * Inject loadProject(revision) and analyzeRunner(request) from trusted execution code.
 * The runner accepts only the versioned source request and returns the compiler envelope.
 * It must provide resource limits, denied network, and a credential-free environment.
 */
export function createPythonSemanticExtractor({
  toolchainVersion = '3.12.14',
  loadProject,
  analyzeRunner,
} = {}) {
  if (
    typeof toolchainVersion !== 'string' ||
    !toolchainVersion.trim() ||
    typeof loadProject !== 'function' ||
    typeof analyzeRunner !== 'function'
  )
    throw new V1Error('INVALID_ARGUMENT');

  return Object.freeze({
    id: 'python-semantic',
    version: '1.0.0',
    capability: 'SEMANTIC',
    capabilities(language, toolchain_version) {
      return extractorCapabilities({
        schema_version: 1,
        language,
        toolchain_version,
        supported_versions: [...PYTHON_SUPPORTED_VERSIONS],
        capability: 'SEMANTIC',
        status:
          language === 'python' && PYTHON_SUPPORTED_VERSIONS.includes(toolchain_version)
            ? 'COMPLETE'
            : 'UNSUPPORTED',
      });
    },
    async analyze(base, revision) {
      if (!PYTHON_SUPPORTED_VERSIONS.includes(toolchainVersion)) return empty('UNSUPPORTED');
      try {
        const projects = await Promise.all([loadProject(base), loadProject(revision)]);
        const request = Object.freeze({
          schema_version: 1,
          protocol: PYTHON_ANALYSIS_PROTOCOL,
          toolchain_version: toolchainVersion,
          base: analysisProject(projects[0], base),
          revision: analysisProject(projects[1], revision),
        });
        const response = copyJsonData(await analyzeRunner(request));
        if (
          !fields(response, ['schema_version', 'protocol', 'toolchain_version', 'result']) ||
          response.schema_version !== 1 ||
          response.protocol !== PYTHON_ANALYSIS_PROTOCOL
        )
          return empty('FAILED');
        if (response.toolchain_version !== toolchainVersion) return empty('UNSUPPORTED');
        const result = response.result;
        if (
          !fields(result, ['capability', 'status', 'effects', 'security_effects']) ||
          result.capability !== 'SEMANTIC' ||
          !['COMPLETE', 'PARTIAL', 'UNSUPPORTED', 'FAILED'].includes(result.status) ||
          !Array.isArray(result.effects) ||
          !Array.isArray(result.security_effects)
        )
          return empty('FAILED');
        // Validate effects even for direct plugin calls outside the contract wrapper.
        const normalized = normalizeEffectSet({
          schema_version: 1,
          future_revision_id: revision.id,
          extractor_id: 'python-semantic',
          extractor_version: '1.0.0',
          digest: 'sha256:effect-set:v1:' + '0'.repeat(64),
          ...result,
        });
        // A trusted runner cannot make missing source disappear by returning COMPLETE.
        const status =
          (!request.base.complete || !request.revision.complete) && normalized.status === 'COMPLETE'
            ? 'PARTIAL'
            : normalized.status;
        return {
          capability: normalized.capability,
          status,
          effects: normalized.effects,
          security_effects: normalized.security_effects,
        };
      } catch {
        // Compiler/provider diagnostics may contain producer source or private paths.
        return empty('FAILED');
      }
    },
  });
}
