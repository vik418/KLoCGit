/** Git-level changes are facts; security roles inferred from paths are hints. */
import { V1Error } from '../../core/v1/conventions.mjs';
import { Extractor, analysisProject } from '../../core/v1/extractors.mjs';

const pathRules = [
  [
    'dependency',
    /(^|\/)(package(?:-lock)?\.json|[^/]*lock|go\.(mod|sum)|Cargo\.toml|pyproject\.toml|requirements[^/]*\.txt)$/i,
  ],
  [
    'build',
    /(^|\/)(Dockerfile[^/]*|Makefile|CMakeLists\.txt|wrangler\.[^/]+|[^/]+\.gradle|build\.[^/]+)$/i,
  ],
  ['ci', /(^|\/)(\.github\/workflows|\.circleci|\.gitlab-ci[^/]*|Jenkinsfile)(\/|$)/i],
  ['auth', /(^|\/)(auth[^/]*|login|session|oauth|identity)(\/|\.|$)/i],
  ['iam', /(^|\/)(iam|permissions?|polic(?:y|ies)|roles?)(\/|\.|$)/i],
  ['schema', /(^|\/)(schemas?|[^/]+\.proto|[^/]+\.graphql)(\/|$)/i],
  ['migration', /(^|\/)(migrations?|[^/]*migration[^/]*)(\/|\.|$)/i],
  ['secret', /(^|\/)(\.env[^/]*|secrets?|credentials?|[^/]+\.(pem|key))(\/|$)/i],
];

export function securityPathRoles(path) {
  return pathRules.filter(([, pattern]) => pattern.test(path)).map(([role]) => role);
}

function effect(kind, target, operation, attributes, references = []) {
  return { schema_version: 1, kind, target, operation, attributes, references };
}

function same(left, right) {
  return left?.oid === right?.oid && left?.mode === right?.mode;
}

function manifestFormat(path) {
  const name = path.split('/').at(-1);
  if (['package.json', 'package-lock.json'].includes(name)) return 'npm';
  if (['Cargo.toml', 'pyproject.toml'].includes(name)) return 'toml';
  if (name === 'go.mod') return 'go-mod';
  if (/^requirements.*\.txt$/.test(name)) return 'requirements';
  return null;
}

function dependencies(contents, format) {
  if (contents === null || format !== 'npm') return new Map();
  const parsed = JSON.parse(contents);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new V1Error('INVALID_ARGUMENT');
  const result = new Map();
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    if (!Object.hasOwn(parsed, section)) continue;
    const values = parsed[section];
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new V1Error('INVALID_ARGUMENT');
    for (const [name, version] of Object.entries(values)) {
      // Lockfiles may describe resolved dependencies as records rather than ranges.
      const range = typeof version === 'string' ? version : version?.version;
      if (typeof range !== 'string') throw new V1Error('INVALID_ARGUMENT');
      result.set(`${section}:${name}`, { section, name, version: range });
    }
  }
  return result;
}

export class GitPathPlugin {
  constructor({ gitStore, loadProject, max_entries }) {
    if (
      typeof gitStore?.read_tree !== 'function' ||
      typeof loadProject !== 'function' ||
      !Number.isSafeInteger(max_entries) ||
      max_entries < 1
    )
      throw new V1Error('INVALID_ARGUMENT');
    this.id = 'git-path';
    this.version = '1';
    this.capability = 'PATH';
    this.store = gitStore;
    this.loadProject = loadProject;
    this.maxEntries = max_entries;
  }

  capabilities(language, toolchain_version) {
    return {
      schema_version: 1,
      language,
      toolchain_version,
      supported_versions: ['1'],
      capability: 'PATH',
      status: language === 'git' && toolchain_version === '1' ? 'COMPLETE' : 'UNSUPPORTED',
    };
  }

