package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultConfigUsesAppDataProjectDir(t *testing.T) {
	cfg, err := DefaultConfig()
	if err != nil {
		t.Fatalf("DefaultConfig failed: %v", err)
	}
	if filepath.Base(cfg.ProjectDir) != "project" || filepath.Base(filepath.Dir(cfg.ProjectDir)) != appName {
		t.Fatalf("ProjectDir = %q, want an app-owned project directory", cfg.ProjectDir)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	legacyDesktopProject := filepath.Join(home, "Desktop", "mini-godbolt-project")
	if samePath(cfg.ProjectDir, legacyDesktopProject) {
		t.Fatalf("ProjectDir still uses legacy desktop folder: %q", cfg.ProjectDir)
	}
}

func samePath(a, b string) bool {
	rel, err := filepath.Rel(filepath.Clean(a), filepath.Clean(b))
	return err == nil && rel == "."
}
