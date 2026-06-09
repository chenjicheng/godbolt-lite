package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanProjectPathRejectsTraversal(t *testing.T) {
	bad := []string{"../main.c", "..\\main.c", "/main.c", "C:/tmp/main.c", "bad:name.c", "CON.c", "folder/../main.c", "external/foo.h", ".mini-godbolt-run/main.c", ""}
	for _, path := range bad {
		if _, err := cleanProjectPath(path); err == nil {
			t.Fatalf("cleanProjectPath(%q) succeeded, want error", path)
		}
	}
}

func TestProjectStoreSyncWritesFilesAndCompileCommands(t *testing.T) {
	dir := t.TempDir()
	systemIncludeDir := filepath.Join(dir, "system-include")
	store := NewProjectStore(dir, systemIncludeDir, "clang")
	state := ProjectState{
		ActiveFile: "main.c",
		Files: []ProjectFile{
			{Path: "main.c", Content: "#include \"util.h\"\nint main(void){return add(1,2);}"},
			{Path: "util.h", Content: "int add(int,int);\n"},
			{Path: "nested/util.c", Content: "int add(int a,int b){return a+b;}\n"},
		},
	}

	if err := store.Sync(state); err != nil {
		t.Fatalf("Sync failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "main.c")); err != nil {
		t.Fatalf("main.c not written: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "compile_commands.json"))
	if err != nil {
		t.Fatalf("compile_commands.json not written: %v", err)
	}
	var commands []commandEntry
	if err := json.Unmarshal(data, &commands); err != nil {
		t.Fatalf("compile_commands.json invalid: %v", err)
	}
	var commandText strings.Builder
	for _, command := range commands {
		commandText.WriteString(command.Command)
		commandText.WriteByte('\n')
	}
	text := commandText.String()
	if !strings.Contains(text, "main.c") ||
		!strings.Contains(text, "nested") ||
		!strings.Contains(text, "-isystem") ||
		!strings.Contains(text, systemIncludeDir) {
		t.Fatalf("compile_commands.json missing expected entries: %s", text)
	}
	if strings.Contains(text, "vendor") {
		t.Fatalf("compile_commands.json included non-project vendor entries: %s", text)
	}
}

func TestProjectStoreRejectsUnsafeCompilerArgsForCompileCommands(t *testing.T) {
	dir := t.TempDir()
	store := NewProjectStore(dir, filepath.Join(dir, "system-include"), "clang")
	state := ProjectState{
		ActiveFile:   "main.c",
		CompilerArgs: "-Xclang -load",
		Files: []ProjectFile{
			{Path: "main.c", Content: "int main(void){return 0;}"},
		},
	}

	if err := store.Sync(state); err == nil {
		t.Fatal("Sync accepted unsafe compiler args")
	}
	if _, err := os.Stat(filepath.Join(dir, "compile_commands.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("compile_commands.json was written after rejected compiler args: %v", err)
	}
}

func TestProjectStoreSyncRejectsEmptyFiles(t *testing.T) {
	dir := t.TempDir()
	store := NewProjectStore(dir, filepath.Join(dir, "system-include"), "clang")
	if err := store.Sync(ProjectState{Files: []ProjectFile{{
		Path:    "main.c",
		Content: "int main(void){return 0;}\n",
	}}}); err != nil {
		t.Fatalf("initial Sync failed: %v", err)
	}

	if err := store.Sync(ProjectState{}); err == nil {
		t.Fatal("Sync accepted empty files")
	}
	if _, err := os.Stat(filepath.Join(dir, "main.c")); err != nil {
		t.Fatalf("existing file missing after rejected empty sync: %v", err)
	}
}

func TestProjectStoreSyncWritesBeforeDeletingOldFiles(t *testing.T) {
	dir := t.TempDir()
	store := NewProjectStore(dir, filepath.Join(dir, "system-include"), "clang")
	if err := store.Sync(ProjectState{Files: []ProjectFile{{
		Path:    "old.c",
		Content: "int old(void){return 1;}\n",
	}}}); err != nil {
		t.Fatalf("initial Sync failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "blocked"), []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := store.Sync(ProjectState{Files: []ProjectFile{{
		Path:    "blocked/new.c",
		Content: "int newer(void){return 2;}\n",
	}}})
	if err == nil {
		t.Fatal("Sync succeeded despite blocked parent path")
	}
	if _, statErr := os.Stat(filepath.Join(dir, "old.c")); statErr != nil {
		t.Fatalf("old file was deleted before failed write: %v", statErr)
	}
}

func TestProjectStoreSyncCaseOnlyRenameKeepsFile(t *testing.T) {
	dir := t.TempDir()
	store := NewProjectStore(dir, filepath.Join(dir, "system-include"), "clang")
	if err := store.Sync(ProjectState{Files: []ProjectFile{{
		Path:    "main.c",
		Content: "int old(void){return 1;}\n",
	}}}); err != nil {
		t.Fatalf("initial Sync failed: %v", err)
	}

	if err := store.Sync(ProjectState{
		ActiveFile: "MAIN.c",
		Files: []ProjectFile{{
			Path:    "MAIN.c",
			Content: "int newer(void){return 2;}\n",
		}},
	}); err != nil {
		t.Fatalf("case-only Sync failed: %v", err)
	}

	state, err := store.Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(state.Files) != 1 || state.Files[0].Path != "MAIN.c" || !strings.Contains(state.Files[0].Content, "newer") {
		t.Fatalf("state after case-only rename = %+v", state)
	}
	if _, err := os.Stat(filepath.Join(dir, "MAIN.c")); err != nil {
		t.Fatalf("renamed file missing after cleanup: %v", err)
	}
}

func TestNormalizeStateRejectsProjectLimits(t *testing.T) {
	t.Run("too many files", func(t *testing.T) {
		files := make([]ProjectFile, maxProjectFiles+1)
		for i := range files {
			files[i] = ProjectFile{
				Path:    fmt.Sprintf("file%03d.c", i),
				Content: "int x;\n",
			}
		}
		if _, err := normalizeState(ProjectState{Files: files}); err == nil {
			t.Fatal("normalizeState accepted too many files")
		}
	})

	t.Run("single file too large", func(t *testing.T) {
		if _, err := normalizeState(ProjectState{Files: []ProjectFile{{
			Path:    "main.c",
			Content: strings.Repeat("x", maxProjectFileBytes+1),
		}}}); err == nil {
			t.Fatal("normalizeState accepted oversized file")
		}
	})

	t.Run("total content too large", func(t *testing.T) {
		files := make([]ProjectFile, 5)
		for i := range files {
			files[i] = ProjectFile{
				Path:    fmt.Sprintf("file%03d.c", i),
				Content: strings.Repeat("x", maxProjectFileBytes),
			}
		}
		if _, err := normalizeState(ProjectState{Files: files}); err == nil {
			t.Fatal("normalizeState accepted oversized project content")
		}
	})

	t.Run("compiler args too long", func(t *testing.T) {
		if _, err := normalizeState(ProjectState{
			CompilerArgs: strings.Repeat("x", maxCompilerArgsBytes+1),
			Files: []ProjectFile{{
				Path:    "main.c",
				Content: "int main(void){return 0;}\n",
			}},
		}); err == nil {
			t.Fatal("normalizeState accepted oversized compiler args")
		}
	})
}

func TestProjectStoreCompileCommandsUseNormalizedCompilerArgPaths(t *testing.T) {
	dir := t.TempDir()
	vendorDir := filepath.Join(dir, "vendor")
	if err := os.MkdirAll(vendorDir, 0o755); err != nil {
		t.Fatal(err)
	}
	store := NewProjectStore(dir, filepath.Join(dir, "system-include"), "clang")
	state := ProjectState{
		ActiveFile:   "main.c",
		CompilerArgs: "-I vendor",
		Files: []ProjectFile{
			{Path: "main.c", Content: "int main(void){return 0;}"},
		},
	}

	if err := store.Sync(state); err != nil {
		t.Fatalf("Sync failed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "compile_commands.json"))
	if err != nil {
		t.Fatal(err)
	}
	var commands []commandEntry
	if err := json.Unmarshal(data, &commands); err != nil {
		t.Fatalf("compile_commands.json invalid: %v", err)
	}
	var text strings.Builder
	for _, command := range commands {
		text.WriteString(command.Command)
	}
	if !strings.Contains(text.String(), vendorDir) {
		t.Fatalf("compile_commands.json did not contain normalized vendor path %q: %s", vendorDir, text.String())
	}
}

func TestNormalizeStateRejectsCaseInsensitiveDuplicates(t *testing.T) {
	_, err := normalizeState(ProjectState{
		ActiveFile: "main.c",
		Files: []ProjectFile{
			{Path: "main.c", Content: "int main(void){return 0;}"},
			{Path: "MAIN.C", Content: "int other(void){return 1;}"},
		},
	})
	if err == nil {
		t.Fatal("normalizeState accepted case-insensitive duplicate paths")
	}
}

func TestNormalizeStateFallsBackWhenActiveFileIsMissing(t *testing.T) {
	state, err := normalizeState(ProjectState{
		ActiveFile: "missing.c",
		Files: []ProjectFile{
			{Path: "header.h", Content: "#pragma once\n"},
			{Path: "main.c", Content: "int main(void){return 0;}"},
		},
	})
	if err != nil {
		t.Fatalf("normalizeState failed: %v", err)
	}
	if state.ActiveFile != "main.c" {
		t.Fatalf("ActiveFile = %q, want main.c", state.ActiveFile)
	}
}

func TestNormalizeStateMigratesDefaultCompilerArgs(t *testing.T) {
	for _, args := range []string{legacyDefaultCompilerArgs, linuxDefaultCompilerArgs, malformedLinuxDefaultCompilerArgs} {
		state, err := normalizeState(ProjectState{
			ActiveFile:   "main.c",
			CompilerArgs: args,
			Files: []ProjectFile{
				{Path: "main.c", Content: "int main(void){return 0;}"},
			},
		})
		if err != nil {
			t.Fatalf("normalizeState failed: %v", err)
		}
		if state.CompilerArgs != defaultCompilerArgs {
			t.Fatalf("CompilerArgs = %q, want %q", state.CompilerArgs, defaultCompilerArgs)
		}
	}
}

func TestProjectStoreSyncRemovesDeletedFiles(t *testing.T) {
	dir := t.TempDir()
	store := NewProjectStore(dir, filepath.Join(dir, "system-include"), "clang")

	first := ProjectState{
		ActiveFile: "main.c",
		Files: []ProjectFile{
			{Path: "main.c", Content: "int main(void){return old_name();}\n"},
			{Path: "old_name.c", Content: "int old_name(void){return 1;}\n"},
		},
	}
	if err := store.Sync(first); err != nil {
		t.Fatalf("initial Sync failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "old_name.c")); err != nil {
		t.Fatalf("old_name.c not written: %v", err)
	}

	second := ProjectState{
		ActiveFile: "main.c",
		Files: []ProjectFile{
			{Path: "main.c", Content: "int main(void){return new_name();}\n"},
			{Path: "new_name.c", Content: "int new_name(void){return 2;}\n"},
		},
	}
	if err := store.Sync(second); err != nil {
		t.Fatalf("second Sync failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "old_name.c")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old_name.c still exists after rename-like sync: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "new_name.c")); err != nil {
		t.Fatalf("new_name.c not written: %v", err)
	}
}

func TestProjectStoreLoadRefreshesCompileCommands(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"files":[{"path":"main.c","content":"int main(void){return 0;}"}],"activeFile":"main.c"}`
	if err := os.WriteFile(filepath.Join(dir, "project.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "compile_commands.json"), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}

	store := NewProjectStore(dir, filepath.Join(dir, "system-include"), "new-clang")
	if _, err := store.Load(); err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "compile_commands.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "new-clang") || strings.Contains(string(data), "stale") {
		t.Fatalf("compile_commands.json was not refreshed: %s", string(data))
	}
}
