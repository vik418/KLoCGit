"""Observe compiler bindings without importing or executing producer code.

CPython compilation and symtable establish name scopes. AST fingerprints
describe source changes, without claiming behavior or semantic equivalence.
Dynamic dispatch, unresolved imports/calls, and missing source yield PARTIAL.
The caller supplies the isolated, credential-free execution environment.
"""

import ast
import builtins
import hashlib
import json
import symtable
import sys

PROTOCOL = "klocgit-python-analysis-v1"
SUPPORTED_VERSIONS = ("3.12.14",)
RUNTIME_VERSION = ".".join(str(part) for part in sys.version_info[:3])
CPYTHON_RUNTIME = (
    sys.implementation.name == "cpython"
    and sys.version_info.releaselevel == "final"
)
BUILTIN_NAMES = frozenset(vars(builtins))
REFLECTIVE_CALLS = frozenset(
    (
        "eval",
        "exec",
        "compile",
        "__import__",
        "getattr",
        "setattr",
        "delattr",
        "globals",
        "locals",
        "vars",
    )
)
SECURITY_CALLS = {
    "builtins.eval": "dynamic-code",
    "builtins.exec": "dynamic-code",
    "builtins.compile": "dynamic-code",
    "builtins.__import__": "dynamic-import",
    "builtins.open": "filesystem",
    "os.system": "process",
    "os.popen": "process",
    "os.execv": "process",
    "os.execve": "process",
    "subprocess.run": "process",
    "subprocess.Popen": "process",
    "subprocess.call": "process",
    "subprocess.check_call": "process",
    "subprocess.check_output": "process",
    "pickle.load": "deserialization",
    "pickle.loads": "deserialization",
    "marshal.loads": "deserialization",
    "socket.socket": "network",
    "urllib.request.urlopen": "network",
}


def _record(kind, target, attributes, references=()):
    """Build a static inventory entry with canonical reference ordering."""
    return {
        "kind": kind,
        "target": target,
        "attributes": attributes,
        "references": sorted(set(references)),
    }


def _effect(record, operation, before=None):
    """Convert an inventory entry into the normalized domain effect schema."""
    attributes = record["attributes"]
    if operation in ("added", "modified", "removed"):
        attributes = {
            "claim": "static-compiler-observation",
            "before": before["attributes"] if before else None,
            "after": None if operation == "removed" else attributes,
        }
    references = record["references"] + (before["references"] if before else [])
    return {
        "schema_version": 1,
        "kind": record["kind"],
        "target": record["target"],
        "operation": operation,
        "attributes": attributes,
        "references": sorted(set(references)),
    }


def _fingerprint(node):
    """Hash AST structure with line positions and comments excluded."""
    data = ast.dump(
        node, annotate_fields=True, include_attributes=False
    ).encode()
    digest = hashlib.sha256(b"klocgit:v1:python-ast\0" + data).hexdigest()
    return "sha256:python-ast:v1:" + digest


def _module_name(path):
    """Map repository-root packages without executing import machinery."""
    parts = path[:-3].split("/")
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


