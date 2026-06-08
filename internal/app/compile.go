package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type CompileRequest struct {
	ActiveFile   string `json:"activeFile"`
	Source       string `json:"source,omitempty"`
	CompilerArgs string `json:"compilerArgs"`
	RequestID    string `json:"requestId"`
}

type CompileResponse struct {
	OK         bool   `json:"ok"`
	ASM        string `json:"asm"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	RequestID  string `json:"requestId"`
	Error      string `json:"error,omitempty"`
}

type RunRequest struct {
	ActiveFile   string `json:"activeFile"`
	CompilerArgs string `json:"compilerArgs"`
	RequestID    string `json:"requestId"`
}

type RunResponse struct {
	OK         bool   `json:"ok"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	RequestID  string `json:"requestId"`
	Error      string `json:"error,omitempty"`
	Note       string `json:"note,omitempty"`
}

type Compiler struct {
	clang            string
	lldLink          string
	projectDir       string
	includeDir       string
	systemIncludeDir string
}

func NewCompiler(clang, projectDir, includeDir, systemIncludeDir string) *Compiler {
	lldLink := ""
	if clang != "" {
		candidate := exeName(filepath.Join(filepath.Dir(clang), "lld-link"))
		if fileExists(candidate) {
			lldLink = candidate
		} else if found, err := exec.LookPath("lld-link"); err == nil {
			lldLink = found
		}
	}
	return &Compiler{clang: clang, lldLink: lldLink, projectDir: projectDir, includeDir: includeDir, systemIncludeDir: systemIncludeDir}
}

func (c *Compiler) Compile(ctx context.Context, req CompileRequest) CompileResponse {
	start := time.Now()
	resp := CompileResponse{RequestID: req.RequestID, ExitCode: -1}

	if c.clang == "" {
		resp.Error = "clang is not available"
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	_, sourcePath, err := c.activeSourcePath(req.ActiveFile)
	if err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	compilerArgs, err := splitCompilerArgs(defaultIfEmpty(req.CompilerArgs, defaultCompilerArgs))
	if err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	args := c.baseCompileArgs()
	args = append(args, compilerArgs...)
	args = append(args, "-S", "-o", "-", sourcePath)

	cmd := exec.CommandContext(ctx, c.clang, args...)
	cmd.Env = c.commandEnv()
	var stdout, stderr limitedBuffer
	stdout.limit = 4 << 20
	stderr.limit = 1 << 20
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	resp.ASM = stdout.String()
	resp.Stderr = stderr.String()
	resp.DurationMs = time.Since(start).Milliseconds()

	if ctx.Err() != nil {
		resp.Error = "compile timed out"
		return resp
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			resp.ExitCode = exitErr.ExitCode()
		} else {
			resp.Error = err.Error()
		}
		return resp
	}

	resp.OK = true
	resp.ExitCode = 0
	return resp
}

func (c *Compiler) Run(ctx context.Context, req RunRequest) RunResponse {
	start := time.Now()
	resp := RunResponse{RequestID: req.RequestID, ExitCode: -1}

	if c.clang == "" {
		resp.Error = "clang is not available"
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	_, activeSourcePath, err := c.activeSourcePath(req.ActiveFile)
	if err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	rawCompilerArgs, err := splitCompilerArgs(defaultIfEmpty(req.CompilerArgs, defaultCompilerArgs))
	if err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	compilerArgs, note, err := prepareRunCompilerArgs(rawCompilerArgs)
	if err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	resp.Note = note
	if runtime.GOOS == "windows" && c.lldLink == "" && !hasLinkerChoice(compilerArgs) {
		resp.Error = "Run needs a Windows linker. Add lld-link.exe next to clang.exe, install LLVM with lld-link on PATH, or pass a working linker option."
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	sourcePaths, err := c.runSourcePaths(activeSourcePath)
	if err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	runDir := filepath.Join(absPath(c.projectDir), ".mini-godbolt-run")
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	exePath := exeName(filepath.Join(runDir, runArtifactName(req.RequestID, start)))
	defer os.Remove(exePath)
	_ = os.Remove(exePath)

	buildCtx, cancelBuild := context.WithTimeout(ctx, 8*time.Second)
	defer cancelBuild()

	args := c.baseCompileArgs()
	args = append(args, compilerArgs...)
	if c.lldLink != "" && !hasLinkerChoice(compilerArgs) {
		args = append(args, "-fuse-ld=lld")
	}
	args = append(args, sourcePaths...)
	args = append(args, "-o", exePath)

	buildCmd := exec.CommandContext(buildCtx, c.clang, args...)
	buildCmd.Dir = absPath(c.projectDir)
	buildCmd.Env = c.commandEnv()
	var buildStdout, buildStderr limitedBuffer
	buildStdout.limit = 1 << 20
	buildStderr.limit = 1 << 20
	buildCmd.Stdout = &buildStdout
	buildCmd.Stderr = &buildStderr

	err = buildCmd.Run()
	resp.Stderr = combineOutput(buildStdout.String(), buildStderr.String())
	resp.DurationMs = time.Since(start).Milliseconds()
	if buildCtx.Err() != nil {
		resp.Error = "build timed out"
		return resp
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			resp.ExitCode = exitErr.ExitCode()
			resp.Error = "build failed"
		} else {
			resp.Error = err.Error()
		}
		return resp
	}

	runCtx, cancelRun := context.WithTimeout(ctx, 4*time.Second)
	defer cancelRun()

	runCmd := exec.CommandContext(runCtx, exePath)
	runCmd.Dir = absPath(c.projectDir)
	runCmd.Env = c.commandEnv()
	var stdout, stderr limitedBuffer
	stdout.limit = 1 << 20
	stderr.limit = 1 << 20
	runCmd.Stdout = &stdout
	runCmd.Stderr = &stderr

	err = runCmd.Run()
	resp.Stdout = stdout.String()
	resp.Stderr = combineOutput(resp.Stderr, stderr.String())
	resp.DurationMs = time.Since(start).Milliseconds()
	if runCtx.Err() != nil {
		resp.Error = "program timed out"
		return resp
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			resp.OK = true
			resp.ExitCode = exitErr.ExitCode()
			return resp
		}
		resp.Error = err.Error()
		return resp
	}

	resp.OK = true
	resp.ExitCode = 0
	return resp
}

