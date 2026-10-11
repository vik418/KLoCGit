// The helper checks producer source with go/types. It never invokes the producer
// toolchain, executes source, reads dependency caches, or fetches dependencies.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"go/ast"
	"go/build"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"go/version"
	"io"
	"os"
	"path"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type File struct {
	Path     string `json:"path"`
	Contents string `json:"contents"`
}
type Project struct {
	SchemaVersion int    `json:"schema_version"`
	RepoID        string `json:"repo_id"`
	CommitOID     string `json:"commit_oid"`
	TreeOID       string `json:"tree_oid"`
	Complete      bool   `json:"complete"`
	Files         []File `json:"files"`
}
type Request struct {
	SchemaVersion    int     `json:"schema_version"`
	ToolchainVersion string  `json:"toolchain_version"`
	Base             Project `json:"base"`
	Revision         Project `json:"revision"`
}
type Effect struct {
	SchemaVersion int            `json:"schema_version"`
	Kind          string         `json:"kind"`
	Target        string         `json:"target"`
	Operation     string         `json:"operation"`
	Attributes    map[string]any `json:"attributes"`
	References    []string       `json:"references"`
}
type Response struct {
	SchemaVersion    int      `json:"schema_version"`
	ToolchainVersion string   `json:"toolchain_version"`
	Capability       string   `json:"capability"`
	Status           string   `json:"status"`
	Effects          []Effect `json:"effects"`
	SecurityEffects  []Effect `json:"security_effects"`
}
type observation struct {
	Kind       string
	Target     string
	Attributes map[string]any
	References []string
}
type packageSource struct {
	files    []*ast.File
	checking bool
	checked  bool
	pkg      *types.Package
	info     *types.Info
}
type projectChecker struct {
	fset         *token.FileSet
	sources      map[string]string
	packages     map[string]*packageSource
	stdlib       types.Importer
	status       string
	goVersion    string
	observations map[string]observation
}

