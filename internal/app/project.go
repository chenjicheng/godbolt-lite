package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	securejoin "github.com/cyphar/filepath-securejoin"
)

type ProjectFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type ProjectState struct {
	Files        []ProjectFile `json:"files"`
	ActiveFile   string        `json:"activeFile"`
	CompilerArgs string        `json:"compilerArgs"`
}

type ProjectStore struct {
	dir              string
	includeDir       string
	systemIncludeDir string
	clangPath        string
	mu               sync.Mutex
	state            ProjectState
}

func NewProjectStore(dir, includeDir, systemIncludeDir, clangPath string) *ProjectStore {
	return &ProjectStore{dir: dir, includeDir: includeDir, systemIncludeDir: systemIncludeDir, clangPath: clangPath}
}

func (p *ProjectStore) Load() (ProjectState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.state.Files) > 0 {
		return p.state, nil
	}

	data, err := os.ReadFile(filepath.Join(p.dir, "project.json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			state := defaultProjectState()
			if writeErr := p.writeLocked(state, ProjectState{}); writeErr != nil {
				return ProjectState{}, writeErr
			}
			p.state = state
			return p.state, nil
		}
		return ProjectState{}, err
	}

	var state ProjectState
	if err := json.Unmarshal(data, &state); err != nil {
		return ProjectState{}, err
	}
	if len(state.Files) == 0 {
		state = defaultProjectState()
	}
	normalized, err := normalizeState(state)
	if err != nil {
		return ProjectState{}, err
	}
	if err := p.writeLocked(normalized, ProjectState{}); err != nil {
		return ProjectState{}, err
	}
	p.state = normalized
	return p.state, nil
}

func (p *ProjectStore) Sync(state ProjectState) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	normalized, err := normalizeState(state)
	if err != nil {
		return err
	}
	previous := p.state
	if err := p.writeLocked(normalized, previous); err != nil {
		return err
	}
	p.state = normalized
	return nil
}

func (p *ProjectStore) Snapshot() ProjectState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return cloneState(p.state)
}

func (p *ProjectStore) FileContent(path string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	clean, err := cleanProjectPath(path)
	if err != nil {
		return "", err
	}
	for _, file := range p.state.Files {
		if file.Path == clean {
			return file.Content, nil
		}
	}
	data, err := os.ReadFile(filepath.Join(p.dir, clean))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (p *ProjectStore) writeLocked(state, previous ProjectState) error {
	if err := os.MkdirAll(p.dir, 0o755); err != nil {
		return err
	}
	if err := p.removeDeletedFilesLocked(previous, state); err != nil {
		return err
	}
	for _, file := range state.Files {
		target := filepath.Join(p.dir, filepath.FromSlash(file.Path))
		if err := ensurePathInside(p.dir, target); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, []byte(file.Content), 0o644); err != nil {
			return err
		}
	}

	manifest, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(p.dir, "project.json"), manifest, 0o644); err != nil {
		return err
	}
	return p.writeCompileCommandsLocked(state)
}

