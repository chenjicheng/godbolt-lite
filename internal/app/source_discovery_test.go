package app

import (
	"path/filepath"
	"testing"
)

func TestParseMakefileDependenciesHandlesContinuationsAndEscapes(t *testing.T) {
	output := "deps: C:/project/main.c C:/project/include/my\\ header.h \\\r\n C:/project/util.h\n"
	deps, err := parseMakefileDependencies(output)
	if err != nil {
		t.Fatalf("parseMakefileDependencies failed: %v", err)
	}
	want := []string{
		filepath.FromSlash("C:/project/main.c"),
		filepath.FromSlash("C:/project/include/my header.h"),
		filepath.FromSlash("C:/project/util.h"),
	}
	if len(deps) != len(want) {
		t.Fatalf("deps = %#v, want %#v", deps, want)
	}
	for i := range want {
		if deps[i] != want[i] {
			t.Fatalf("deps[%d] = %q, want %q", i, deps[i], want[i])
		}
	}
}

func TestParseMakefileDependenciesRejectsMissingTarget(t *testing.T) {
	if _, err := parseMakefileDependencies("main.c util.h"); err == nil {
		t.Fatal("parseMakefileDependencies accepted output without target")
	}
}