class Scope:
    """A compiler scope and the source bindings owned by that scope."""

    def __init__(self, table, path, parent=None, suffix="module"):
        """Index compiler scopes independently of source positions."""
        self.table = table
        self.path = path
        self.parent = parent
        self.target = path + "#" + suffix
        self.bindings = {}
        self.children = []
        counts = {}
        for child in table.get_children():
            name = child.get_name()
            counts[name] = counts.get(name, 0) + 1
            unique = (
                name if counts[name] == 1 else name + "@" + str(counts[name])
            )
            self.children.append(
                Scope(child, path, self, suffix + "/" + unique)
            )

    def child(self, node, name):
        """Locate AST scopes using compiler identities."""
        matches = [
            child
            for child in self.children
            if child.table.get_name() == name
            and child.table.get_lineno() == node.lineno
        ]
        if len(matches) != 1:
            raise ValueError("Ambiguous compiler scope")
        return matches[0]

    def binding(self, name):
        """Resolve a name using compiler global/free/local classifications.

        Args:
            name: The source identifier to resolve.

        Returns:
            A (scope, symbol, target) tuple; missing scopes denote builtins or
            unresolved globals. Class locals are excluded from closure lookup.
        """
        try:
            symbol = self.table.lookup(name)
        except KeyError:
            return None, None, "unresolved:" + name
        if self.parent is None or symbol.is_global():
            module = self
            while module.parent is not None:
                module = module.parent
            try:
                global_symbol = module.table.lookup(name)
            except KeyError:
                global_symbol = None
            if symbol.is_global() and symbol.is_assigned():
                return module, symbol, module.target + ":" + name
            if global_symbol and (
                global_symbol.is_assigned()
                or global_symbol.is_imported()
                or global_symbol.is_namespace()
            ):
                return module, symbol, module.target + ":" + name
            if name in BUILTIN_NAMES:
                return None, symbol, "builtins." + name
            return None, symbol, "unresolved:" + name
        if symbol.is_free() or symbol.is_nonlocal():
            parent = self.parent
            while parent is not None:
                if parent.table.get_type() != "class":
                    try:
                        candidate = parent.table.lookup(name)
                    except KeyError:
                        candidate = None
                    if candidate and candidate.is_local():
                        return parent, symbol, parent.target + ":" + name
                parent = parent.parent
            return None, symbol, "unresolved:" + name
        return self, symbol, self.target + ":" + name


class Project:
    """Compiler inventory of one immutable hydrated repository snapshot."""

    def __init__(self, project):
        """Compile hydrated sources and observe their static module graph."""
        self.complete = project["complete"]
        self.modules = {}
        self.records = {}
        self.uncertainties = {}
        self.security = {}
        self.import_edges = {}
        for file in sorted(project["files"], key=lambda value: value["path"]):
            path = file["path"]
            if not path.endswith(".py"):
                continue
            source = file["contents"]
            tree = ast.parse(
                source,
                filename=path,
                type_comments=True,
                feature_version=(3, 12),
            )
            # Compilation rejects invalid nonlocals and duplicate arguments
            # accepted by ast.parse, without evaluating the code object.
            compile(source, path, "exec", dont_inherit=True, optimize=0)
            table = symtable.symtable(source, path, "exec")
            name = _module_name(path)
            if not name or name in self.modules:
                self.uncertain(path, "ambiguous-module-layout")
            self.modules[name] = (path, tree, Scope(table, path))
            self.put(
                _record(
                    "python-module",
                    path,
                    {
                        "claim": "compiler-validated-source",
                        "module": name,
                        "ast_digest": _fingerprint(tree),
                    },
                )
            )
        for name, (path, tree, scope) in self.modules.items():
            BindingCollector(self, name, scope).visit(tree)
        for name, (path, tree, scope) in self.modules.items():
            Observer(self, name, scope).visit(tree)
            self.observe_scope(scope)
        self.observe_cycles()
        if not self.complete:
            self.uncertain("project", "incomplete-hydration")

    def put(self, record):
        """Store a uniquely identified static observation."""
        self.records[(record["kind"], record["target"])] = record

    def uncertain(self, target, reason):
        """Retain explicit reasons without arbitrary compiler diagnostics."""
        key = target + "#" + reason
        self.uncertainties[key] = _record(
            "python-uncertainty",
            key,
            {
                "claim": "analysis-boundary",
                "reason": reason,
            },
        )

    def resolve_import(self, module, node, alias):
        """Resolve hydrated imports without sys.path or installed code."""
        if isinstance(node, ast.Import):
            imported = alias.name
            selected = imported if alias.asname else imported.split(".")[0]
            symbol_name = None
            if imported not in self.modules:
                return selected, symbol_name, "unresolved-import"
        else:
            package = module.split(".")
            if not self.modules[module][0].endswith("/__init__.py"):
                package.pop()
            if node.level:
                if node.level > len(package) + 1:
                    return None, None, "unresolved-relative-import"
                package = package[: len(package) - node.level + 1]
                imported = ".".join(
                    package + ([node.module] if node.module else [])
                )
            else:
                imported = node.module or ""
            selected = imported
            symbol_name = alias.name
            # `from package import module` may bind a hydrated submodule rather
            # than a symbol; no package initializer is executed to decide this.
            submodule = imported + "." + alias.name
            if selected in self.modules:
                root = self.modules[selected][2]
                if symbol_name in root.table.get_identifiers():
                    return selected, symbol_name, None
            if submodule in self.modules:
                return submodule, None, None
        if selected not in self.modules:
            return selected, symbol_name, "unresolved-import"
        if symbol_name:
            root = self.modules[selected][2]
            if symbol_name == "*":
                return selected, symbol_name, "star-import"
            if symbol_name not in root.table.get_identifiers():
                return selected, symbol_name, "unresolved-import-symbol"
        return selected, symbol_name, None

    def observe_scope(self, scope):
        """Emit compiler symbols, including synthetic comprehension scopes."""
        for symbol in scope.table.get_symbols():
            name = symbol.get_name()
            owner, _, reference = scope.binding(name)
            flags = {
                key: bool(getattr(symbol, "is_" + key)())
                for key in (
                    "local",
                    "global",
                    "nonlocal",
                    "free",
                    "parameter",
                    "imported",
                    "assigned",
                    "referenced",
                    "namespace",
                )
            }
            if symbol.is_referenced() and reference.startswith("unresolved:"):
                self.uncertain(scope.target + ":" + name, "unresolved-name")
            bindings = scope.bindings.get(name, [])
            if len(bindings) > 1:
                self.uncertain(scope.target + ":" + name, "rebound-name")
            self.put(
                _record(
                    "python-symbol",
                    scope.target + ":" + name,
                    {
                        "claim": "static-lexical-binding",
                        "scope_type": scope.table.get_type(),
                        "flags": flags,
                        "binding_target": reference,
                    },
                    [reference] if symbol.is_referenced() else [],
                )
            )
        for child in scope.children:
            self.observe_scope(child)

    def observe_cycles(self):
        """Retain uncertainty for cyclic module initialization order."""
        done = set()

        def visit(module, active):
            if module in done:
                return
            if module in active:
                self.uncertain(self.modules[module][0], "cyclic-import")
                return
            for dependency in sorted(self.import_edges.get(module, ())):
                if dependency in self.modules:
                    visit(dependency, active | {module})
            done.add(module)

        for module in self.modules:
            visit(module, set())


