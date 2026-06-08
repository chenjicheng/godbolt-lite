package app

import (
	"archive/zip"
	"bytes"
	"path/filepath"
	"testing"
)

func TestExtractZipBytesRejectsUnsafePath(t *testing.T) {
	data := toolchainZipBytes(t, map[string]string{
		`..\evil.txt`: "nope",
	})
	if _, err := extractZipBytes(t.TempDir(), data); err == nil {
		t.Fatal("extractZipBytes accepted unsafe path")
	}
}

func TestExtractZipBytesRequiresCompleteToolchain(t *testing.T) {
	data := toolchainZipBytes(t, map[string]string{
		filepath.ToSlash(exeName("bin/clang")): "clang",
	})
	if _, err := extractZipBytes(t.TempDir(), data); err == nil {
		t.Fatal("extractZipBytes accepted incomplete toolchain")
	}
}

func TestExtractZipBytesWritesReadyToolchain(t *testing.T) {
	data := toolchainZipBytes(t, map[string]string{
		filepath.ToSlash(exeName("bin/clang")):    "clang",
		filepath.ToSlash(exeName("bin/clangd")):   "clangd",
		filepath.ToSlash(exeName("bin/lld-link")): "lld-link",
		"lib/clang/22/include/stddef.h":           "typedef unsigned long size_t;\n",
	})
	tc, err := extractZipBytes(t.TempDir(), data)
	if err != nil {
		t.Fatalf("extractZipBytes failed: %v", err)
	}
	for _, path := range []string{tc.Clang, tc.Clangd, tc.LLDLink, filepath.Join(tc.Root, toolchainReadyMarker)} {
		if !fileExists(path) {
			t.Fatalf("expected extracted file %s", path)
		}
	}
}

func toolchainZipBytes(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("Create(%q) failed: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("Write(%q) failed: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	return out.Bytes()
}