  async analyze(base, revision) {
    if (base.repo_id !== this.store.repo_id) throw new V1Error('FORBIDDEN');
    let visited = 0;
    const changes = [];
    const read = async (oid) => {
      if (!oid) return [];
      const entries = (await this.store.read_tree(oid)).entries;
      visited += entries.length;
      if (visited > this.maxEntries) throw new V1Error('RATE_LIMITED');
      return entries;
    };
    const compare = async (before, after, prefix) => {
      if (before === after) return;
      const [oldEntries, newEntries] = await Promise.all([read(before), read(after)]);
      const old = new Map(oldEntries.map((entry) => [entry.name, entry]));
      const next = new Map(newEntries.map((entry) => [entry.name, entry]));
      for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
        const left = old.get(name),
          right = next.get(name);
        if (same(left, right)) continue;
        const path = prefix + name;
        if (left?.kind === 'tree' || right?.kind === 'tree') {
          await compare(
            left?.kind === 'tree' ? left.oid : null,
            right?.kind === 'tree' ? right.oid : null,
            path + '/',
          );
          if ((!left || left.kind === 'tree') && (!right || right.kind === 'tree')) continue;
        }
        changes.push({
          path,
          before: left?.kind === 'tree' ? null : (left ?? null),
          after: right?.kind === 'tree' ? null : (right ?? null),
        });
      }
    };
    try {
      await compare(base.tree_oid, revision.tree_oid, '');
    } catch (error) {
      if (error?.code !== 'RATE_LIMITED') throw error;
      // Incomplete traversal cannot establish absence on the unvisited side.
      return { capability: 'PATH', status: 'PARTIAL', effects: [], security_effects: [] };
    }
    const effects = [],
      security_effects = [];
    const manifests = changes.filter(
      ({ path, before, after }) =>
        manifestFormat(path) &&
        [before, after].every(
          (entry) => !entry || entry.mode === '100644' || entry.mode === '100755',
        ),
    );
    const files = async (subject, side) => {
      const paths = manifests.filter((change) => change[side]).map(({ path }) => path);
      if (!paths.length) return new Map();
      const source = analysisProject(await this.loadProject(subject, { paths }), subject);
      const result = new Map(source.files.map(({ path, contents }) => [path, contents]));
      if (!paths.every((path) => result.has(path))) throw new V1Error('INCOMPLETE_ANALYSIS');
      return result;
    };
    let oldFiles,
      newFiles,
      status = 'COMPLETE';
    try {
      [oldFiles, newFiles] = await Promise.all([files(base, 'before'), files(revision, 'after')]);
    } catch {
      status = 'PARTIAL';
    }
    for (const { path, before, after } of changes) {
      const operation = !before ? 'added' : !after ? 'removed' : 'modified';
      const attributes = { basis: 'OBSERVED', before, after };
      effects.push(effect('git-path', path, operation, attributes));
      for (const role of securityPathRoles(path)) {
        security_effects.push(
          effect('security-surface', path, operation, {
            basis: 'INFERRED',
            role,
            rule_version: '1',
            method: 'path-convention',
          }),
        );
      }
      const format = manifestFormat(path);
      if (!format) continue;
      effects.push(effect('manifest', path, operation, { ...attributes, format }));
      if (!oldFiles || !newFiles) continue;
      try {
        const previous = dependencies(oldFiles.get(path) ?? null, format);
        const current = dependencies(newFiles.get(path) ?? null, format);
        for (const key of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
          const left = previous.get(key),
            right = current.get(key);
          if (left?.version === right?.version) continue;
          effects.push(
            effect(
              'manifest-dependency',
              `${path}:${key}`,
              !left ? 'added' : !right ? 'removed' : 'modified',
              {
                basis: 'DECLARED',
                manifest: path,
                before: left ?? null,
                after: right ?? null,
              },
              [path],
            ),
          );
        }
      } catch {
        status = 'PARTIAL';
      }
    }
    return { capability: 'PATH', status, effects, security_effects };
  }
}

export function createGitPathExtractor(options) {
  return new Extractor({
    plugin: new GitPathPlugin(options),
    language: 'git',
    toolchain_version: '1',
  });
}
