package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureSystemIncludeWritesCommonHeaders(t *testing.T) {
	dir, err := EnsureSystemInclude(t.TempDir())
	if err != nil {
		t.Fatalf("EnsureSystemInclude failed: %v", err)
	}
	for _, name := range []string{"stdio.h", "stdint.h", "string.h", "stdlib.h"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s was not written: %v", name, err)
		}
	}
}
