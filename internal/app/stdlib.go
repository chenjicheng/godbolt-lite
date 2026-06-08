package app

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
)

//go:embed stdlib/*.h
var stdlibHeaders embed.FS

func EnsureSystemInclude(cacheDir string) (string, error) {
	targetRoot := filepath.Join(cacheDir, "system-include", "c17")
	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		return "", err
	}

	err := fs.WalkDir(stdlibHeaders, "stdlib", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		data, err := stdlibHeaders.ReadFile(path)
		if err != nil {
			return err
		}
		target := filepath.Join(targetRoot, filepath.Base(path))
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		return "", err
	}
	return targetRoot, nil
}
