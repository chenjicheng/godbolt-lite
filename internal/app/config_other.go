//go:build !windows

package app

import "path/filepath"

func desktopDir(home string) string {
	return filepath.Join(home, "Desktop")
}