func (c *Compiler) activeSourcePath(activeFile string) (string, string, error) {
	active, err := cleanProjectPath(activeFile)
	if err != nil {
		return "", "", err
	}
	if !strings.EqualFold(filepath.Ext(active), ".c") {
		return "", "", errors.New("active file must be a .c file")
	}
	sourcePath := filepath.Join(c.projectDir, filepath.FromSlash(active))
	if err := ensurePathInside(c.projectDir, sourcePath); err != nil {
		return "", "", err
	}
	return active, absPath(sourcePath), nil
}

func (c *Compiler) baseCompileArgs() []string {
	return []string{
		"-x", "c",
		"-std=c17",
		"-isystem", absPath(c.systemIncludeDir),
		"-I", absPath(c.projectDir),
		"-I", absPath(c.includeDir),
	}
}

func absPath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}

func (c *Compiler) commandEnv() []string {
	env := os.Environ()
	if c.clang == "" {
		return env
	}
	binDir := filepath.Dir(c.clang)
	if binDir == "." || binDir == "" {
		return env
	}
	for i, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if ok && strings.EqualFold(name, "PATH") {
			env[i] = name + "=" + binDir + string(os.PathListSeparator) + value
			return env
		}
	}
	return append(env, "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func (c *Compiler) runSourcePaths(activeSourcePath string) ([]string, error) {
	var paths []string
	seenSources := map[string]struct{}{}
	scannedFiles := map[string]struct{}{}
	visitedHeaders := map[string]struct{}{}
	addSource := func(path string) error {
		abs, err := filepath.Abs(path)
		if err != nil {
			return err
		}
		if !c.isProjectOrIncludePath(abs) {
			return fmt.Errorf("source %q is outside the project and include folders", abs)
		}
		key := strings.ToLower(abs)
		if _, ok := seenSources[key]; ok {
			return nil
		}
		seenSources[key] = struct{}{}
		paths = append(paths, abs)
		return nil
	}

	var scanFile func(string) error
	scanFile = func(path string) error {
		abs, err := filepath.Abs(path)
		if err != nil {
			return err
		}
		key := strings.ToLower(abs)
		if _, ok := scannedFiles[key]; ok {
			return nil
		}
		scannedFiles[key] = struct{}{}

		includes, err := localIncludeNames(abs)
		if err != nil {
			return err
		}
		for _, includeName := range includes {
			header, ok := c.resolveLocalInclude(abs, includeName)
			if !ok {
				continue
			}
			headerKey := strings.ToLower(header)
			if _, ok := visitedHeaders[headerKey]; ok {
				continue
			}
			visitedHeaders[headerKey] = struct{}{}

			if err := scanFile(header); err != nil {
				return err
			}
			impl, ok := implementationSourceForHeader(header)
			if !ok || !c.isProjectOrIncludePath(impl) {
				continue
			}
			if err := addSource(impl); err != nil {
				return err
			}
			if err := scanFile(impl); err != nil {
				return err
			}
		}
		return nil
	}

	if err := addSource(activeSourcePath); err != nil {
		return nil, err
	}
	if err := scanFile(activeSourcePath); err != nil {
		return nil, err
	}
	return paths, nil
}

func localIncludeNames(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var includes []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "#"))
		if !strings.HasPrefix(line, "include") {
			continue
		}
		rest := strings.TrimSpace(strings.TrimPrefix(line, "include"))
		if !strings.HasPrefix(rest, "\"") {
			continue
		}
		rest = strings.TrimPrefix(rest, "\"")
		includeName, _, ok := strings.Cut(rest, "\"")
		if ok && strings.TrimSpace(includeName) != "" {
			includes = append(includes, includeName)
		}
	}
	return includes, nil
}

