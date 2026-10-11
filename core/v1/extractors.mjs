/** Versioned analysis plugins report their limits rather than silently changing tiers. */
import { V1Error, assertSchemaVersion } from './conventions.mjs';
import {
  ANALYSIS_CAPABILITIES,
  ANALYSIS_STATUSES,
  FutureRevision,
  copyJsonData,
} from './domain.mjs';
import { effectSetDigest, normalizeEffectSet } from './encoding.mjs';

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function extractorCapabilities(input) {
  const metadata = copyJsonData(input);
  assertSchemaVersion(metadata);
  const fields = [
    'schema_version',
    'language',
    'toolchain_version',
    'supported_versions',
    'capability',
    'status',
  ];
  valid(
    Object.keys(metadata).length === fields.length &&
      fields.every((field) => Object.hasOwn(metadata, field)),
  );
  valid(
    ['language', 'toolchain_version'].every(
      (field) => typeof metadata[field] === 'string' && metadata[field].trim(),
    ),
  );
  valid(Array.isArray(metadata.supported_versions));
  valid(
    metadata.supported_versions.every((version) => typeof version === 'string' && version.trim()),
  );
  valid(new Set(metadata.supported_versions).size === metadata.supported_versions.length);
  valid(ANALYSIS_CAPABILITIES.includes(metadata.capability));
  valid(ANALYSIS_STATUSES.includes(metadata.status));
  return freeze(metadata);
}

export async function buildEffectSet(input) {
  const projection = copyJsonData(input);
  valid(!Object.hasOwn(projection, 'digest'));
  // Validate and normalize before computing the self-excluding identity.
  const normalized = normalizeEffectSet({
    ...projection,
    digest: 'sha256:effect-set:v1:' + '0'.repeat(64),
  });
  return normalizeEffectSet({ ...normalized, digest: await effectSetDigest(normalized) });
}

export async function verifyEffectSet(input) {
  const normalized = normalizeEffectSet(input);
  if ((await effectSetDigest(normalized)) !== normalized.digest)
    throw new V1Error('INTEGRITY_MISMATCH');
  return normalized;
}

/** A trusted source supplies exact Git files; partial hydration is explicit. */
export function analysisProject(input, revision) {
  const subject = FutureRevision(revision);
  const project = copyJsonData(input);
  assertSchemaVersion(project);
  const fields = ['schema_version', 'repo_id', 'commit_oid', 'tree_oid', 'complete', 'files'];
  valid(
    Object.keys(project).length === fields.length &&
      fields.every((field) => Object.hasOwn(project, field)),
  );
  if (
    project.repo_id !== subject.repo_id ||
    project.commit_oid !== subject.commit_oid ||
    project.tree_oid !== subject.tree_oid
  )
    throw new V1Error('INTEGRITY_MISMATCH');
  valid(typeof project.complete === 'boolean' && Array.isArray(project.files));
  const paths = new Set();
  for (const file of project.files) {
    valid(file && typeof file === 'object' && !Array.isArray(file));
    valid(
      Object.keys(file).length === 2 &&
        Object.hasOwn(file, 'path') &&
        Object.hasOwn(file, 'contents'),
    );
    valid(
      typeof file.path === 'string' &&
        file.path.length > 0 &&
        !file.path.startsWith('/') &&
        !file.path.includes('\0'),
    );
    valid(file.path.split('/').every((part) => part && part !== '.' && part !== '..'));
    valid(typeof file.contents === 'string' && !paths.has(file.path));
    paths.add(file.path);
  }
  return freeze(project);
}

export class Extractor {
  constructor({ plugin, language, toolchain_version }) {
    valid(typeof plugin?.id === 'string' && plugin.id.trim());
    valid(typeof plugin?.version === 'string' && plugin.version.trim());
    valid(ANALYSIS_CAPABILITIES.includes(plugin.capability));
    valid(typeof plugin.capabilities === 'function' && typeof plugin.analyze === 'function');
    valid(typeof language === 'string' && language.trim());
    valid(typeof toolchain_version === 'string' && toolchain_version.trim());
    this.id = plugin.id;
    this.version = plugin.version;
    this.capability = plugin.capability;
    this.language = language;
    this.toolchain_version = toolchain_version;
    this.describe = plugin.capabilities.bind(plugin);
    this.run = plugin.analyze.bind(plugin);
  }

  async capabilities(language, version) {
    const metadata = extractorCapabilities(await this.describe(language, version));
    if (
      metadata.language !== language ||
      metadata.toolchain_version !== version ||
      metadata.capability !== this.capability
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    return metadata;
  }

  async analyze(base, revision) {
    const baseline = FutureRevision(base);
    const observed = FutureRevision(revision);
    if (baseline.repo_id !== observed.repo_id || baseline.system_id !== observed.system_id)
      throw new V1Error('INVALID_ARGUMENT');
    const header = {
      schema_version: 1,
      future_revision_id: observed.id,
      extractor_id: this.id,
      extractor_version: this.version,
    };
    let metadata;
    try {
      metadata = await this.capabilities(this.language, this.toolchain_version);
    } catch {
      return buildEffectSet({
        ...header,
        capability: this.capability,
        status: 'FAILED',
        effects: [],
        security_effects: [],
      });
    }
    let result = {
      capability: metadata.capability,
      status: metadata.status,
      effects: [],
      security_effects: [],
    };
    if (metadata.status === 'COMPLETE' || metadata.status === 'PARTIAL') {
      try {
        result = copyJsonData(await this.run(baseline, observed));
        const fields = ['capability', 'status', 'effects', 'security_effects'];
        valid(
          Object.keys(result).length === fields.length &&
            fields.every((field) => Object.hasOwn(result, field)),
        );
        valid(
          result.capability === metadata.capability && ANALYSIS_STATUSES.includes(result.status),
        );
        if (metadata.status === 'PARTIAL' && result.status === 'COMPLETE')
          throw new V1Error('INCOMPLETE_ANALYSIS');
        // A malformed effect payload is an analysis failure, not a reduced tier.
        return await buildEffectSet({ ...header, ...result });
      } catch {
        result = {
          capability: metadata.capability,
          status: 'FAILED',
          effects: [],
          security_effects: [],
        };
      }
    }
    return buildEffectSet({ ...header, ...result });
  }
}