class BindingCollector(ast.NodeVisitor):
    """Associate declarations with compiler scopes before resolving names."""

    def __init__(self, project, module, scope):
        """Associate AST declarations with a validated compiler scope."""
        self.project = project
        self.module = module
        self.scope = scope

    def bind(self, name, node):
        """Record bindings using compiler ownership for nonlocal/global."""
        owner, _, _ = self.scope.binding(name)
        if owner is not None:
            owner.bindings.setdefault(name, []).append(node)

    def visit_Name(self, node):
        """Collect stores and deletions that may rebind call candidates."""
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.bind(node.id, node)

    def visit_Import(self, node):
        """Collect aliases using Python's top-level module binding rule."""
        for alias in node.names:
            self.bind(alias.asname or alias.name.split(".")[0], (node, alias))

    def visit_ImportFrom(self, node):
        """Collect imported names and retain star-import uncertainty."""
        for alias in node.names:
            if alias.name == "*":
                self.project.uncertain(self.scope.target, "star-import")
            else:
                self.bind(alias.asname or alias.name, (node, alias))

    def visit_FunctionDef(self, node):
        """Collect a function declaration and visit its compiler-owned body."""
        self.bind(node.name, node)
        if node.type_params:
            self.project.uncertain(
                self.scope.target + ":" + node.name, "generic-type-scope"
            )
            return
        for item in (
            node.decorator_list + node.args.defaults + node.args.kw_defaults
        ):
            if item is not None:
                self.visit(item)
        child = self.scope.child(node, node.name)
        old_scope = self.scope
        self.scope = child
        for statement in node.body:
            self.visit(statement)
        self.scope = old_scope

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        """Collect class-local declarations without mixing enclosing scopes."""
        self.bind(node.name, node)
        if node.type_params:
            self.project.uncertain(
                self.scope.target + ":" + node.name, "generic-type-scope"
            )
            return
        old_scope = self.scope
        self.scope = self.scope.child(node, node.name)
        for statement in node.body:
            self.visit(statement)
        self.scope = old_scope

    def visit_Lambda(self, node):
        """Retain uncertainty for callable values in synthetic scopes."""
        # Synthetic scopes are still inventoried from symtable. Their dynamic
        # callable/data flow is outside this bounded implementation.
        self.project.uncertain(self.scope.target, "lambda-data-flow")

    def visit_ListComp(self, node):
        """Retain uncertainty for synthetic comprehension data flow."""
        self.project.uncertain(self.scope.target, "comprehension-data-flow")

    visit_SetComp = visit_ListComp
    visit_DictComp = visit_ListComp
    visit_GeneratorExp = visit_ListComp


