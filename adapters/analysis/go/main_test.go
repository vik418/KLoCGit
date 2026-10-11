package main

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func project(contents string, extra ...File) Project {
	files := []File{{Path: "go.mod", Contents: "module example.test/project\n\ngo 1.26\n"}}
	if contents != "" {
		files = append(files, File{Path: "main.go", Contents: contents})
	}
	files = append(files, extra...)
	return Project{SchemaVersion: 1, RepoID: "repo", CommitOID: strings.Repeat("a", 40), TreeOID: strings.Repeat("b", 40), Complete: true, Files: files}
}
func check(base, next Project) Response {
	return analyze(Request{SchemaVersion: 1, ToolchainVersion: strings.TrimPrefix(runtime.Version(), "go"), Base: base, Revision: next})
}
func find(t *testing.T, result Response, target string) Effect {
	t.Helper()
	for _, effect := range result.Effects {
		if effect.Target == target {
			return effect
		}
	}
	t.Fatalf("missing %s in %+v", target, result)
	return Effect{}
}
func after(t *testing.T, result Response, target string) map[string]any {
	t.Helper()
	return find(t, result, target).Attributes["after"].(map[string]any)
}
func TestResolvedLocalSymbolsAndInferredTypes(t *testing.T) {
	base := project("")
	main := `package main
import renamed "example.test/project/model"
var Value = renamed.Make()
func Result() int { return Value.Count }
`
	model := `package model
type Counter struct { Count int }
func Make() Counter { return Counter{Count: 2} }
`
	result := check(base, project(main, File{Path: "model/model.go", Contents: model}))
	if result.Status != "COMPLETE" {
		t.Fatalf("%+v", result)
	}
	attrs := after(t, result, "example.test/project.Value")
	if attrs["type"] != "example.test/project/model.Counter" {
		t.Fatalf("inferred type: %v", attrs)
	}
	fn := find(t, result, "example.test/project.Result")
	if !contains(fn.References, "example.test/project/model.Counter.Count") {
		t.Fatalf("resolved field reference: %v", fn.References)
	}
	value := find(t, result, "example.test/project.Value")
	if !contains(value.References, "example.test/project/model.Make") {
		t.Fatal(value.References)
	}
}
func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
func TestGenericsAndShadowingUseCompilerBindings(t *testing.T) {
	source := `package main
func Identity[T any](value T) T { return value }
var Result = Identity(41)
func Shadow() int { Identity := func(value string) int { return len(value) }; return Identity("x") }
`
	result := check(project(""), project(source))
	if result.Status != "COMPLETE" {
		t.Fatalf("%+v", result)
	}
	attrs := after(t, result, "example.test/project.Result")
	if attrs["type"] != "int" || !contains(attrs["generic_instances"].([]string), "func(value int) int") {
		t.Fatal(attrs)
	}
	shadow := find(t, result, "example.test/project.Shadow")
	if contains(shadow.References, "example.test/project.Identity") {
		t.Fatal("shadowed local must not bind to package function", shadow)
	}
}
func TestReceiverAndInterfaceDispatchBounds(t *testing.T) {
	source := `package main
type Reader interface { Read() int }
type Counter struct { N int }
func (c *Counter) Read() int { return c.N }
func Direct(c *Counter) int { return c.Read() }
func Dynamic(r Reader) int { return r.Read() }
`
	result := check(project(""), project(source))
	if result.Status != "COMPLETE" {
		t.Fatalf("%+v", result)
	}
	direct := after(t, result, "example.test/project.Direct")
	if !contains(direct["static_calls"].([]string), "example.test/project.Counter.Read") {
		t.Fatal(direct)
	}
	dynamic := after(t, result, "example.test/project.Dynamic")
	if len(dynamic["interface_dispatch"].([]string)) != 1 {
		t.Fatal(dynamic)
	}
}
func TestStdlibAliasAndSecurityReferences(t *testing.T) {
	source := `package main
import command "os/exec"
func Process() *command.Cmd { return command.Command("echo", "safe") }
`
	result := check(project(""), project(source))
	if result.Status != "COMPLETE" {
		t.Fatalf("%+v", result)
	}
	fn := find(t, result, "example.test/project.Process")
	if !contains(fn.References, "os/exec.Command") {
		t.Fatal(fn)
	}
	if after(t, result, fn.Target)["type"] != "func() *os/exec.Cmd" {
		t.Fatal(fn)
	}
	if len(result.SecurityEffects) < 2 {
		t.Fatalf("missing static security effects: %+v", result)
	}
}
func TestBlankInitializerAndPromotedFieldBindings(t *testing.T) {
	source := `package main
type Inner struct { Field int }
type Outer struct { *Inner }
func Read(value Outer) int { return value.Field }
func SideEffect() int { return 1 }
var _ = SideEffect()
var Indirect = SideEffect
func CallIndirect() int { return Indirect() }
`
	result := check(project(""), project(source))
	if result.Status != "COMPLETE" {
		t.Fatalf("%+v", result)
	}
	if !contains(find(t, result, "example.test/project.Read").References, "example.test/project.Inner.Field") {
		t.Fatal(result)
	}
	blank := find(t, result, "example.test/project._@main.go:1")
	if !contains(blank.References, "example.test/project.SideEffect") {
		t.Fatal(blank)
	}
	indirect := after(t, result, "example.test/project.CallIndirect")
	if len(indirect["static_calls"].([]string)) != 0 {
		t.Fatal("indirect function variable is not a resolved static call target", indirect)
	}
}
func TestCorpusFailuresAndLimitations(t *testing.T) {
	tests := []struct {
		name, source, status string
		extra                []File
	}{
		{"syntax", "package main\nfunc Broken( {", "FAILED", nil},
		{"type-mismatch", "package main\nvar Value int = \"wrong\"", "FAILED", nil},
		{"undefined", "package main\nvar Value = Missing", "FAILED", nil},
		{"missing-external", "package main\nimport external \"example.invalid/dependency\"\nvar Value = external.Value", "PARTIAL", nil},
		{"cgo", "package main\nimport \"C\"\nvar Value = C.int(0)", "PARTIAL", nil},
		{"build-tag", "//go:build optional\npackage main\nvar Value = 1", "PARTIAL", nil},
		{"test-scope", "package main\nvar Value = 1", "PARTIAL", []File{{Path: "main_test.go", Contents: "package main"}}},
		{"embedding", "package main\nimport _ \"embed\"\n//go:embed asset.txt\nvar Asset string", "PARTIAL", []File{{Path: "asset.txt", Contents: "x"}}},
		{"assembly", "package main\nfunc Assembly()", "PARTIAL", []File{{Path: "asm.s", Contents: "unparsed assembly"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := check(project(""), project(tt.source, tt.extra...))
			if result.Status != tt.status {
				t.Fatalf("want %s got %+v", tt.status, result)
			}
		})
	}
	incomplete := project("package main\nvar Value = 1")
	incomplete.Complete = false
	if result := check(project(""), incomplete); result.Status != "PARTIAL" {
		t.Fatal(result)
	}
	dependency := project("package main\nvar Value = 1")
	dependency.Files[0].Contents += "require example.invalid/dependency v1.0.0\n"
	if result := check(project(""), dependency); result.Status != "PARTIAL" {
		t.Fatal(result)
	}
}
func TestVersionMatrix(t *testing.T) {
	for _, requested := range []string{"1.25.0", "1.28.0", "go1.27.2", "devel"} {
		result := analyze(Request{SchemaVersion: 1, ToolchainVersion: requested, Base: project(""), Revision: project("package main")})
		if result.Status != "UNSUPPORTED" {
			t.Fatal(result)
		}
	}
	newer := project("package main")
	newer.Files[0].Contents = "module example.test/project\ngo 1.28\n"
	if result := check(project(""), newer); result.Status != "UNSUPPORTED" {
		t.Fatal(result)
	}
	other := "1.26.9"
	if strings.TrimPrefix(runtime.Version(), "go") == other {
		other = "1.27.2"
	}
	if result := analyze(Request{SchemaVersion: 1, ToolchainVersion: other, Base: project(""), Revision: project("package main")}); result.Status != "FAILED" {
		t.Fatal(result)
	}
}
func TestDeterministicDeltaAndRemoval(t *testing.T) {
	base := project("package main\nvar Removed = 1\nfunc Value() int { return 1 }")
	next := project("package main\nfunc Value() int { return 2 }")
	first := check(base, next)
	if first.Status != "COMPLETE" {
		t.Fatal(first)
	}
	if find(t, first, "example.test/project.Removed").Operation != "removed" {
		t.Fatal(first)
	}
	if find(t, first, "example.test/project.Value").Operation != "modified" {
		t.Fatal(first)
	}
	left, _ := json.Marshal(first)
	right, _ := json.Marshal(check(base, next))
	if string(left) != string(right) {
		t.Fatal("nondeterministic output")
	}
	if result := check(next, next); len(result.Effects) != 0 {
		t.Fatal(result)
	}
}