func (p *ProjectStore) removeDeletedFilesLocked(previous, next ProjectState) error {
	if len(previous.Files) == 0 {
		return nil
	}
	kept := make(map[string]struct{}, len(next.Files))
	for _, file := range next.Files {
		kept[file.Path] = struct{}{}
	}
	for _, file := range previous.Files {
		if _, ok := kept[file.Path]; ok {
			continue
		}
		target := filepath.Join(p.dir, filepath.FromSlash(file.Path))
		if err := ensurePathInside(p.dir, target); err != nil {
			return err
		}
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (p *ProjectStore) writeCompileCommandsLocked(state ProjectState) error {
	var commands []commandEntry
	compilerArgs, err := splitCompilerArgs(defaultIfEmpty(state.CompilerArgs, defaultCompilerArgs))
	if err != nil {
		return err
	}
	for _, file := range state.Files {
		if strings.EqualFold(filepath.Ext(file.Path), ".c") {
			absFile := filepath.Join(p.dir, filepath.FromSlash(file.Path))
			commands = append(commands, p.compileCommandFor(absFile, compilerArgs))
		}
	}
	includeEntries, err := p.includeSourceCommands(compilerArgs)
	if err != nil {
		return err
	}
	commands = append(commands, includeEntries...)
	out, err := json.MarshalIndent(commands, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(p.dir, "compile_commands.json"), out, 0o644)
}

func (p *ProjectStore) includeSourceCommands(compilerArgs []string) ([]commandEntry, error) {
	var commands []commandEntry
	info, err := os.Stat(p.includeDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if !info.IsDir() {
		return nil, nil
	}
	err = filepath.WalkDir(p.includeDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".c") {
			return nil
		}
		commands = append(commands, p.compileCommandFor(path, compilerArgs))
		return nil
	})
	return commands, err
}

type commandEntry struct {
	Directory string `json:"directory"`
	Command   string `json:"command"`
	File      string `json:"file"`
}

func (p *ProjectStore) compileCommandFor(absFile string, compilerArgs []string) commandEntry {
	args := []string{
		p.clangPath,
		"-x", "c",
		"-std=c17",
		"-isystem", p.systemIncludeDir,
		"-I", p.dir,
		"-I", p.includeDir,
	}
	args = append(args, compilerArgs...)
	args = append(args,
		"-c",
		absFile,
	)
	return commandEntry{
		Directory: p.dir,
		Command:   commandLine(args),
		File:      absFile,
	}
}

func normalizeState(state ProjectState) (ProjectState, error) {
	seen := make(map[string]struct{}, len(state.Files))
	files := make([]ProjectFile, 0, len(state.Files))
	for _, file := range state.Files {
		clean, err := cleanProjectPath(file.Path)
		if err != nil {
			return ProjectState{}, err
		}
		if !isSourceLike(clean) {
			return ProjectState{}, fmt.Errorf("unsupported file extension for %q", clean)
		}
		seenKey := strings.ToLower(clean)
		if _, ok := seen[seenKey]; ok {
			return ProjectState{}, fmt.Errorf("duplicate project file %q", clean)
		}
		seen[seenKey] = struct{}{}
		files = append(files, ProjectFile{Path: clean, Content: file.Content})
	}
	slices.SortFunc(files, func(a, b ProjectFile) int {
		return strings.Compare(a.Path, b.Path)
	})

	active := state.ActiveFile
	if active == "" && len(files) > 0 {
		active = files[0].Path
	}
	if active != "" {
		clean, err := cleanProjectPath(active)
		if err != nil {
			return ProjectState{}, err
		}
		active = clean
		if !slices.ContainsFunc(files, func(file ProjectFile) bool {
			return strings.EqualFold(file.Path, active)
		}) && len(files) > 0 {
			active = firstCFile(files)
		}
	}
	return ProjectState{Files: files, ActiveFile: active, CompilerArgs: normalizeCompilerArgs(state.CompilerArgs)}, nil
}

func cleanProjectPath(path string) (string, error) {
	path = strings.TrimSpace(strings.ReplaceAll(path, "\\", "/"))
	if path == "" {
		return "", errors.New("empty project path")
	}
	if filepath.IsAbs(path) || filepath.VolumeName(path) != "" || strings.HasPrefix(path, "/") {
		return "", fmt.Errorf("absolute project path %q is not allowed", path)
	}
	if path == "external" || strings.HasPrefix(path, "external/") {
		return "", fmt.Errorf("project path %q uses the reserved external namespace", path)
	}
	if strings.ContainsAny(path, `<>:"|?*`) {
		return "", fmt.Errorf("project path %q contains Windows-invalid characters", path)
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("project path %q contains an invalid segment", path)
		}
		if isReservedWindowsName(part) {
			return "", fmt.Errorf("project path %q uses reserved Windows file name %q", path, part)
		}
	}
	clean := filepath.ToSlash(filepath.Clean(path))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("project path %q escapes project root", path)
	}
	return clean, nil
}

