# Analysis boundaries

Status: Accepted

Extractors report versioned observations for exact source snapshots. Their status
describes coverage, never global correctness or behavioral equivalence. Required
incomplete analysis blocks resolution.

| Adapter               | Tested toolchain                | Coverage                                                                |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| Git paths             | Git object format, contract v1  | Paths, modes, manifests; security path hints                            |
| Structure             | TypeScript 6.0.3                | Syntax, ordered declarations, signatures, bodies, unresolved references |
| TypeScript/JavaScript | TypeScript 6.0.3                | Compiler types, exports, resolved references and calls                  |
| Python                | CPython 3.12.14                 | Compiler scopes, lexical/import bindings and static call references     |
| Go                    | Go 1.26.9, 1.27.2               | Compiler types, local packages, declarations and static references      |
| Rust                  | Rust 1.90.0, editions 2021/2024 | Typed MIR functions and literal calls; always PARTIAL                   |

Python, Go and Rust use injected trusted runners. Their helpers do not execute
producer modules, build scripts or dependency downloads. Environment clearing is
not a sandbox: the runner must separately enforce filesystem, network and resource
isolation. TypeScript reads project files only from the supplied snapshot and
libraries only from the trusted installed compiler.

Rust's textual MIR cannot establish complete type, layout, export or reference
coverage. It is pinned to the exact compiler identity and cannot satisfy a policy
requiring complete Rust semantics.

Fixture tests cover supported versions, representative syntax/semantic changes,
failure status and source substitution. Scheduled compatibility CI runs the real
compilers. Broader version support requires additional fixture evidence.