func supported(v string) bool { return v == "1.26.9" || v == "1.27.2" }
func fingerprint(value string) string {
	digest := sha256.Sum256([]byte(value))
	return "sha256:go-source:v1:" + hex.EncodeToString(digest[:])
}
func sortedSet(values []string) []string {
	set := map[string]bool{}
	for _, value := range values {
		if value != "" {
			set[value] = true
		}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
func (c *projectChecker) incomplete() {
	if c.status == "COMPLETE" {
		c.status = "PARTIAL"
	}
}
func (c *projectChecker) add(o observation) {
	o.References = sortedSet(o.References)
	c.observations[o.Kind+"\x00"+o.Target] = o
}
func moduleInfo(contents string) (module, language string, partial bool) {
	for _, line := range strings.Split(contents, "\n") {
		line = strings.TrimSpace(strings.SplitN(line, "//", 2)[0])
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "module":
			if len(fields) != 2 || module != "" {
				partial = true
				continue
			}
			module = strings.Trim(fields[1], "\"")
		case "go":
			if len(fields) != 2 || !version.IsValid("go"+fields[1]) {
				partial = true
				continue
			}
			language = "go" + fields[1]
		case "toolchain":
			// The helper uses its pinned toolchain; it never auto-downloads another.
			if len(fields) != 2 || fields[1] != "default" {
				partial = true
			}
		default:
			// Module graph directives require a dependency/workspace loader outside
			// this bounded plugin. Never claim that local source resolves the graph.
			partial = true
		}
	}
	if module == "" || strings.Contains(module, "..") || strings.HasPrefix(module, "/") {
		partial = true
		module = "klocgit.unresolved"
	}
	return
}

func inspectProject(p Project, toolchain string) *projectChecker {
	c := &projectChecker{fset: token.NewFileSet(), sources: map[string]string{}, packages: map[string]*packageSource{}, status: "COMPLETE", observations: map[string]observation{}, goVersion: "go" + toolchain}
	c.stdlib = importer.ForCompiler(c.fset, "source", nil)
	if !p.Complete {
		c.incomplete()
	}
	module := "klocgit.unresolved"
	modFound := false
	files := append([]File(nil), p.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	for _, file := range files {
		if file.Path == "go.mod" {
			var language string
			var partial bool
			module, language, partial = moduleInfo(file.Contents)
			modFound = true
			if partial {
				c.incomplete()
			}
			if language != "" {
				if version.Compare(language, "go"+toolchain) > 0 {
					c.status = "UNSUPPORTED"
				} else {
					c.goVersion = language
				}
			}
		}
		if path.Base(file.Path) == "go.mod" || path.Base(file.Path) == "go.sum" || path.Base(file.Path) == "go.work" || path.Base(file.Path) == "go.work.sum" {
			c.add(observation{Kind: "dependency", Target: file.Path, Attributes: map[string]any{"source_digest": fingerprint(file.Contents), "scope": "module-manifest"}, References: []string{}})
			if strings.Contains(file.Path, "/") || strings.HasPrefix(path.Base(file.Path), "go.work") {
				c.incomplete()
			}
		}
	}
	if !modFound {
		c.incomplete()
	}
	if c.status == "UNSUPPORTED" {
		return c
	}
	for _, file := range files {
		if !strings.HasSuffix(file.Path, ".go") {
			continue
		}
		// Conditional compilation, tests, generated assets, cgo, nested modules,
		// assembly and embedding require an explicit build-context loader.
		if strings.HasPrefix(path.Base(file.Path), ".") || strings.HasPrefix(path.Base(file.Path), "_") {
			continue
		}
		if strings.HasSuffix(file.Path, "_test.go") {
			c.incomplete()
			continue
		}
		conditional := strings.Contains(file.Contents, "//go:build") || strings.Contains(file.Contents, "// +build")
		if conditional || strings.Contains(file.Contents, "//go:embed") {
			c.incomplete()
		}
		stemParts := strings.Split(strings.TrimSuffix(path.Base(file.Path), ".go"), "_")
		platforms := " aix android darwin dragonfly freebsd hurd illumos ios js linux nacl netbsd openbsd plan9 solaris wasip1 windows unix 386 amd64 amd64p32 arm armbe arm64 arm64be loong64 mips mipsle mips64 mips64le ppc ppc64 ppc64le riscv riscv64 s390 s390x sparc sparc64 wasm "
		if len(stemParts) > 1 && strings.Contains(platforms, " "+stemParts[len(stemParts)-1]+" ") {
			conditional = true
			c.incomplete()
		}
		if strings.HasPrefix(file.Path, "vendor/") {
			c.incomplete()
			continue
		}
		c.sources[file.Path] = file.Contents
		parsed, err := parser.ParseFile(c.fset, file.Path, file.Contents, parser.AllErrors|parser.ParseComments)
		if err != nil {
			c.status = "FAILED"
			continue
		}
		cgo := false
		for _, imported := range parsed.Imports {
			if imported.Path.Value == "\"C\"" {
				cgo = true
				c.incomplete()
			}
		}
		if conditional || cgo {
			// Preserve unresolved build input as material without claiming the
			// excluded file belongs to the selected compiler configuration.
			c.add(observation{Kind: "build", Target: file.Path, Attributes: map[string]any{"source_digest": fingerprint(file.Contents), "scope": "unresolved-build-input"}, References: []string{}})
			continue
		}
		dir := path.Dir(file.Path)
		packagePath := module
		if dir != "." {
			packagePath += "/" + dir
		}
		group := c.packages[packagePath]
		if group == nil {
			group = &packageSource{}
			c.packages[packagePath] = group
		}
		group.files = append(group.files, parsed)
	}
	for _, file := range files {
		switch path.Ext(file.Path) {
		case ".s", ".S", ".c", ".h", ".syso":
			c.incomplete()
		}
	}
	if c.status == "FAILED" {
		return c
	}
	paths := make([]string, 0, len(c.packages))
	for key := range c.packages {
		paths = append(paths, key)
	}
	sort.Strings(paths)
	for _, key := range paths {
		_, _ = c.Import(key)
	}
	for _, key := range paths {
		c.collect(key, c.packages[key])
	}
	return c
}

func (c *projectChecker) Import(importPath string) (*types.Package, error) {
	if group := c.packages[importPath]; group != nil {
		if group.checked {
			if group.pkg == nil {
				return nil, errors.New("unresolved local package")
			}
			return group.pkg, nil
		}
		if group.checking {
			c.incomplete()
			return nil, errors.New("import cycle")
		}
		group.checking = true
		group.info = &types.Info{Types: map[ast.Expr]types.TypeAndValue{}, Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}, Selections: map[*ast.SelectorExpr]*types.Selection{}, Instances: map[*ast.Ident]types.Instance{}}
		config := types.Config{Importer: c, GoVersion: c.goVersion, Sizes: types.SizesFor("gc", "amd64"), Error: func(err error) {
			// Imported material absent from hydration is incomplete semantic input;
			// other compiler errors (including undefined local names) are FAILED.
			if strings.Contains(err.Error(), "could not import") {
				c.incomplete()
			} else {
				c.status = "FAILED"
			}
		}}
		pkg, err := config.Check(importPath, c.fset, group.files, group.info)
		group.pkg = pkg
		group.checking = false
		group.checked = true
		if err != nil && pkg == nil {
			return nil, err
		}
		return pkg, nil
	}
	// Only trusted GOROOT source is eligible. The source importer never calls
	// `go list`, opens producer dependency caches, or follows replacement paths.
	if importPath == "C" || strings.Contains(importPath, "\\") || strings.HasPrefix(importPath, ".") {
		c.incomplete()
		return nil, errors.New("unsupported dependency")
	}
	ctx := build.Default
	ctx.GOOS = "linux"
	ctx.GOARCH = "amd64"
	ctx.CgoEnabled = false
	pkg, err := ctx.Import(importPath, "", build.FindOnly)
	if err != nil || !pkg.Goroot {
		c.incomplete()
		return nil, errors.New("dependency is not hydrated")
	}
	resolved, err := c.stdlib.Import(importPath)
	if err != nil {
		c.incomplete()
	}
	return resolved, err
}

func qualifier(pkg *types.Package) string { return pkg.Path() }
func receiverName(t types.Type) string {
	t = types.Unalias(t)
	if pointer, ok := t.(*types.Pointer); ok {
		t = pointer.Elem()
	}
	if named, ok := t.(*types.Named); ok {
		return named.Obj().Pkg().Path() + "." + named.Obj().Name()
	}
	return types.TypeString(t, qualifier)
}
func fieldID(selection *types.Selection) string {
	current := selection.Recv()
	for position, index := range selection.Index() {
		current = types.Unalias(current)
		if pointer, ok := current.(*types.Pointer); ok {
			current = pointer.Elem()
		}
		structure, ok := current.Underlying().(*types.Struct)
		if !ok || index >= structure.NumFields() {
			return ""
		}
		field := structure.Field(index)
		if position == len(selection.Index())-1 {
			return receiverName(current) + "." + field.Name()
		}
		current = field.Type()
	}
	return ""
}
func directCallID(object types.Object) string {
	switch object := object.(type) {
	case *types.Builtin:
		return objectID(object)
	case *types.Func:
		if signature, ok := object.Type().(*types.Signature); ok && signature.Recv() != nil {
			if _, dynamic := signature.Recv().Type().Underlying().(*types.Interface); dynamic {
				return ""
			}
		}
		return objectID(object)
	}
	// A variable of function type binds a symbol, but the compiler does not
	// establish its runtime callable target. Conversions are not function calls.
	return ""
}
func objectID(object types.Object) string {
	if object == nil {
		return ""
	}
	if imported, ok := object.(*types.PkgName); ok {
		return "package:" + imported.Imported().Path()
	}
	if object.Pkg() == nil {
		return "builtin:" + object.Name()
	}
	if fn, ok := object.(*types.Func); ok {
		if signature, ok := fn.Type().(*types.Signature); ok && signature.Recv() != nil {
			return receiverName(signature.Recv().Type()) + "." + fn.Name()
		}
	}
	if object.Parent() == object.Pkg().Scope() {
		return object.Pkg().Path() + "." + object.Name()
	}
	return ""
}
func objectKind(object types.Object) string {
	switch object.(type) {
	case *types.Func:
		return "function"
	case *types.TypeName:
		return "type"
	case *types.Const:
		return "constant"
	case *types.Var:
		return "variable"
	}
	return "unknown"
}
func (c *projectChecker) source(node ast.Node) (string, string) {
	start, end := c.fset.Position(node.Pos()), c.fset.Position(node.End())
	source := c.sources[start.Filename]
	if start.Offset < 0 || end.Offset > len(source) {
		return start.Filename, ""
	}
	return start.Filename, source[start.Offset:end.Offset]
}
func (c *projectChecker) references(node ast.Node, info *types.Info) ([]string, []string, []string) {
	refs, calls, dispatch := []string{}, []string{}, []string{}
	ast.Inspect(node, func(current ast.Node) bool {
		switch current := current.(type) {
		case *ast.Ident:
			refs = append(refs, objectID(info.Uses[current]))
		case *ast.SelectorExpr:
			if selection := info.Selections[current]; selection != nil {
				if variable, ok := selection.Obj().(*types.Var); ok && variable.IsField() {
					refs = append(refs, fieldID(selection))
				}
				if _, ok := selection.Recv().Underlying().(*types.Interface); ok {
					dispatch = append(dispatch, types.TypeString(selection.Recv(), qualifier)+"."+selection.Obj().Name())
				}
			}
		case *ast.CallExpr:
			fun := current.Fun
			if indexed, ok := fun.(*ast.IndexExpr); ok {
				fun = indexed.X
			}
			if indexed, ok := fun.(*ast.IndexListExpr); ok {
				fun = indexed.X
			}
			switch fun := fun.(type) {
			case *ast.Ident:
				calls = append(calls, directCallID(info.Uses[fun]))
			case *ast.SelectorExpr:
				calls = append(calls, directCallID(info.Uses[fun.Sel]))
			}
		}
		return true
	})
	return sortedSet(refs), sortedSet(calls), sortedSet(dispatch)
}
func (c *projectChecker) declaration(node ast.Node, name *ast.Ident, group *packageSource, override string) {
	object := group.info.Defs[name]
	if object == nil {
		c.incomplete()
		return
	}
	target := objectID(object)
	if override != "" {
		target = override
	}
	if target == "" {
		c.incomplete()
		return
	}
	file, source := c.source(node)
	refs, calls, dispatch := c.references(node, group.info)
	attributes := map[string]any{"file": file, "name": object.Name(), "object_kind": objectKind(object), "type": types.TypeString(object.Type(), qualifier), "exported": object.Exported(), "source_digest": fingerprint(source), "static_calls": calls, "interface_dispatch": dispatch}
	if constant, ok := object.(*types.Const); ok {
		attributes["constant_value"] = constant.Val().ExactString()
	}
	instances := []string{}
	ast.Inspect(node, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok {
			if instance, ok := group.info.Instances[id]; ok {
				instances = append(instances, types.TypeString(instance.Type, qualifier))
			}
		}
		return true
	})
	attributes["generic_instances"] = sortedSet(instances)
	c.add(observation{Kind: "symbol", Target: target, Attributes: attributes, References: refs})
}
func (c *projectChecker) collect(packagePath string, group *packageSource) {
	if group.info == nil {
		c.incomplete()
		return
	}
	for _, file := range group.files {
		filename := c.fset.Position(file.Pos()).Filename
		c.add(observation{Kind: "package", Target: filename, Attributes: map[string]any{"package_path": packagePath, "package_name": file.Name.Name}, References: []string{}})
		directives := []string{}
		for _, comments := range file.Comments {
			for _, comment := range comments.List {
				if strings.HasPrefix(comment.Text, "//go:") {
					directives = append(directives, comment.Text)
					if !strings.HasPrefix(comment.Text, "//go:generate") {
						c.incomplete()
					}
				}
			}
		}
		if len(directives) > 0 {
			c.add(observation{Kind: "build", Target: filename + ":compiler-directives", Attributes: map[string]any{"directives": directives, "scope": "declared-build-directives", "execution": "not-evaluated"}, References: []string{}})
		}
		for _, imported := range file.Imports {
			importPath, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				c.status = "FAILED"
				continue
			}
			alias := ""
			if imported.Name != nil {
				alias = imported.Name.Name
			}
			c.add(observation{Kind: "import", Target: filename + ":" + importPath, Attributes: map[string]any{"import_path": importPath, "alias": alias, "initialization_effects": "not-evaluated"}, References: []string{"package:" + importPath}})
		}
		initIndex := 0
		blankIndex := 0
		for _, declaration := range file.Decls {
			switch declaration := declaration.(type) {
			case *ast.FuncDecl:
				override := ""
				if declaration.Name.Name == "init" {
					initIndex++
					override = packagePath + ".init@" + filename + ":" + strconv.Itoa(initIndex)
				}
				if declaration.Name.Name == "_" {
					blankIndex++
					override = packagePath + "._@" + filename + ":" + strconv.Itoa(blankIndex)
				}
				c.declaration(declaration, declaration.Name, group, override)
			case *ast.GenDecl:
				for _, spec := range declaration.Specs {
					switch spec := spec.(type) {
					case *ast.TypeSpec:
						c.declaration(spec, spec.Name, group, "")
					case *ast.ValueSpec:
						for _, name := range spec.Names {
							override := ""
							if name.Name == "_" {
								blankIndex++
								override = packagePath + "._@" + filename + ":" + strconv.Itoa(blankIndex)
							}
							c.declaration(spec, name, group, override)
						}
					}
				}
			}
		}
	}
}

