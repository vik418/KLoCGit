/**
 * Tier 1 compares observed syntax, not type compatibility or runtime behavior.
 * Parser adapters return JSON projections; compiler/Tree-sitter nodes never cross
 * this boundary. Missing files in partial snapshots are not proven removals.
 */
import ts from 'typescript';
import { V1Error, assertSchemaVersion } from '../../core/v1/conventions.mjs';
import { copyJsonData } from '../../core/v1/domain.mjs';
import { digestCanonical, encodeCanonical } from '../../core/v1/encoding.mjs';
import { analysisProject, extractorCapabilities } from '../../core/v1/extractors.mjs';

const LANGUAGES = ['typescript', 'javascript'];
const VERSION = '6.0.3';
const STATUSES = ['COMPLETE', 'PARTIAL', 'UNSUPPORTED', 'FAILED'];

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function text(value) {
  valid(typeof value === 'string' && value.trim().length > 0);
}

function same(left, right) {
  return Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right)));
}

function result(status, effects = []) {
  return { capability: 'STRUCTURAL', status, effects, security_effects: [] };
}

function effect(kind, target, operation, attributes, references = []) {
  return {
    schema_version: 1,
    kind,
    target,
    operation,
    attributes: { analysis_scope: 'syntax-only', ...attributes },
    references,
  };
}

function gap(target, reason, phase) {
  return effect('analysis-gap', target, 'unavailable', { reason, phase });
}

/**
 * Parser contract: capabilities(language, version), supportsPath(path, language),
 * parse({path, contents, language, toolchain_version}) -> a versioned JSON record
 * with status, ordered declarations/references and an ordered syntax structure.
 * Declaration entries have id/kind/name/signature/body; reference entries have
 * id/kind/name/syntax. IDs identify occurrences within one file, not symbols.
 */
function parsedFile(input) {
  const parsed = copyJsonData(input);
  assertSchemaVersion(parsed);
  const fields = ['schema_version', 'status', 'declarations', 'references', 'structure'];
  valid(
    Object.keys(parsed).length === fields.length &&
      fields.every((field) => Object.hasOwn(parsed, field)),
  );
  valid(STATUSES.includes(parsed.status));
  for (const [field, keys] of [
    ['declarations', ['id', 'kind', 'name', 'signature', 'body']],
    ['references', ['id', 'kind', 'name', 'syntax']],
  ]) {
    valid(Array.isArray(parsed[field]));
    const identities = new Set();
    for (const entry of parsed[field]) {
      valid(entry && typeof entry === 'object' && !Array.isArray(entry));
      valid(
        Object.keys(entry).length === keys.length && keys.every((key) => Object.hasOwn(entry, key)),
      );
      ['id', 'kind'].forEach((key) => text(entry[key]));
      valid(typeof entry.name === 'string');
      valid(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.kind));
      valid(!identities.has(entry.id));
      identities.add(entry.id);
    }
  }
  if (parsed.status === 'COMPLETE' || parsed.status === 'PARTIAL') valid(parsed.structure !== null);
  return parsed;
}

export class StructuralExtractor {
  constructor({
    loadProject,
    parser = new TypeScriptStructuralParser(),
    language = 'typescript',
    toolchain_version = VERSION,
  }) {
    valid(typeof loadProject === 'function');
    valid(
      typeof parser?.id === 'string' &&
        parser.id.trim() &&
        typeof parser?.version === 'string' &&
        parser.version.trim() &&
        typeof parser.capabilities === 'function' &&
        typeof parser.supportsPath === 'function' &&
        typeof parser.parse === 'function',
    );
    text(language);
    text(toolchain_version);
    this.id = 'structural-parser';
    this.version = '1.0.0';
    this.capability = 'STRUCTURAL';
    this.loadProject = loadProject;
    this.parser = parser;
    this.language = language;
    this.toolchain_version = toolchain_version;
  }

