package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCompileWithoutClangReturnsStructuredError(t *testing.T) {
	compiler := NewCompiler("", t.TempDir(), t.TempDir(), t.TempDir())
	resp := compiler.Compile(context.Background(), CompileRequest{
		ActiveFile: "main.c",
		RequestID:  "req-1",
	})
	if resp.OK {
		t.Fatal("Compile succeeded without clang")
	}
	if resp.RequestID != "req-1" {
		t.Fatalf("RequestID = %q, want req-1", resp.RequestID)
	}
	if resp.Error == "" {
		t.Fatal("expected error")
	}
}

func TestPrepareRunCompilerArgsOmitsLinuxTargetWithNote(t *testing.T) {
	args, note, err := prepareRunCompilerArgs([]string{
		"-target", "x86_64-pc-linux-gnu",
		"-Og",
		"-fno-stack-protector",
	})
	if err != nil {
		t.Fatalf("prepareRunCompilerArgs failed: %v", err)
	}
	if note == "" {
		t.Fatal("expected Linux target note")
	}
	if got := len(args); got != 2 {
		t.Fatalf("args len = %d, want 2: %#v", got, args)
	}
	if args[0] != "-Og" || args[1] != "-fno-stack-protector" {
		t.Fatalf("args = %#v", args)
	}
}

func TestPrepareRunCompilerArgsOmitsDoubleDashLinuxTargetWithNote(t *testing.T) {
	args, note, err := prepareRunCompilerArgs([]string{
		"--target", "x86_64-pc-linux-gnu",
		"-Og",
	})
	if err != nil {
		t.Fatalf("prepareRunCompilerArgs failed: %v", err)
	}
	if note == "" {
		t.Fatal("expected Linux target note")
	}
	if len(args) != 1 || args[0] != "-Og" {
		t.Fatalf("args = %#v, want only -Og", args)
	}
}

func TestPrepareRunCompilerArgsRejectsAssemblyOnlyMode(t *testing.T) {
	if _, _, err := prepareRunCompilerArgs([]string{"-Og", "-S"}); err == nil {
		t.Fatal("prepareRunCompilerArgs accepted -S")
	}
}

func TestValidateCompilerArgsRejectsUnsafeInputs(t *testing.T) {
	projectDir := t.TempDir()
	includeDir := t.TempDir()
	systemIncludeDir := t.TempDir()
	outsideDir := t.TempDir()
	compiler := NewCompiler("clang", projectDir, includeDir, systemIncludeDir)

	cases := [][]string{
		{"scratch.c"},
		{"@args.rsp"},
		{"--", "scratch.c"},
		{"-o", "out.exe"},
		{"-Xclang", "-load"},
		{"-fpass-plugin=evil.dll"},
		{"-load-pass-plugin=evil.dll"},
		{"-mllvm=-load"},
		{"-I", filepath.Join(outsideDir, "include")},
		{"-fuse-ld", filepath.Join(outsideDir, "lld-link.exe")},
		{"-fuse-ld=evil"},
	}
	for _, args := range cases {
		if err := compiler.validateCompilerArgs(args); err == nil {
			t.Fatalf("validateCompilerArgs(%#v) succeeded, want error", args)
		}
	}
}

func TestValidateCompilerArgsAllowsCommonSafeArgs(t *testing.T) {
	projectDir := t.TempDir()
	includeDir := t.TempDir()
	systemIncludeDir := t.TempDir()
	compiler := NewCompiler("clang", projectDir, includeDir, systemIncludeDir)

	args := []string{
		"-Og",
		"-g0",
		"-std=c17",
		"-D", "NAME=1",
		"-masm=intel",
		"-I", filepath.Join(projectDir, "headers"),
		"-include", "config.h",
		"-fuse-ld=lld",
	}
	if err := compiler.validateCompilerArgs(args); err != nil {
		t.Fatalf("validateCompilerArgs failed: %v", err)
	}
}