func severity(status string) int {
	switch status {
	case "COMPLETE":
		return 0
	case "PARTIAL":
		return 1
	case "UNSUPPORTED":
		return 2
	default:
		return 3
	}
}
func categories(o observation) []string {
	result := []string{}
	if o.Kind == "dependency" {
		result = append(result, "dependency")
	}
	if o.Kind == "build" {
		result = append(result, "build")
	}
	for _, ref := range o.References {
		ref = strings.TrimPrefix(ref, "package:")
		switch {
		case ref == "unsafe" || strings.HasPrefix(ref, "unsafe."):
			result = append(result, "unsafe")
		case ref == "os/exec" || strings.HasPrefix(ref, "os/exec."):
			result = append(result, "process")
		case ref == "net" || strings.HasPrefix(ref, "net.") || strings.HasPrefix(ref, "net/"):
			result = append(result, "network")
		case ref == "os" || strings.HasPrefix(ref, "os.") || ref == "io/fs" || strings.HasPrefix(ref, "io/fs."):
			result = append(result, "filesystem")
		case strings.HasPrefix(ref, "crypto/"):
			result = append(result, "cryptography")
		case ref == "database/sql" || strings.HasPrefix(ref, "database/sql."):
			result = append(result, "database")
		}
	}
	return sortedSet(result)
}
func analyze(request Request) Response {
	response := Response{SchemaVersion: 1, ToolchainVersion: request.ToolchainVersion, Capability: "SEMANTIC", Status: "COMPLETE", Effects: []Effect{}, SecurityEffects: []Effect{}}
	if !supported(request.ToolchainVersion) {
		response.Status = "UNSUPPORTED"
		return response
	}
	if strings.TrimPrefix(runtime.Version(), "go") != request.ToolchainVersion {
		response.Status = "FAILED"
		return response
	}
	if request.SchemaVersion != 1 || request.Base.SchemaVersion != 1 || request.Revision.SchemaVersion != 1 || request.Base.RepoID != request.Revision.RepoID {
		response.Status = "FAILED"
		return response
	}
	before, after := inspectProject(request.Base, request.ToolchainVersion), inspectProject(request.Revision, request.ToolchainVersion)
	response.Status = before.status
	if severity(after.status) > severity(response.Status) {
		response.Status = after.status
	}
	if response.Status == "FAILED" || response.Status == "UNSUPPORTED" {
		return response
	}
	keys := []string{}
	for key := range before.observations {
		keys = append(keys, key)
	}
	for key := range after.observations {
		keys = append(keys, key)
	}
	for _, key := range sortedSet(keys) {
		old, hasOld := before.observations[key]
		next, hasNext := after.observations[key]
		oldJSON, _ := json.Marshal(old)
		nextJSON, _ := json.Marshal(next)
		if hasOld && hasNext && string(oldJSON) == string(nextJSON) {
			continue
		}
		operation := "modified"
		observed := next
		if !hasOld {
			operation = "added"
		}
		if !hasNext {
			operation = "removed"
			observed = old
		}
		var oldAttrs, nextAttrs any
		if hasOld {
			oldAttrs = old.Attributes
		}
		if hasNext {
			nextAttrs = next.Attributes
		}
		attributes := map[string]any{"before": oldAttrs, "after": nextAttrs, "static_bounds": map[string]any{"analysis": "go-types-static-bindings", "build_target": "linux-amd64", "cgo": false, "runtime_behavior": "not-evaluated", "reflection_and_dynamic_targets": "not-resolved"}}
		refs := sortedSet(append(append([]string{}, old.References...), next.References...))
		effect := Effect{SchemaVersion: 1, Kind: observed.Kind, Target: observed.Target, Operation: operation, Attributes: attributes, References: refs}
		response.Effects = append(response.Effects, effect)
		securityCategories := sortedSet(append(categories(old), categories(next)...))
		if len(securityCategories) > 0 {
			securityAttributes := map[string]any{"categories": securityCategories, "basis": "compiler-observed-static-reference-or-manifest", "effect_kind": effect.Kind, "before": oldAttrs, "after": nextAttrs, "static_bounds": attributes["static_bounds"]}
			response.SecurityEffects = append(response.SecurityEffects, Effect{SchemaVersion: 1, Kind: "security", Target: effect.Target, Operation: operation, Attributes: securityAttributes, References: refs})
		}
	}
	return response
}

func main() {
	var request Request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 16<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		_ = json.NewEncoder(os.Stdout).Encode(Response{SchemaVersion: 1, Capability: "SEMANTIC", Status: "FAILED", Effects: []Effect{}, SecurityEffects: []Effect{}})
		return
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		_ = json.NewEncoder(os.Stdout).Encode(Response{SchemaVersion: 1, ToolchainVersion: request.ToolchainVersion, Capability: "SEMANTIC", Status: "FAILED", Effects: []Effect{}, SecurityEffects: []Effect{}})
		return
	}
	_ = json.NewEncoder(os.Stdout).Encode(analyze(request))
}