  async capabilities(language, toolchain_version) {
    const metadata = extractorCapabilities(
      await this.parser.capabilities(language, toolchain_version),
    );
    if (
      metadata.language !== language ||
      metadata.toolchain_version !== toolchain_version ||
      metadata.capability !== 'STRUCTURAL'
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    return metadata;
  }

  async analyze(base, revision) {
    try {
      const metadata = await this.capabilities(this.language, this.toolchain_version);
      if (metadata.status === 'UNSUPPORTED' || metadata.status === 'FAILED')
        return result(metadata.status);
      const baseline = analysisProject(await this.loadProject(base), base);
      const observed = analysisProject(await this.loadProject(revision), revision);
      if (baseline.repo_id !== observed.repo_id || base.system_id !== revision.system_id)
        throw new V1Error('INVALID_ARGUMENT');
      let partial = metadata.status === 'PARTIAL' || !baseline.complete || !observed.complete;
      const effects = [];
      for (const [phase, project] of [
        ['base', baseline],
        ['revision', observed],
      ]) {
        if (!project.complete) effects.push(gap('<project>', 'partial-project', phase));
      }
      const before = new Map(baseline.files.map((file) => [file.path, file]));
      const after = new Map(observed.files.map((file) => [file.path, file]));
      // Paths are set-like; syntax/declaration/parameter order remains untouched.
      for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const supported = await this.parser.supportsPath(path, this.language);
        valid(typeof supported === 'boolean');
        if (!supported) {
          partial = true;
          effects.push(gap(path, 'unsupported-path', 'comparison'));
          continue;
        }
        const projections = [];
        for (const [phase, file] of [
          ['base', before.get(path)],
          ['revision', after.get(path)],
        ]) {
          if (!file) {
            projections.push(null);
            continue;
          }
          const parsed = parsedFile(
            await this.parser.parse({
              ...file,
              language: this.language,
              toolchain_version: this.toolchain_version,
            }),
          );
          if (parsed.status === 'FAILED') return result('FAILED');
          if (parsed.status === 'UNSUPPORTED') {
            partial = true;
            projections.push(null);
            effects.push(gap(path, 'unsupported-syntax', phase));
          } else {
            partial ||= parsed.status === 'PARTIAL';
            if (parsed.status === 'PARTIAL') effects.push(gap(path, 'partial-parser', phase));
            projections.push(parsed);
          }
        }
        const [previous, next] = projections;
        // Unavailable parser output or an omitted snapshot cannot prove absence.
        if (
          (!previous && before.has(path)) ||
          (!next && after.has(path)) ||
          (!previous && !baseline.complete) ||
          (!next && !observed.complete)
        ) {
          if (previous || next)
            effects.push(
              effect('file-structure', path, 'observed', {
                phase: previous ? 'base' : 'revision',
                structure: (previous || next).structure,
              }),
            );
          continue;
        }
        if (!same(previous?.structure ?? null, next?.structure ?? null)) {
          effects.push(
            effect('file-structure', path, previous ? (next ? 'modified' : 'removed') : 'added', {
              parser_id: this.parser.id,
              parser_version: this.parser.version,
              before_digest: previous ? await this.syntaxDigest(previous.structure) : null,
              after_digest: next ? await this.syntaxDigest(next.structure) : null,
              declaration_order: {
                before: previous?.declarations.map((entry) => entry.id) ?? [],
                after: next?.declarations.map((entry) => entry.id) ?? [],
              },
            }),
          );
        }
        this.compareEntries(path, previous, next, effects);
      }
      return result(partial ? 'PARTIAL' : 'COMPLETE', effects);
    } catch {
      // Diagnostics can contain private source; the stable contract exposes status.
      return result('FAILED');
    }
  }

  syntaxDigest(structure) {
    return digestCanonical('structural-syntax', {
      schema_version: 1,
      parser_id: this.parser.id,
      parser_version: this.parser.version,
      structure,
    });
  }

