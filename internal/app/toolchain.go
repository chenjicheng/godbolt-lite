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
)

//go:embed toolchains/*
var embeddedToolchains embed.FS

type Toolchain struct {
	Clang   string
	Clangd  string
	LLDLink string
	Root    string
}

func EnsureToolchain(cfg Config) (Toolchain, error) {
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
	}
	if tc, ok := discoverPATHToolchain(); ok {
		return tc, nil
	}
	return Toolchain{}, errors.New("clang/clangd not found; add an embedded LLVM zip at internal/app/toolchains/llvm-windows-amd64.zip before release build, place LLVM next to the exe under toolchain/bin, or install LLVM on PATH for development")
}

func discoverSidecarToolchain(exeDir string) (Toolchain, bool) {
	root := filepath.Join(exeDir, "toolchain")
	tc := Toolchain{
		Clang:   exeName(filepath.Join(root, "bin", "clang")),
		Clangd:  exeName(filepath.Join(root, "bin", "clangd")),
		LLDLink: exeName(filepath.Join(root, "bin", "lld-link")),
		Root:    root,
	}
	return tc, fileExists(tc.Clang) && fileExists(tc.Clangd)
}

func discoverEmbeddedToolchain(cacheDir string) (Toolchain, bool) {
	root := filepath.Join(cacheDir, "toolchains", "llvm-windows-amd64")
	tc := Toolchain{
		Clang:   exeName(filepath.Join(root, "bin", "clang")),
		Clangd:  exeName(filepath.Join(root, "bin", "clangd")),
		LLDLink: exeName(filepath.Join(root, "bin", "lld-link")),
		Root:    root,
	}
	return tc, fileExists(tc.Clang) && fileExists(tc.Clangd)
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
	if err := os.MkdirAll(root, 0o755); err != nil {
		return Toolchain{}, err
	}
	for _, file := range zr.File {
		target := filepath.Join(root, filepath.Clean(file.Name))
		if err := ensurePathInside(root, target); err != nil {
			return Toolchain{}, err
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return Toolchain{}, err
			}
			continue
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
	tc := Toolchain{
		Clang:   exeName(filepath.Join(root, "bin", "clang")),
		Clangd:  exeName(filepath.Join(root, "bin", "clangd")),
		LLDLink: exeName(filepath.Join(root, "bin", "lld-link")),
		Root:    root,
	}
	if !fileExists(tc.Clang) || !fileExists(tc.Clangd) {
		return Toolchain{}, fmt.Errorf("embedded LLVM archive extracted but clang/clangd were not found under %s", filepath.Join(root, "bin"))
	}
	return tc, nil
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
