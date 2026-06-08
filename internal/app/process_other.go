//go:build !windows

package app

import (
	"context"
	"os/exec"
)

func runCommand(_ context.Context, cmd *exec.Cmd) error {
	return cmd.Run()
}
