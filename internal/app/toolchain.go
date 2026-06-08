package app

import (
	"archive/zip"
	"bytes"
	"embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed toolchains/*
var embeddedToolchains embed.FS

const toolchainReadyMarker = ".mini-godbolt-toolchain-ready"
const maxEmbeddedToolchainEntries = 20000
const maxEmbeddedToolchainUncompressedBytes = 700 << 20

type Toolchain struct {
	Clang   string
	Clangd  string
	LLDLink string
	Root    string
}

func EnsureToolchain(cfg Config) (Toolchain, error) {
	var discoveryErrors []error
	if tc, ok := discoverSidecarToolchain(cfg.ExeDir); ok {
		return tc, nil
	}
	if tc, ok := discoverEmbeddedToolchain(cfg.CacheDir); ok {
		return tc, nil
	}
	if tc, err := extractEmbeddedToolchain(cfg.CacheDir); err == nil {
		return tc, nil
	} else if tc, ok := discoverEmbeddedToolchain(cfg.CacheDir); ok {
		return tc, nil
	} else {
		discoveryErrors = append(discoveryErrors, fmt.Errorf("embedded LLVM extraction failed: %w", err))
	}
	if tc, ok := discoverPATHToolchain(); ok {
		return tc, nil
	}
	discoveryErrors = append([]error{errors.New("clang/clangd not found; add an embedded LLVM zip at internal/app/toolchains/llvm-windows-amd64.zip before release build, place LLVM next to the exe under toolchain/bin, or install LLVM on PATH for development")}, discoveryErrors...)
	return Toolchain{}, errors.Join(discoveryErrors...)
}

func discoverSidecarToolchain(exeDir string) (Toolchain, bool) {
	root := filepath.Join(exeDir, "toolchain")
	tc := Toolchain{
		Clang:   exeName(filepath.Join(root, "bin", "clang")),
		Clangd:  exeName(filepath.Join(root, "bin", "clangd")),
		LLDLink: exeName(filepath.Join(root, "bin", "lld-link")),
		Root:    root,
	}
	return tc, fileExists(tc.Clang) && fileExists(tc.Clangd) && fileExists(tc.LLDLink)
}

func discoverEmbeddedToolchain(cacheDir string) (Toolchain, bool) {
	root := filepath.Join(cacheDir, "toolchains", "llvm-windows-amd64")
	tc := Toolchain{
		Clang:   exeName(filepath.Join(root, "bin", "clang")),
		Clangd:  exeName(filepath.Join(root, "bin", "clangd")),
		LLDLink: exeName(filepath.Join(root, "bin", "lld-link")),
		Root:    root,
	}
	return tc, fileExists(filepath.Join(root, toolchainReadyMarker)) && fileExists(tc.Clang) && fileExists(tc.Clangd) && fileExists(tc.LLDLink)
}

func extractEmbeddedToolchain(cacheDir string) (Toolchain, error) {
	archiveName := "toolchains/llvm-windows-amd64.zip"
	f, err := embeddedToolchains.Open(archiveName)
	if err != nil {
		return Toolchain{}, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return Toolchain{}, err
	}
	readerAt, ok := f.(io.ReaderAt)
	if !ok {
		data, err := io.ReadAll(f)
		if err != nil {
			return Toolchain{}, err
		}
		return extractZipBytes(cacheDir, data)
	}

	zr, err := zip.NewReader(readerAt, info.Size())
	if err != nil {
		return Toolchain{}, err
	}
	return extractZipReader(cacheDir, zr)
}

func extractZipBytes(cacheDir string, data []byte) (Toolchain, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Toolchain{}, err
	}
	return extractZipReader(cacheDir, zr)
}