func TestRunSourcePathsFollowsLocalHeaderImplementations(t *testing.T) {
	projectDir := t.TempDir()
	includeDir := t.TempDir()
	systemIncludeDir := t.TempDir()
	writeTestFile(t, projectDir, "main.c", "#include \"util.h\"\n#include <stdio.h>\nint main(void){return add(1, 2);}\n")
	writeTestFile(t, projectDir, "util.h", "int add(int, int);\n")
	writeTestFile(t, projectDir, "util.c", "#include \"util.h\"\nint add(int a, int b){return a + b;}\n")
	writeTestFile(t, projectDir, "scratch.c", "int main(void){return 99;}\n")

	compiler := NewCompiler("clang", projectDir, includeDir, systemIncludeDir)
	mainPath := filepath.Join(projectDir, "main.c")
	utilPath := filepath.Join(projectDir, "util.c")
	utilHeader := filepath.Join(projectDir, "util.h")
	paths, err := compiler.discoverRunSourcePaths(context.Background(), mainPath, fakeDependencyReader(map[string][]string{
		mainPath: {mainPath, utilHeader},
		utilPath: {utilPath, utilHeader},
	}))
	if err != nil {
		t.Fatalf("runSourcePaths failed: %v", err)
	}
	assertRunSources(t, paths, projectDir, "main.c", "util.c")
	assertNotRunSource(t, paths, projectDir, "scratch.c")
}

func TestRunSourcePathsFollowsIncludeFolderHeaderImplementations(t *testing.T) {
	projectDir := t.TempDir()
	includeDir := t.TempDir()
	systemIncludeDir := t.TempDir()
	writeTestFile(t, projectDir, "main.c", "#include \"vendor/foo.h\"\nint main(void){return foo();}\n")
	writeTestFile(t, includeDir, "vendor/foo.h", "int foo(void);\n")
	writeTestFile(t, includeDir, "vendor/foo.c", "#include \"foo.h\"\nint foo(void){return 7;}\n")
	writeTestFile(t, includeDir, "vendor/unused.c", "int unused(void){return 1;}\n")

	compiler := NewCompiler("clang", projectDir, includeDir, systemIncludeDir)
	mainPath := filepath.Join(projectDir, "main.c")
	fooHeader := filepath.Join(includeDir, "vendor", "foo.h")
	fooSource := filepath.Join(includeDir, "vendor", "foo.c")
	paths, err := compiler.discoverRunSourcePaths(context.Background(), mainPath, fakeDependencyReader(map[string][]string{
		mainPath:  {mainPath, fooHeader},
		fooSource: {fooSource, fooHeader},
	}))
	if err != nil {
		t.Fatalf("runSourcePaths failed: %v", err)
	}
	assertRunSources(t, paths, projectDir, "main.c")
	assertRunSources(t, paths, includeDir, "vendor/foo.c")
	assertNotRunSource(t, paths, includeDir, "vendor/unused.c")
}

func TestRunArtifactNameSanitizesRequestID(t *testing.T) {
	name := runArtifactName(`../bad path?$`, time.Unix(1, 2))
	if strings.ContainsAny(name, `\/:?* "`) {
		t.Fatalf("runArtifactName produced unsafe name %q", name)
	}
	if !strings.HasPrefix(name, "program-") {
		t.Fatalf("runArtifactName = %q, want program-*", name)
	}
}

func writeTestFile(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
}

func assertRunSources(t *testing.T, paths []string, root string, rels ...string) {
	t.Helper()
	for _, rel := range rels {
		want := filepath.Join(root, filepath.FromSlash(rel))
		if !containsPath(paths, want) {
			t.Fatalf("run sources missing %s from %#v", want, paths)
		}
	}
}

func assertNotRunSource(t *testing.T, paths []string, root, rel string) {
	t.Helper()
	unwanted := filepath.Join(root, filepath.FromSlash(rel))
	if containsPath(paths, unwanted) {
		t.Fatalf("run sources unexpectedly included %s in %#v", unwanted, paths)
	}
}

func containsPath(paths []string, want string) bool {
	wantAbs, err := filepath.Abs(want)
	if err != nil {
		wantAbs = want
	}
	for _, path := range paths {
		if strings.EqualFold(path, wantAbs) {
			return true
		}
	}
	return false
}

func fakeDependencyReader(deps map[string][]string) dependencyReader {
	return func(_ context.Context, sourcePath string) ([]string, error) {
		for path, values := range deps {
			if strings.EqualFold(path, sourcePath) {
				return values, nil
			}
		}
		return nil, nil
	}
}
