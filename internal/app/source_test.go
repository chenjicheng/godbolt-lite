package app

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFileURIToPathWindowsDrive(t *testing.T) {
	path, err := fileURIToPath("file:///C:/Users/test/My%20Project/main.c")
	if err != nil {
		t.Fatalf("fileURIToPath failed: %v", err)
	}
	if path == "" {
		t.Fatal("empty path")
	}
}

func TestReadAllowedSourceAllowsSystemIncludes(t *testing.T) {
	projectDir := t.TempDir()
	includeDir := t.TempDir()
	systemIncludeDir := t.TempDir()
	writeTestFile(t, systemIncludeDir, "stdio.h", "int printf(const char *, ...);\n")

	server := &Server{cfg: Config{
		ProjectDir:       projectDir,
		IncludeDir:       includeDir,
		SystemIncludeDir: systemIncludeDir,
	}}
	path := filepath.Join(systemIncludeDir, "stdio.h")
	resp, err := server.readAllowedSource(pathToTestFileURI(path), path)
	if err != nil {
		t.Fatalf("readAllowedSource failed: %v", err)
	}
	if !resp.ReadOnly {
		t.Fatal("system include should be read-only")
	}
	if resp.Path != "external/system/stdio.h" {
		t.Fatalf("Path = %q, want external/system/stdio.h", resp.Path)
	}
}

func TestReadAllowedSourceAllowsIncFiles(t *testing.T) {
	projectDir := t.TempDir()
	includeDir := t.TempDir()
	systemIncludeDir := t.TempDir()
	writeTestFile(t, projectDir, "macros.inc", "#define VALUE 1\n")

	server := &Server{cfg: Config{
		ProjectDir:       projectDir,
		IncludeDir:       includeDir,
		SystemIncludeDir: systemIncludeDir,
	}}
	path := filepath.Join(projectDir, "macros.inc")
	resp, err := server.readAllowedSource(pathToTestFileURI(path), path)
	if err != nil {
		t.Fatalf("readAllowedSource failed: %v", err)
	}
	if resp.Path != "macros.inc" || resp.Content == "" {
		t.Fatalf("unexpected source response: %#v", resp)
	}
}

func TestReadAllowedSourceRejectsMetadataNonSourceBinaryAndOversized(t *testing.T) {
	projectDir := t.TempDir()
	includeDir := t.TempDir()
	systemIncludeDir := t.TempDir()
	server := &Server{cfg: Config{
		ProjectDir:       projectDir,
		IncludeDir:       includeDir,
		SystemIncludeDir: systemIncludeDir,
	}}
	cases := []struct {
		name    string
		rel     string
		content string
	}{
		{name: "project metadata", rel: "project.json", content: "{}"},
		{name: "compile commands", rel: "compile_commands.json", content: "[]"},
		{name: "run metadata", rel: ".mini-godbolt-run/output.c", content: "int x;\n"},
		{name: "non source", rel: "notes.txt", content: "notes\n"},
		{name: "binary", rel: "binary.c", content: "int x;\x00\n"},
		{name: "oversized", rel: "huge.c", content: strings.Repeat("x", maxSourceReadBytes+1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			writeTestFile(t, projectDir, tc.rel, tc.content)
			path := filepath.Join(projectDir, filepath.FromSlash(tc.rel))
			if _, err := server.readAllowedSource(pathToTestFileURI(path), path); err == nil {
				t.Fatalf("readAllowedSource accepted %s", tc.rel)
			}
		})
	}
}

func TestReadAllowedSourceRejectsSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlink creation often needs developer mode or administrator rights")
	}
	projectDir := t.TempDir()
	includeDir := t.TempDir()
	systemIncludeDir := t.TempDir()
	outsideDir := t.TempDir()
	writeTestFile(t, outsideDir, "secret.h", "int secret(void);\n")
	linkPath := filepath.Join(projectDir, "linked.h")
	if err := os.Symlink(filepath.Join(outsideDir, "secret.h"), linkPath); err != nil {
		t.Skipf("Symlink not available: %v", err)
	}

	server := &Server{cfg: Config{
		ProjectDir:       projectDir,
		IncludeDir:       includeDir,
		SystemIncludeDir: systemIncludeDir,
	}}
	if _, err := server.readAllowedSource(pathToTestFileURI(linkPath), linkPath); err == nil {
		t.Fatal("readAllowedSource accepted symlink escape")
	}
}

func pathToTestFileURI(path string) string {
	return "file:///" + filepath.ToSlash(path)
}