func extractZipReader(cacheDir string, zr *zip.Reader) (Toolchain, error) {
	root := filepath.Join(cacheDir, "toolchains", "llvm-windows-amd64")
	parent := filepath.Dir(root)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return Toolchain{}, err
	}
	tempRoot, err := os.MkdirTemp(parent, "llvm-windows-amd64-*")
	if err != nil {
		return Toolchain{}, err
	}
	defer os.RemoveAll(tempRoot)

	if err := validateEmbeddedZipEntries(zr); err != nil {
		return Toolchain{}, err
	}

	for _, file := range zr.File {
		archiveName := strings.ReplaceAll(file.Name, "\\", "/")
		cleanName := filepath.Clean(archiveName)
		if cleanName == "." || filepath.IsAbs(cleanName) || strings.HasPrefix(cleanName, ".."+string(filepath.Separator)) || cleanName == ".." {
			return Toolchain{}, fmt.Errorf("embedded LLVM archive contains unsafe path %q", file.Name)
		}
		target := filepath.Join(tempRoot, cleanName)
		if err := ensurePathInside(tempRoot, target); err != nil {
			return Toolchain{}, err
		}
		if isZipDirectory(file, archiveName) {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return Toolchain{}, err
			}
			continue
		}
		if !file.Mode().IsRegular() {
			return Toolchain{}, fmt.Errorf("embedded LLVM archive contains unsupported non-regular entry %q", file.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return Toolchain{}, err
		}
		src, err := file.Open()
		if err != nil {
			return Toolchain{}, err
		}
		dst, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, file.Mode())
		if err != nil {
			src.Close()
			return Toolchain{}, err
		}
		_, copyErr := io.Copy(dst, src)
		closeErr := errors.Join(src.Close(), dst.Close())
		if err := errors.Join(copyErr, closeErr); err != nil {
			return Toolchain{}, err
		}
	}
	if err := os.WriteFile(filepath.Join(tempRoot, toolchainReadyMarker), []byte("ready\n"), 0o644); err != nil {
		return Toolchain{}, err
	}

	tc := Toolchain{
		Clang:   exeName(filepath.Join(tempRoot, "bin", "clang")),
		Clangd:  exeName(filepath.Join(tempRoot, "bin", "clangd")),
		LLDLink: exeName(filepath.Join(tempRoot, "bin", "lld-link")),
		Root:    tempRoot,
	}
	if !fileExists(tc.Clang) || !fileExists(tc.Clangd) || !fileExists(tc.LLDLink) {
		return Toolchain{}, fmt.Errorf("embedded LLVM archive extracted but clang/clangd/lld-link were not found under %s", filepath.Join(tempRoot, "bin"))
	}
	if err := ensurePathInside(parent, root); err != nil {
		return Toolchain{}, err
	}
	if err := os.RemoveAll(root); err != nil {
		return Toolchain{}, err
	}
	if err := os.Rename(tempRoot, root); err != nil {
		return Toolchain{}, err
	}
	if tc, ok := discoverEmbeddedToolchain(cacheDir); ok {
		return tc, nil
	}
	return Toolchain{}, fmt.Errorf("embedded LLVM archive extracted but validated toolchain was not found under %s", root)
}

func validateEmbeddedZipEntries(zr *zip.Reader) error {
	if len(zr.File) > maxEmbeddedToolchainEntries {
		return fmt.Errorf("embedded LLVM archive has %d entries; maximum is %d", len(zr.File), maxEmbeddedToolchainEntries)
	}
	var total uint64
	for _, file := range zr.File {
		total += file.UncompressedSize64
		if total > maxEmbeddedToolchainUncompressedBytes {
			return fmt.Errorf("embedded LLVM archive expands beyond %d bytes", maxEmbeddedToolchainUncompressedBytes)
		}
		if isZipDirectory(file, strings.ReplaceAll(file.Name, "\\", "/")) {
			continue
		}
		if !file.Mode().IsRegular() {
			return fmt.Errorf("embedded LLVM archive contains unsupported non-regular entry %q", file.Name)
		}
	}
	return nil
}

func isZipDirectory(file *zip.File, archiveName string) bool {
	return file.FileInfo().IsDir() || strings.HasSuffix(archiveName, "/")
}

func discoverPATHToolchain() (Toolchain, bool) {
	clang, clangErr := exec.LookPath("clang")
	clangd, clangdErr := exec.LookPath("clangd")
	if clangErr != nil || clangdErr != nil {
		return Toolchain{}, false
	}
	lldLink, _ := exec.LookPath("lld-link")
	root := filepath.Dir(filepath.Dir(clang))
	return Toolchain{Clang: clang, Clangd: clangd, LLDLink: lldLink, Root: root}, true
}

func exeName(path string) string {
	if runtime.GOOS == "windows" {
		return path + ".exe"
	}
	return path
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func embeddedToolchainNames() []string {
	names := []string{}
	fs.WalkDir(embeddedToolchains, "toolchains", func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			names = append(names, path)
		}
		return nil
	})
	return names
}
