package app

import (
	"errors"
	"os"
	"path/filepath"
)

const appName = "mini-godbolt"

type Config struct {
	Addr             string
	OpenURL          bool
	ExeDir           string
	ProjectDir       string
	IncludeDir       string
	SystemIncludeDir string
	CacheDir         string
}

func DefaultConfig() (Config, error) {
	exeDir, err := executableDir()
	if err != nil {
		return Config{}, err
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, err
	}

	cacheBase, err := os.UserCacheDir()
	if err != nil {
		cacheBase = filepath.Join(home, "AppData", "Local")
	}

	return Config{
		Addr:       "127.0.0.1:0",
		OpenURL:    true,
		ExeDir:     exeDir,
		ProjectDir: filepath.Join(desktopDir(home), "mini-godbolt-project"),
		IncludeDir: filepath.Join(exeDir, "include"),
		CacheDir:   filepath.Join(cacheBase, appName),
	}, nil
}

func executableDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		cwd, cwdErr := os.Getwd()
		if cwdErr != nil {
			return "", errors.Join(err, cwdErr)
		}
		return cwd, nil
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err == nil {
		exe = resolved
	}
	return filepath.Dir(exe), nil
}