func firstCFile(files []ProjectFile) string {
	for _, file := range files {
		if strings.EqualFold(filepath.Ext(file.Path), ".c") {
			return file.Path
		}
	}
	return files[0].Path
}

func isReservedWindowsName(pathPart string) bool {
	stem := strings.ToUpper(strings.SplitN(pathPart, ".", 2)[0])
	switch stem {
	case "CON", "PRN", "AUX", "NUL":
		return true
	default:
		return (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) &&
			len(stem) == 4 &&
			stem[3] >= '1' &&
			stem[3] <= '9'
	}
}

func isSourceLike(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".c", ".h":
		return true
	default:
		return false
	}
}

func ensurePathInside(root, target string) error {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(absRoot, absTarget)
	if err != nil {
		return err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("target %q escapes root %q", absTarget, absRoot)
	}
	joined, err := securejoin.SecureJoin(filepath.Clean(absRoot), rel)
	if err != nil {
		return err
	}
	joinedAbs, err := filepath.Abs(joined)
	if err != nil {
		return err
	}
	joinedRel, err := filepath.Rel(absRoot, joinedAbs)
	if err != nil {
		return err
	}
	if joinedRel == ".." || strings.HasPrefix(joinedRel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("target %q escapes root %q", absTarget, absRoot)
	}

	resolvedRoot, err := resolvedPathForContainment(absRoot)
	if err != nil {
		return err
	}
	resolvedTarget, err := resolvedPathForContainment(absTarget)
	if err != nil {
		return err
	}
	rel, err = filepath.Rel(resolvedRoot, resolvedTarget)
	if err != nil {
		return err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("target %q resolves outside root %q", absTarget, absRoot)
	}
	return nil
}

func resolvedPathForContainment(path string) (string, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}

	base, parts := splitAbsolutePath(absPath)
	currentLexical := base
	currentResolved := base
	for index, part := range parts {
		currentLexical = filepath.Join(currentLexical, part)
		currentResolved = filepath.Join(currentResolved, part)

		info, err := os.Lstat(currentLexical)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				resolved, err := filepath.EvalSymlinks(currentLexical)
				if err != nil {
					return "", err
				}
				currentResolved = resolved
			}
			continue
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		remaining := append([]string{currentResolved}, parts[index+1:]...)
		return filepath.Abs(filepath.Join(remaining...))
	}
	return filepath.Abs(currentResolved)
}

func splitAbsolutePath(absPath string) (string, []string) {
	volume := filepath.VolumeName(absPath)
	rest := absPath[len(volume):]
	base := volume
	if strings.HasPrefix(rest, string(filepath.Separator)) {
		base += string(filepath.Separator)
		rest = strings.TrimLeft(rest, `/\`)
	}
	if base == "" {
		base = string(filepath.Separator)
	}
	parts := strings.FieldsFunc(rest, func(r rune) bool {
		return r == '/' || r == '\\'
	})
	return base, parts
}

func defaultProjectState() ProjectState {
	return ProjectState{
		ActiveFile:   "main.c",
		CompilerArgs: defaultCompilerArgs,
		Files: []ProjectFile{
			{
				Path: "main.c",
				Content: `#include "util.h"

int main(void) {
    return add(20, 22);
}
`,
			},
			{
				Path: "util.c",
				Content: `#include "util.h"

int add(int a, int b) {
    return a + b;
}
`,
			},
			{
				Path:    "util.h",
				Content: "int add(int a, int b);\n",
			},
		},
	}
}

func cloneState(state ProjectState) ProjectState {
	files := make([]ProjectFile, len(state.Files))
	copy(files, state.Files)
	return ProjectState{Files: files, ActiveFile: state.ActiveFile, CompilerArgs: state.CompilerArgs}
}

func quoteArg(arg string) string {
	if arg == "" {
		return `""`
	}
	if !strings.ContainsAny(arg, " \t\"") {
		return arg
	}
	return `"` + strings.ReplaceAll(arg, `"`, `\"`) + `"`
}

func commandLine(args []string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = quoteArg(arg)
	}
	return strings.Join(quoted, " ")
}
