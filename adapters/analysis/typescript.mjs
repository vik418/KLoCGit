/**
 * Compiler observations for the supplied TypeScript/JavaScript project only.
 * COMPLETE means this declared scope was analyzed, not behavioral equivalence,
 * security verification, or proof that the project passes its tests.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, basename, posix } from 'node:path';
import ts from 'typescript';
import { V1Error, digestBytes } from '../../core/v1/conventions.mjs';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { analysisProject, extractorCapabilities } from '../../core/v1/extractors.mjs';

export const TYPESCRIPT_SUPPORTED_VERSIONS = Object.freeze(['6.0.3']);
const ROOT = '/__klocgit_project__';
const LIB_ROOT = '/__klocgit_compiler_libs__';
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const typeFlags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;
let compilerLibraries;

function libraries() {
  if (!compilerLibraries) {
    // Only the trusted, installed compiler's bundled declarations touch disk.
    // Project files, package metadata and module resolution never fall back to fs.
    const directory = dirname(ts.getDefaultLibFilePath({}));
    compilerLibraries = new Map(
      readdirSync(directory)
        .filter((name) => /^lib(?:\.[a-z0-9.-]+)?\.d\.ts$/.test(name))
        .map((name) => [LIB_ROOT + '/' + name, readFileSync(directory + '/' + name, 'utf8')]),
    );
  }
  return compilerLibraries;
}

function result(status, effects = []) {
  return { capability: 'SEMANTIC', status, effects, security_effects: [] };
}

function virtualProject(project) {
  const files = new Map(project.files.map((file) => [ROOT + '/' + file.path, file.contents]));
  const contents = new Map([...libraries(), ...files]);
  const directories = new Set(['/']);
  for (const path of contents.keys()) {
    let directory = posix.dirname(path);
    while (!directories.has(directory)) {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const entries = (directory) => {
    const names = [...contents.keys()]
      .filter((path) => posix.dirname(path) === directory)
      .map((path) => posix.basename(path));
    const children = [...directories]
      .filter((path) => path !== directory && posix.dirname(path) === directory)
      .map((path) => posix.basename(path));
    return { files: names.sort(compare), directories: children.sort(compare) };
  };
  const io = {
    useCaseSensitiveFileNames: true,
    getCurrentDirectory: () => ROOT,
    readFile: (path) => contents.get(posix.normalize(path)),
    fileExists: (path) => contents.has(posix.normalize(path)),
    directoryExists: (path) => directories.has(posix.normalize(path)),
    getDirectories: (path) => entries(posix.normalize(path)).directories,
    realpath: (path) => posix.normalize(path),
    readDirectory: (path, extensions, excludes, includes, depth) =>
      ts.matchFiles(path, extensions, excludes, includes, true, ROOT, depth, entries, (p) => p),
  };
  return { files, io };
}

function compilerProject(project) {
  const { files, io } = virtualProject(project);
  const diagnostics = [];
  const limitations = [];
  const defaults = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    allowJs: true,
    checkJs: true,
    noEmit: true,
  };
  const configuration = files.has(ROOT + '/tsconfig.json')
    ? ROOT + '/tsconfig.json'
    : files.has(ROOT + '/jsconfig.json')
      ? ROOT + '/jsconfig.json'
      : null;
  const parsed = configuration
    ? ts.getParsedCommandLineOfConfigFile(configuration, undefined, {
        ...io,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      })
    : null;
  if (parsed) diagnostics.push(...parsed.errors);
  if (configuration && !parsed) limitations.push('unreadable-compiler-configuration');
  if (parsed?.projectReferences?.length) limitations.push('project-references-not-built');
  const options = { ...(parsed?.options ?? defaults), noEmit: true, incremental: false };
  const rootNames =
    parsed?.fileNames ?? [...files.keys()].filter((path) => sourceExtension.test(path));
  if (!rootNames.length) limitations.push('no-supported-source-files');
  if (!project.complete) limitations.push('partial-hydration');
  if (project.files.some((file) => file.path.includes('\\')))
    limitations.push('compiler-path-separator-ambiguity');
  const host = {
    ...io,
    getSourceFile: (path, languageVersion) => {
      const contents = io.readFile(path);
      return contents === undefined
        ? undefined
        : ts.createSourceFile(path, contents, languageVersion, true);
    },
    getDefaultLibFileName: (settings) =>
      LIB_ROOT + '/' + basename(ts.getDefaultLibFilePath(settings)),
    getDefaultLibLocation: () => LIB_ROOT,
    writeFile: () => {
      throw new Error('Analysis never emits files');
    },
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram({
    rootNames,
    options,
    host,
    projectReferences: parsed?.projectReferences,
  });
  diagnostics.push(...ts.getPreEmitDiagnostics(program));
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
    limitations.push('compiler-errors');
  const diagnosticCounts = new Map();
  for (const diagnostic of diagnostics) {
    const path = diagnostic.file?.fileName;
    const observation = {
      path: path?.startsWith(ROOT + '/') ? path.slice(ROOT.length + 1) : null,
      code: diagnostic.code,
      category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
    };
    const key = JSON.stringify(observation);
    const item = diagnosticCounts.get(key) ?? { ...observation, count: 0 };
    item.count += 1;
    diagnosticCounts.set(key, item);
  }
  return {
    program,
    files,
    resolveModule: (specifier, file) =>
      ts.resolveModuleName(
        specifier.text,
        file.fileName,
        options,
        io,
        undefined,
        undefined,
        program.getModeForUsageLocation(file, specifier),
      ).resolvedModule,
    scope: {
      compiler_version: ts.version,
      configuration: configuration?.slice(ROOT.length + 1) ?? 'default-in-memory-project',
      compiler_options: {
        target: options.target ?? null,
        module: options.module ?? null,
        module_resolution: options.moduleResolution ?? null,
        strict: options.strict ?? null,
        check_js: options.checkJs ?? null,
        allow_js: options.allowJs ?? null,
        jsx: options.jsx ?? null,
        lib: options.lib ?? null,
        types: options.types ?? null,
        paths: options.paths ?? {},
        base_url: options.baseUrl ?? null,
      },
      source_files: program
        .getSourceFiles()
        .map((file) => file.fileName)
        .filter((path) => files.has(path))
        .map((path) => path.slice(ROOT.length + 1))
        .sort(compare),
      limitations: [...new Set(limitations)].sort(compare),
      diagnostics: [...diagnosticCounts.values()].sort((a, b) =>
        compare(JSON.stringify(a), JSON.stringify(b)),
      ),
    },
  };
}

function symbolObservation(checker, symbol, location, files) {
  const valueType = checker.getTypeOfSymbolAtLocation(symbol, location);
  const declaredType =
    symbol.flags & ts.SymbolFlags.Type ? checker.getDeclaredTypeOfSymbol(symbol) : null;
  const render = (type, node = location) => checker.typeToString(type, node, typeFlags);
  const surface = (type) => ({
    type: render(type),
    members: checker
      .getPropertiesOfType(type)
      .filter((member) =>
        member.declarations?.some((declaration) => files.has(declaration.getSourceFile().fileName)),
      )
      .map((member) => ({
        name: member.getName().startsWith('__@')
          ? checker.symbolToString(member, location, ts.SymbolFlags.Property)
          : member.getName(),
        optional: Boolean(member.flags & ts.SymbolFlags.Optional),
        readonly_declaration: Boolean(
          member.declarations?.some(
            (declaration) => ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly,
          ),
        ),
        type: render(
          checker.getTypeOfSymbolAtLocation(
            member,
            member.valueDeclaration ?? member.declarations?.[0] ?? location,
          ),
        ),
      }))
      .sort((a, b) => compare(a.name, b.name)),
    calls: checker
      .getSignaturesOfType(type, ts.SignatureKind.Call)
      .map((signature) => checker.signatureToString(signature, location, typeFlags)),
    constructs: checker
      .getSignaturesOfType(type, ts.SignatureKind.Construct)
      .map((signature) => checker.signatureToString(signature, location, typeFlags)),
    indexes: checker.getIndexInfosOfType(type).map((index) => ({
      key: render(index.keyType),
      value: render(index.type),
      readonly: index.isReadonly,
    })),
  });
  return { value: surface(valueType), declared: declaredType ? surface(declaredType) : null };
}

async function observations(project) {
  const { program, files, scope, resolveModule } = compilerProject(project);
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles().filter((file) => files.has(file.fileName));
  const nodeOrder = new Map();
  for (const file of sourceFiles) {
    let ordinal = 0;
    const visit = (node) => {
      nodeOrder.set(node, ordinal++);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const declarationIdentity = (declaration) => {
    const file = declaration.getSourceFile();
    if (!files.has(file.fileName)) return null;
    const names = [];
    for (let node = declaration; node && !ts.isSourceFile(node); node = node.parent) {
      if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)))
        names.unshift(node.name.text);
    }
    return (
      file.fileName.slice(ROOT.length + 1) +
      '#' +
      names.join('/') +
      ':' +
      nodeOrder.get(declaration)
    );
  };
  const unalias = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const identities = (symbol) =>
    [
      ...new Set((unalias(symbol).declarations ?? []).map(declarationIdentity).filter(Boolean)),
    ].sort(compare);
  const entries = new Map();
  const record = (kind, target, attributes, references = []) =>
    entries.set(kind + ':' + target, {
      kind,
      target,
      attributes,
      references: [...new Set(references)].sort(compare),
    });
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  for (const file of sourceFiles) {
    const path = file.fileName.slice(ROOT.length + 1);
    record('semantic-source', path, {
      compiler_ast_digest: await digestBytes(
        'typescript-compiler-ast',
        new TextEncoder().encode(printer.printFile(file)),
      ),
    });
    const moduleSymbol = checker.getSymbolAtLocation(file);
    const exported = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    for (const symbol of exported.sort((a, b) => compare(a.getName(), b.getName()))) {
      const resolved = unalias(symbol);
      record(
        'semantic-export',
        path + '#export:' + symbol.getName(),
        {
          ...symbolObservation(
            checker,
            resolved,
            resolved.valueDeclaration ?? resolved.declarations?.[0] ?? file,
            files,
          ),
        },
        identities(symbol),
      );
    }
    const edges = new Map();
    const calls = new Map();
    const observeModule = (specifier) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        scope.limitations.push('dynamic-module-dependency');
      } else if (
        !checker.getSymbolAtLocation(specifier) &&
        !resolveModule(specifier, file) &&
        !checker
          .getAmbientModules()
          .some((symbol) => symbol.getName() === JSON.stringify(specifier.text))
      ) {
        scope.limitations.push('unresolved-module-dependency');
      }
    };
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        observeModule(node.moduleSpecifier);
      if (ts.isExternalModuleReference(node)) observeModule(node.expression);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        observeModule(node.argument.literal);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        observeModule(node.arguments[0]);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      ) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        // A project-defined function or parameter named require is an ordinary
        // resolved call. Ambient/unbound require is a module-loader dependency.
        if (
          !symbol?.declarations?.length ||
          symbol.declarations?.every((declaration) => declaration.getSourceFile().isDeclarationFile)
        )
          observeModule(node.arguments[0]);
      }
      if (
        ts.isIdentifier(node) &&
        (node.parent?.name !== node ||
          ts.isPropertyAccessExpression(node.parent) ||
          ts.isShorthandPropertyAssignment(node.parent))
      ) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        if (symbol) {
          const targets = identities(symbol);
          if (targets.length) {
            const edge = {
              symbols: targets,
              type: checker.typeToString(checker.getTypeAtLocation(node), node, typeFlags),
            };
            edges.set(JSON.stringify(edge), edge);
          }
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        if (signature) {
          const declaration = signature.getDeclaration();
          const call = {
            symbol: declaration ? declarationIdentity(declaration) : null,
            signature: checker.signatureToString(signature, node, typeFlags),
            return_type: checker.typeToString(
              checker.getReturnTypeOfSignature(signature),
              node,
              typeFlags,
            ),
          };
          calls.set(JSON.stringify(call), call);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    const resolvedReferences = [...edges.values()].sort((a, b) =>
      compare(JSON.stringify(a), JSON.stringify(b)),
    );
    const resolvedCalls = [...calls.values()].sort((a, b) =>
      compare(JSON.stringify(a), JSON.stringify(b)),
    );
    record('semantic-reference', path, { symbols: resolvedReferences, calls: resolvedCalls }, [
      ...resolvedReferences.flatMap((edge) => edge.symbols),
      ...resolvedCalls.map((call) => call.symbol).filter(Boolean),
    ]);
  }
  scope.limitations = [...new Set(scope.limitations)].sort(compare);
  return { entries, scope };
}

export class TypeScriptSemanticPlugin {
  constructor({ loadProject, language = 'typescript', toolchain_version = ts.version } = {}) {
    if (typeof loadProject !== 'function') throw new V1Error('INVALID_ARGUMENT');
    this.id = 'typescript-semantic';
    this.version = '1.0.0';
    this.capability = 'SEMANTIC';
    this.loadProject = loadProject;
    this.language = language;
    this.toolchain_version = toolchain_version;
  }

  capabilities(language, toolchain_version) {
    return extractorCapabilities({
      schema_version: 1,
      language,
      toolchain_version,
      supported_versions: [...TYPESCRIPT_SUPPORTED_VERSIONS],
      capability: 'SEMANTIC',
      status:
        ['typescript', 'javascript'].includes(language) &&
        toolchain_version === ts.version &&
        TYPESCRIPT_SUPPORTED_VERSIONS.includes(ts.version)
          ? 'COMPLETE'
          : 'UNSUPPORTED',
    });
  }

  async analyze(base, revision) {
    try {
      if (this.capabilities(this.language, this.toolchain_version).status !== 'COMPLETE')
        return result('UNSUPPORTED');
      const baseline = FutureRevision(base);
      const observed = FutureRevision(revision);
      if (baseline.repo_id !== observed.repo_id || baseline.system_id !== observed.system_id)
        throw new V1Error('INVALID_ARGUMENT');
      const before = await observations(
        analysisProject(await this.loadProject(baseline), baseline),
      );
      const after = await observations(analysisProject(await this.loadProject(observed), observed));
      const effects = [];
      for (const key of [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort(
        compare,
      )) {
        const previous = before.entries.get(key);
        const current = after.entries.get(key);
        if (JSON.stringify(previous) === JSON.stringify(current)) continue;
        effects.push({
          schema_version: 1,
          kind: (current ?? previous).kind,
          target: (current ?? previous).target,
          operation: previous ? (current ? 'modified' : 'removed') : 'added',
          attributes: {
            basis: 'OBSERVED',
            method: 'typescript-compiler-ast-and-typechecker',
            compiler_version: ts.version,
            before: previous?.attributes ?? null,
            after: current?.attributes ?? null,
          },
          references: [
            ...new Set([...(previous?.references ?? []), ...(current?.references ?? [])]),
          ].sort(compare),
        });
      }
      effects.push({
        schema_version: 1,
        kind: 'semantic-scope',
        target: 'typescript:project',
        operation: 'observed',
        attributes: {
          basis: 'OBSERVED',
          method: 'typescript-compiler-ast-and-typechecker',
          scope: 'provided-project-files-and-trusted-compiler-libraries',
          before: before.scope,
          after: after.scope,
        },
        references: [],
      });
      return result(
        before.scope.limitations.length || after.scope.limitations.length ? 'PARTIAL' : 'COMPLETE',
        effects,
      );
    } catch {
      return result('FAILED');
    }
  }
}
