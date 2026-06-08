package app

import (
	"os"
	"path/filepath"
	"runtime"
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
