package app

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type dependencyReader func(context.Context, string) ([]string, error)

const maxRunSourceFiles = 256

func (c *Compiler) runSourcePaths(ctx context.Context, activeSourcePath string, compilerArgs []string) ([]string, error) {
	return c.discoverRunSourcePaths(ctx, activeSourcePath, func(ctx context.Context, sourcePath string) ([]string, error) {
		return c.sourceDependencies(ctx, sourcePath, compilerArgs)
	})
}

func (c *Compiler) discoverRunSourcePaths(ctx context.Context, activeSourcePath string, readDeps dependencyReader) ([]string, error) {
	var paths []string
	seenSources := map[string]struct{}{}
	scannedSources := map[string]struct{}{}

	addSource := func(path string) error {
		abs, err := filepath.Abs(path)
		if err != nil {
			return err
		}
		if !c.isProjectPath(abs) {
			return fmt.Errorf("source %q is outside the project folder", abs)
		}
		key := strings.ToLower(abs)
		if _, ok := seenSources[key]; ok {
			return nil
		}
		if len(paths) >= maxRunSourceFiles {
			return fmt.Errorf("run source discovery exceeded %d source files", maxRunSourceFiles)
		}
		seenSources[key] = struct{}{}
		paths = append(paths, abs)
		return nil
	}

	if err := addSource(activeSourcePath); err != nil {
		return nil, err
	}

	for index := 0; index < len(paths); index++ {
		sourcePath := paths[index]
		sourceKey := strings.ToLower(sourcePath)
		if _, ok := scannedSources[sourceKey]; ok {
			continue
		}
		scannedSources[sourceKey] = struct{}{}

		deps, err := readDeps(ctx, sourcePath)
		if err != nil {
			return nil, err
		}
		for _, dep := range deps {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if !isHeaderPath(dep) || !c.isProjectPath(dep) {
				continue
			}
			impl, ok := implementationSourceForHeader(dep)
			if !ok || !c.isProjectPath(impl) {
				continue
			}
			if err := addSource(impl); err != nil {
				return nil, err
			}
		}
	}
	return paths, nil
}

func (c *Compiler) sourceDependencies(ctx context.Context, sourcePath string, compilerArgs []string) ([]string, error) {
	depCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	args := c.baseCompileArgs()
	args = append(args, dependencyCompilerArgs(compilerArgs)...)
	args = append(args, "-MM", "-MT", "__mini_godbolt_deps", sourcePath)

	cmd := exec.CommandContext(depCtx, c.clang, args...)
	cmd.Dir = absPath(c.projectDir)
	cmd.Env = c.commandEnv()
	var stdout, stderr limitedBuffer
	stdout.limit = 1 << 20
	stderr.limit = 1 << 20
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := runCommand(depCtx, cmd)
	if depCtx.Err() != nil {
		return nil, errors.New("dependency discovery timed out")
	}
	if err != nil {
		return nil, fmt.Errorf("dependency discovery failed: %s", combineOutput(stdout.String(), stderr.String()))
	}
	return parseMakefileDependencies(stdout.String())
}

func parseMakefileDependencies(output string) ([]string, error) {
	normalized := strings.ReplaceAll(output, "\\\r\n", " ")
	normalized = strings.ReplaceAll(normalized, "\\\n", " ")
	separator := strings.Index(normalized, ":")
	if separator < 0 {
		return nil, errors.New("dependency output is missing a target separator")
	}
	return splitMakefileWords(normalized[separator+1:]), nil
}

func splitMakefileWords(input string) []string {
	var out []string
	var current strings.Builder
	escaping := false
	for _, r := range input {
		if escaping {
			current.WriteRune(r)
			escaping = false
			continue
		}
		if r == '\\' {
			escaping = true
			continue
		}
		if r == ' ' || r == '\t' || r == '\r' || r == '\n' {
			if current.Len() > 0 {
				out = append(out, filepath.FromSlash(current.String()))
				current.Reset()
			}
			continue
		}
		current.WriteRune(r)
	}
	if escaping {
		current.WriteRune('\\')
	}
	if current.Len() > 0 {
		out = append(out, filepath.FromSlash(current.String()))
	}
	return out
}

func implementationSourceForHeader(headerPath string) (string, bool) {
	if !isHeaderPath(headerPath) {
		return "", false
	}
	candidate := strings.TrimSuffix(headerPath, filepath.Ext(headerPath)) + ".c"
	if !fileExists(candidate) {
		return "", false
	}
	abs, err := filepath.Abs(candidate)
	if err != nil {
		return "", false
	}
	return abs, true
}

func isHeaderPath(path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".h")
}

func (c *Compiler) isProjectPath(path string) bool {
	return pathInsideRoot(c.projectDir, path)
}

func pathInsideRoot(root, path string) bool {
	if root == "" {
		return false
	}
	return ensurePathInside(root, path) == nil
}