class Observer(BindingCollector):
    """Observe references and flag operations that require dynamic facts."""

    def __init__(self, project, module, scope):
        """Prepare ordered call identities within each compiler scope."""
        super().__init__(project, module, scope)
        self.call_counts = {}

    def bind(self, name, node):
        """Preserve the binding inventory collected during the first pass."""
        # Bindings include declarations from later files after the first pass.
        return None

    def imported_target(self, binding):
        """Resolve imported call candidates in the hydrated module graph."""
        node, alias = binding
        module, name, error = self.project.resolve_import(
            self.module, node, alias
        )
        identity = (module or "") + ("." + name if name else "")
        if error:
            return identity, False
        path, _, scope = self.project.modules[module]
        declarations = scope.bindings.get(name, [])
        known = (
            len(declarations) == 1
            and isinstance(
                declarations[0], (ast.FunctionDef, ast.AsyncFunctionDef)
            )
            and not declarations[0].decorator_list
        )
        return scope.target + ":" + name if name else path, known

    def callable_target(self, node):
        """Resolve call candidates while retaining shadowing and rebinding."""
        if isinstance(node, ast.Name):
            owner, _, reference = self.scope.binding(node.id)
            if owner is None:
                return reference, reference.startswith("builtins.")
            bindings = owner.bindings.get(node.id, [])
            if len(bindings) != 1:
                return reference, False
            binding = bindings[0]
            if isinstance(binding, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return reference, not binding.decorator_list
            if isinstance(binding, tuple):
                return self.imported_target(binding)
            return reference, False
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            owner, _, _ = self.scope.binding(node.value.id)
            bindings = owner.bindings.get(node.value.id, []) if owner else []
            if len(bindings) == 1 and isinstance(bindings[0], tuple):
                import_node, alias = bindings[0]
                module, name, error = self.project.resolve_import(
                    self.module, import_node, alias
                )
                identity = (
                    (module or "")
                    + ("." + name if name else "")
                    + "."
                    + node.attr
                )
                if error or name:
                    return identity, False
                path, _, root = self.project.modules[module]
                if node.attr in root.table.get_identifiers():
                    declarations = root.bindings.get(node.attr, [])
                    known = (
                        len(declarations) == 1
                        and isinstance(
                            declarations[0],
                            (ast.FunctionDef, ast.AsyncFunctionDef),
                        )
                        and not declarations[0].decorator_list
                    )
                    return root.target + ":" + node.attr, known
                return path + "#module:" + node.attr, False
        return "unresolved:dynamic-call", False

    def visit_Import(self, node):
        """Observe imports after all project bindings have been indexed."""
        for alias in node.names:
            self.observe_import(node, alias)

    visit_ImportFrom = visit_Import

    def observe_import(self, node, alias):
        """Record hydrated imports and unresolved external boundaries."""
        name = alias.asname or (
            alias.name.split(".")[0]
            if isinstance(node, ast.Import)
            else alias.name
        )
        module, symbol, error = self.project.resolve_import(
            self.module, node, alias
        )
        target = self.scope.target + ":" + name
        reference = (module or "") + ("." + symbol if symbol else "")
        if error:
            self.project.uncertain(target, error)
        else:
            path, _, root = self.project.modules[module]
            reference = root.target + ":" + symbol if symbol else path
            self.project.import_edges.setdefault(self.module, set()).add(module)
        self.project.put(
            _record(
                "python-import",
                target,
                {
                    "claim": "static-import-binding",
                    "resolved": error is None,
                    "imported_module": module,
                    "imported_symbol": symbol,
                },
                [reference] if reference else [],
            )
        )

    def visit_FunctionDef(self, node):
        """Observe declarations, defaults, and annotation references."""
        if node.decorator_list:
            self.project.uncertain(
                self.scope.target + ":" + node.name, "runtime-decorator"
            )
        if node.type_params:
            self.project.uncertain(
                self.scope.target + ":" + node.name, "generic-type-scope"
            )
            return
        self.project.put(
            _record(
                "python-declaration",
                self.scope.target + ":" + node.name,
                {
                    "claim": "compiler-validated-declaration",
                    "declaration": type(node).__name__,
                    "ast_digest": _fingerprint(node),
                    "signature": ast.dump(node.args, include_attributes=False),
                },
            )
        )
        # Annotations are expressions in the enclosing scope in Python 3.12;
        # __future__ changes evaluation, so no annotation value is asserted.
        annotations = [
            arg.annotation
            for arg in node.args.posonlyargs
            + node.args.args
            + node.args.kwonlyargs
        ]
        if node.args.vararg:
            annotations.append(node.args.vararg.annotation)
        if node.args.kwarg:
            annotations.append(node.args.kwarg.annotation)
        annotations.append(node.returns)
        for annotation in annotations:
            if annotation is not None:
                self.visit(annotation)
        super().visit_FunctionDef(node)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        """Retain uncertainty for metaclasses, inheritance, and descriptors."""
        self.project.uncertain(
            self.scope.target + ":" + node.name, "runtime-class-model"
        )
        if node.type_params:
            self.project.uncertain(
                self.scope.target + ":" + node.name, "generic-type-scope"
            )
            return
        for expression in (
            node.bases
            + node.decorator_list
            + [value.value for value in node.keywords]
        ):
            self.visit(expression)
        super().visit_ClassDef(node)

    def visit_TypeAlias(self, node):
        """Retain uncertainty for Python 3.12's generic type scopes."""
        self.project.uncertain(self.scope.target, "generic-type-scope")

    def visit_Call(self, node):
        """Observe lexical call references without asserting that calls ran."""
        reference, resolved = self.callable_target(node.func)
        self.call_counts[self.scope.target] = (
            self.call_counts.get(self.scope.target, 0) + 1
        )
        target = (
            self.scope.target
            + ":call@"
            + str(self.call_counts[self.scope.target])
        )
        dynamic_args = any(
            isinstance(arg, ast.Starred) for arg in node.args
        ) or any(keyword.arg is None for keyword in node.keywords)
        if not resolved:
            self.project.uncertain(target, "unresolved-call")
        if dynamic_args:
            self.project.uncertain(target, "dynamic-call-arguments")
        if reference.startswith("builtins."):
            builtin = reference.removeprefix("builtins.")
            if builtin in REFLECTIVE_CALLS:
                self.project.uncertain(target, "runtime-reflection")
            else:
                # Builtins can dispatch to producer __len__, __str__, etc.
                if not all(
                    _literal(arg)
                    for arg in node.args
                    + [value.value for value in node.keywords]
                ):
                    self.project.uncertain(target, "dynamic-builtin-dispatch")
        self.project.put(
            _record(
                "python-call",
                target,
                {
                    "claim": "static-call-reference",
                    "resolved": resolved,
                    "callable": reference,
                    "positional_arguments": len(node.args),
                    "keyword_arguments": [
                        keyword.arg for keyword in node.keywords
                    ],
                },
                [reference],
            )
        )
        if reference in SECURITY_CALLS:
            security_target = target + "->" + reference
            self.project.security[security_target] = _record(
                "python-security-call",
                security_target,
                {
                    "claim": "observed-static-call",
                    "category": SECURITY_CALLS[reference],
                    "callable": reference,
                },
                [reference],
            )
        # Imported module attribute calls were resolved above; generic attribute
        # visitation would misclassify the known module access as dynamic.
        if (
            isinstance(node.func, ast.Attribute)
            and reference != "unresolved:dynamic-call"
        ):
            self.visit(node.func.value)
        else:
            self.visit(node.func)
        for argument in node.args + [
            keyword.value for keyword in node.keywords
        ]:
            self.visit(argument)

    def visit_Attribute(self, node):
        """Retain uncertainty for descriptor and attribute lookup protocols."""
        self.project.uncertain(self.scope.target, "dynamic-attribute")
        self.generic_visit(node)

    def visit_BinOp(self, node):
        """Retain operator dispatch uncertainty for nonliteral operands."""
        if not (_literal(node.left) and _literal(node.right)):
            self.project.uncertain(
                self.scope.target, "dynamic-operator-dispatch"
            )
        self.generic_visit(node)

    def visit_UnaryOp(self, node):
        """Retain unary protocol uncertainty for nonliteral operands."""
        if not _literal(node.operand):
            self.project.uncertain(
                self.scope.target, "dynamic-operator-dispatch"
            )
        self.generic_visit(node)

    def visit_Compare(self, node):
        """Retain comparison protocol uncertainty for nonliteral operands."""
        if not all(_literal(value) for value in [node.left] + node.comparators):
            self.project.uncertain(
                self.scope.target, "dynamic-operator-dispatch"
            )
        self.generic_visit(node)

    def visit_BoolOp(self, node):
        """Retain truthiness protocol uncertainty for nonliteral operands."""
        if not all(_literal(value) for value in node.values):
            self.project.uncertain(self.scope.target, "dynamic-truthiness")
        self.generic_visit(node)

    def visit_If(self, node):
        """Retain truthiness protocol uncertainty in conditional statements."""
        if not _literal(node.test):
            self.project.uncertain(self.scope.target, "dynamic-truthiness")
        self.generic_visit(node)

    visit_While = visit_If
    visit_IfExp = visit_If
    visit_Assert = visit_If

    def visit_For(self, node):
        """Retain iterator protocol uncertainty for nonliteral iterables."""
        if not _literal(node.iter):
            self.project.uncertain(self.scope.target, "dynamic-iteration")
        self.generic_visit(node)

    def visit_Subscript(self, node):
        """Retain uncertainty for user-defined indexing protocols."""
        if not (_literal(node.value) and _literal(node.slice)):
            self.project.uncertain(self.scope.target, "dynamic-subscript")
        self.generic_visit(node)

    def visit_AugAssign(self, node):
        """Retain uncertainty for in-place operator dispatch."""
        self.project.uncertain(self.scope.target, "dynamic-operator-dispatch")
        self.generic_visit(node)

    def visit_Assign(self, node):
        """Retain uncertainty for unpacking a user-defined iterator."""
        if any(
            isinstance(target, (ast.Tuple, ast.List)) for target in node.targets
        ):
            if not _literal(node.value):
                self.project.uncertain(self.scope.target, "dynamic-unpacking")
        self.generic_visit(node)

    def visit_With(self, node):
        """Retain uncertainty for context-manager protocol execution."""
        self.project.uncertain(self.scope.target, "runtime-context-manager")
        self.generic_visit(node)

    visit_AsyncWith = visit_With

    def visit_Await(self, node):
        """Retain uncertainty for user-defined awaitable protocols."""
        self.project.uncertain(self.scope.target, "runtime-awaitable")
        self.generic_visit(node)

    def visit_YieldFrom(self, node):
        """Retain iterator protocol uncertainty for delegated generators."""
        if not _literal(node.value):
            self.project.uncertain(self.scope.target, "dynamic-iteration")
        self.generic_visit(node)

    def visit_AsyncFor(self, node):
        """Retain uncertainty for asynchronous iterator protocols."""
        self.project.uncertain(self.scope.target, "runtime-async-iteration")
        self.generic_visit(node)

    def visit_Match(self, node):
        """Retain uncertainty for pattern matching's attribute protocols."""
        self.project.uncertain(self.scope.target, "runtime-pattern-protocol")
        self.generic_visit(node)

    def visit_JoinedStr(self, node):
        """Retain uncertainty for user-defined formatting protocols."""
        self.project.uncertain(self.scope.target, "runtime-format-protocol")
        self.generic_visit(node)


def _literal(node):
    """Recognize literals that cannot dispatch to producer objects."""
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(_literal(value) for value in node.elts)
    if isinstance(node, ast.Dict):
        return all(
            key is not None and _literal(key) and _literal(value)
            for key, value in zip(node.keys, node.values)
        )
    return False


def _project_valid(project):
    """Validate the same closed project envelope accepted by the JS boundary."""
    expected = {
        "schema_version",
        "repo_id",
        "commit_oid",
        "tree_oid",
        "complete",
        "files",
    }
    if (
        not isinstance(project, dict)
        or set(project) != expected
        or project["schema_version"] != 1
    ):
        return False
    if not isinstance(project["complete"], bool) or not isinstance(
        project["files"], list
    ):
        return False
    if not all(
        isinstance(project[key], str) and project[key]
        for key in ("repo_id", "commit_oid", "tree_oid")
    ):
        return False
    paths = set()
    for file in project["files"]:
        if not isinstance(file, dict) or set(file) != {"path", "contents"}:
            return False
        path = file["path"]
        if (
            not isinstance(path, str)
            or not path
            or "\0" in path
            or path.startswith("/")
        ):
            return False
        if (
            any(part in ("", ".", "..") for part in path.split("/"))
            or path in paths
        ):
            return False
        if not isinstance(file["contents"], str):
            return False
        paths.add(path)
    return True


def analyze_request(request):
    """Analyze two exact source inventories through the narrow runner protocol.

    Args:
        request: JSON containing only versioned base/revision projects.

    Returns:
        A versioned compiler envelope with four-field semantic results. Compiler
        diagnostics and runtime exception messages are deliberately excluded.
    """
    result = {
        "capability": "SEMANTIC",
        "status": "FAILED",
        "effects": [],
        "security_effects": [],
    }
    envelope = {
        "schema_version": 1,
        "protocol": PROTOCOL,
        "toolchain_version": RUNTIME_VERSION,
        "result": result,
    }
    expected = {
        "schema_version",
        "protocol",
        "toolchain_version",
        "base",
        "revision",
    }
    if not isinstance(request, dict) or set(request) != expected:
        return envelope
    if request["schema_version"] != 1 or request["protocol"] != PROTOCOL:
        return envelope
    if (
        request["toolchain_version"] not in SUPPORTED_VERSIONS
        or RUNTIME_VERSION not in SUPPORTED_VERSIONS
        or not CPYTHON_RUNTIME
    ):
        result["status"] = "UNSUPPORTED"
        return envelope
    if not _project_valid(request["base"]) or not _project_valid(
        request["revision"]
    ):
        return envelope
    if request["base"]["repo_id"] != request["revision"]["repo_id"]:
        return envelope
    try:
        before = Project(request["base"])
        after = Project(request["revision"])
        for key in sorted(set(before.records) | set(after.records)):
            previous = before.records.get(key)
            current = after.records.get(key)
            if previous == current:
                continue
            operation = (
                "added"
                if previous is None
                else "removed"
                if current is None
                else "modified"
            )
            result["effects"].append(
                _effect(current or previous, operation, previous)
            )
        uncertainties = {**before.uncertainties, **after.uncertainties}
        result["effects"].extend(
            _effect(uncertainties[key], "observed")
            for key in sorted(uncertainties)
        )
        # Security observations are potential source calls, including removed
        # calls in the baseline, rather than evidence that a call ran.
        security = {**before.security, **after.security}
        result["security_effects"] = [
            _effect(security[key], "observed") for key in sorted(security)
        ]
        result["status"] = "PARTIAL" if uncertainties else "COMPLETE"
    except Exception:
        result.update(status="FAILED", effects=[], security_effects=[])
    return envelope


def main():
    """Read one JSON transport request without opening repository paths."""
    try:
        request = json.load(sys.stdin)
        envelope = analyze_request(request)
    except (ValueError, TypeError, RecursionError, MemoryError):
        envelope = analyze_request(None)
    json.dump(envelope, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