  compareEntries(path, previous, next, effects) {
    for (const field of ['declarations', 'references']) {
      const before = new Map((previous?.[field] ?? []).map((entry) => [entry.id, entry]));
      const after = new Map((next?.[field] ?? []).map((entry) => [entry.id, entry]));
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const left = before.get(id) ?? null;
        const right = after.get(id) ?? null;
        const entry = left || right;
        const target = path + '#' + id;
        const attributes = { declaration_kind: entry.kind, name: entry.name };
        if ((!left && previous?.status === 'PARTIAL') || (!right && next?.status === 'PARTIAL')) {
          effects.push(
            effect(field === 'references' ? 'reference' : 'declaration', target, 'observed', {
              phase: left ? 'base' : 'revision',
              entry,
            }),
          );
          continue;
        }
        if (field === 'references') {
          if (!same(left, right))
            effects.push(
              effect(
                'reference',
                target,
                left ? (right ? 'modified' : 'removed') : 'added',
                {
                  reference_kind: entry.kind,
                  reference_resolution: 'unresolved',
                  before: left,
                  after: right,
                },
                [entry.kind + ':' + entry.name],
              ),
            );
        } else if (!left || !right) {
          effects.push(
            effect('declaration', target, left ? 'removed' : 'added', {
              ...attributes,
              before: left,
              after: right,
            }),
          );
        } else {
          for (const part of ['signature', 'body']) {
            if (!same(left[part], right[part]))
              effects.push(
                effect(part, target, 'modified', {
                  ...attributes,
                  before: left[part],
                  after: right[part],
                }),
              );
          }
        }
      }
    }
  }
}

/** Maintained compiler parser; all reads are supplied source strings in memory. */
export class TypeScriptStructuralParser {
  constructor({ compiler = ts } = {}) {
    this.id = 'typescript-syntax';
    this.version = compiler.version;
    this.compiler = compiler;
  }

  capabilities(language, toolchain_version) {
    return extractorCapabilities({
      schema_version: 1,
      language,
      toolchain_version,
      supported_versions: [VERSION],
      capability: 'STRUCTURAL',
      status:
        LANGUAGES.includes(language) && toolchain_version === VERSION
          ? this.compiler.version === VERSION
            ? 'COMPLETE'
            : 'FAILED'
          : 'UNSUPPORTED',
    });
  }

  supportsPath(path, language) {
    if (!LANGUAGES.includes(language)) return false;
    return language === 'typescript'
      ? /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(path)
      : /\.(?:[cm]?js|jsx)$/.test(path);
  }

  parse({ path, contents, language, toolchain_version }) {
    const status = this.capabilities(language, toolchain_version).status;
    const empty = (state) => ({
      schema_version: 1,
      status: state,
      declarations: [],
      references: [],
      structure: null,
    });
    if (status !== 'COMPLETE') return empty(status);
    if (!this.supportsPath(path, language)) return empty('UNSUPPORTED');
    try {
      const compiler = this.compiler;
      const source = compiler.createSourceFile(path, contents, compiler.ScriptTarget.Latest, true);
      // Syntactic diagnostics also reject TS-only syntax in .js. noResolve/noLib
      // plus this file-only host prevent dependency/package/lib filesystem reads.
      const host = {
        getSourceFile: (name) => (name === path ? source : undefined),
        getDefaultLibFileName: () => '',
        writeFile: () => {},
        getCurrentDirectory: () => '',
        getDirectories: () => [],
        fileExists: (name) => name === path,
        readFile: (name) => (name === path ? contents : undefined),
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
      };
      const program = compiler.createProgram(
        [path],
        {
          allowJs: true,
          noLib: true,
          noResolve: true,
          noEmit: true,
          target: compiler.ScriptTarget.Latest,
          jsx: compiler.JsxEmit.Preserve,
        },
        host,
      );
      if (source.parseDiagnostics.length || program.getSyntacticDiagnostics(source).length)
        return empty('FAILED');
      return this.projectSyntax(source);
    } catch {
      return empty('FAILED');
    }
  }

