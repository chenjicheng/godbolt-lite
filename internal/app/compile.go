package app

import (
	"context"
	"errors"
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
	if err := c.validateCompilerArgs(compilerArgs); err != nil {
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

	err = runCommand(ctx, cmd)
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
	if err := c.validateCompilerArgs(compilerArgs); err != nil {
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

	sourcePaths, err := c.runSourcePaths(ctx, activeSourcePath, compilerArgs)
	if err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	runRoot := filepath.Join(absPath(c.projectDir), ".mini-godbolt-run")
	runDir := filepath.Join(runRoot, runArtifactName(req.RequestID, start))
	if err := ensurePathInside(c.projectDir, runRoot); err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	if err := ensurePathInside(runRoot, runDir); err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		resp.Error = err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	defer os.RemoveAll(runDir)
	exePath := exeName(filepath.Join(runDir, "program"))
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

	err = runCommand(buildCtx, buildCmd)
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

	err = runCommand(runCtx, runCmd)
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