func (c *Compiler) resolveLocalInclude(currentPath, includeName string) (string, bool) {
	includeName = strings.TrimSpace(includeName)
	if includeName == "" || filepath.IsAbs(includeName) {
		return "", false
	}
	includePath := filepath.FromSlash(strings.ReplaceAll(includeName, "\\", "/"))
	searchDirs := []string{filepath.Dir(currentPath), c.projectDir, c.includeDir}
	seenDirs := map[string]struct{}{}
	for _, dir := range searchDirs {
		absDir, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		dirKey := strings.ToLower(absDir)
		if _, ok := seenDirs[dirKey]; ok {
			continue
		}
		seenDirs[dirKey] = struct{}{}

		candidate := filepath.Clean(filepath.Join(absDir, includePath))
		if !c.isProjectOrIncludePath(candidate) || !fileExists(candidate) {
			continue
		}
		abs, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		return abs, true
	}
	return "", false
}

func implementationSourceForHeader(headerPath string) (string, bool) {
	if !strings.EqualFold(filepath.Ext(headerPath), ".h") {
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

func (c *Compiler) isProjectOrIncludePath(path string) bool {
	return pathInsideRoot(c.projectDir, path) || pathInsideRoot(c.includeDir, path)
}

func pathInsideRoot(root, path string) bool {
	if root == "" {
		return false
	}
	return ensurePathInside(root, path) == nil
}

func prepareRunCompilerArgs(args []string) ([]string, string, error) {
	out := make([]string, 0, len(args))
	note := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-target":
			if i+1 >= len(args) {
				return nil, "", errors.New("-target requires a target triple")
			}
			target := args[i+1]
			i++
			if isLinuxTarget(target) {
				note = linuxTargetRunNote
				continue
			}
			return nil, "", fmt.Errorf("program output only supports the native Windows target here; remove -target %s", target)
		case strings.HasPrefix(arg, "--target="):
			target := strings.TrimPrefix(arg, "--target=")
			if isLinuxTarget(target) {
				note = linuxTargetRunNote
				continue
			}
			return nil, "", fmt.Errorf("program output only supports the native Windows target here; remove %s", arg)
		case strings.HasPrefix(arg, "-target="):
			target := strings.TrimPrefix(arg, "-target=")
			if isLinuxTarget(target) {
				note = linuxTargetRunNote
				continue
			}
			return nil, "", fmt.Errorf("program output only supports the native Windows target here; remove %s", arg)
		case arg == "-S" || arg == "-c" || arg == "-E":
			return nil, "", fmt.Errorf("Run needs a linked executable; remove %s from compiler arguments", arg)
		case arg == "-o" || arg == "--output":
			return nil, "", fmt.Errorf("Run controls the output executable path; remove %s from compiler arguments", arg)
		case strings.HasPrefix(arg, "-o") && arg != "-Og":
			return nil, "", fmt.Errorf("Run controls the output executable path; remove %s from compiler arguments", arg)
		case strings.HasPrefix(arg, "--output="):
			return nil, "", fmt.Errorf("Run controls the output executable path; remove %s from compiler arguments", arg)
		default:
			out = append(out, arg)
		}
	}
	return out, note, nil
}

const linuxTargetRunNote = "Linux ABI output cannot execute directly on Windows. This run uses a native Windows Clang build with the Linux -target flag omitted, so ABI-sensitive behavior can differ from the assembly view."

func isLinuxTarget(target string) bool {
	return strings.Contains(strings.ToLower(target), "linux")
}

func hasLinkerChoice(args []string) bool {
	for _, arg := range args {
		if arg == "-fuse-ld" || strings.HasPrefix(arg, "-fuse-ld=") {
			return true
		}
	}
	return false
}

func combineOutput(left, right string) string {
	left = strings.TrimRight(left, "\r\n")
	right = strings.TrimRight(right, "\r\n")
	if left == "" {
		return right
	}
	if right == "" {
		return left
	}
	return left + "\n" + right
}

func runArtifactName(requestID string, start time.Time) string {
	var b strings.Builder
	b.WriteString("program-")
	for _, r := range requestID {
		if b.Len() >= 88 {
			break
		}
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	if b.Len() == len("program-") {
		b.WriteString(fmt.Sprintf("%d", start.UnixNano()))
	}
	return b.String()
}

type limitedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.limit <= 0 {
		return len(p), nil
	}
	remaining := b.limit - b.buf.Len()
	if remaining <= 0 {
		return len(p), nil
	}
	if len(p) > remaining {
		b.buf.Write(p[:remaining])
		return len(p), fmt.Errorf("output exceeded %d bytes", b.limit)
	}
	b.buf.Write(p)
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	return b.buf.String()
}