  projectSyntax(source) {
    const compiler = this.compiler;
    const syntax = (node, excluded = new Set()) => {
      const original = node.getChildren(source);
      const children = original.filter((child) => !excluded.has(child));
      const kind = compiler.SyntaxKind[node.kind];
      return original.length
        ? { kind, children: children.map((child) => syntax(child, excluded)) }
        : { kind, text: node.getText(source) };
    };
    const declarationKind = (node) => {
      for (const [predicate, kind] of [
        ['isFunctionDeclaration', 'function'],
        ['isClassDeclaration', 'class'],
        ['isInterfaceDeclaration', 'interface'],
        ['isTypeAliasDeclaration', 'type-alias'],
        ['isEnumDeclaration', 'enum'],
        ['isEnumMember', 'enum-member'],
        ['isModuleDeclaration', 'namespace'],
        ['isVariableDeclaration', 'variable'],
        ['isMethodDeclaration', 'method'],
        ['isMethodSignature', 'method-signature'],
        ['isPropertyDeclaration', 'property'],
        ['isPropertySignature', 'property-signature'],
        ['isConstructorDeclaration', 'constructor'],
        ['isGetAccessorDeclaration', 'getter'],
        ['isSetAccessorDeclaration', 'setter'],
        ['isCallSignatureDeclaration', 'call-signature'],
        ['isConstructSignatureDeclaration', 'construct-signature'],
        ['isIndexSignatureDeclaration', 'index-signature'],
      ]) {
        if (compiler[predicate](node)) return kind;
      }
      return null;
    };
    const declarations = [];
    const references = [];
    const occurrences = new Map();
    const identity = (parts) => {
      const key = JSON.stringify(parts);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      return JSON.stringify([...parts, occurrence]);
    };
    const reference = (kind, name, node) => {
      references.push({
        id: identity(['reference', kind, name]),
        kind,
        name,
        syntax: syntax(node),
      });
    };
    const visit = (node, scope) => {
      let nestedScope = scope;
      const kind = declarationKind(node);
      if (kind) {
        // A binding pattern's ordered syntax identifies the declaration without
        // whitespace/source offsets. Anonymous/default declarations remain local.
        const name = node.name
          ? compiler.isIdentifier(node.name) || compiler.isStringLiteral(node.name)
            ? node.name.text
            : JSON.stringify(syntax(node.name))
          : '<' + kind + '>';
        const id = identity(['declaration', ...scope, kind, name]);
        const body = node.body || node.initializer || null;
        const excluded = new Set(body ? [body] : []);
        if (compiler.isClassDeclaration(node) || compiler.isEnumDeclaration(node))
          node.members.forEach((member) => excluded.add(member));
        declarations.push({
          id,
          kind,
          name,
          signature: syntax(node, excluded),
          body: body
            ? syntax(body)
            : compiler.isClassDeclaration(node) || compiler.isEnumDeclaration(node)
              ? node.members.map((member) => syntax(member))
              : null,
        });
        // Scope components contain only this declaration, not its complete ID;
        // otherwise deeply nested scopes would duplicate ancestors exponentially.
        nestedScope = [...scope, [kind, name, JSON.parse(id).at(-1)]];
      }
      if (
        (compiler.isImportDeclaration(node) || compiler.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        compiler.isStringLiteral(node.moduleSpecifier)
      ) {
        reference('module', node.moduleSpecifier.text, node);
      } else if (
        compiler.isImportTypeNode(node) &&
        compiler.isLiteralTypeNode(node.argument) &&
        compiler.isStringLiteral(node.argument.literal)
      ) {
        reference('module', node.argument.literal.text, node);
      } else if (
        compiler.isExternalModuleReference(node) &&
        node.expression &&
        compiler.isStringLiteral(node.expression)
      ) {
        reference('module', node.expression.text, node);
      } else if (
        compiler.isCallExpression(node) &&
        node.arguments.length &&
        compiler.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === compiler.SyntaxKind.ImportKeyword ||
          (compiler.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        // require may be shadowed: this is a syntax observation, not resolution.
        reference('module', node.arguments[0].text, node);
      }
      if (compiler.isIdentifier(node) && !compiler.isDeclarationName(node))
        reference('identifier', node.text, node);
      compiler.forEachChild(node, (child) => visit(child, nestedScope));
    };
    visit(source, []);
    return {
      schema_version: 1,
      status: 'COMPLETE',
      declarations,
      references,
      structure: syntax(source),
    };
  }
}
