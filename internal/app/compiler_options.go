package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	safeCompilerValueRE = regexp.MustCompile(`^[A-Za-z0-9_+.,:=/@-]+$`)
	safeMacroNameRE     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(=.*)?$`)
)

func (c *Compiler) validateCompilerArgs(args []string) error {
	_, err := c.sanitizeCompilerArgs(args)
	return err
}

func (c *Compiler) compilerArgsFromString(value string) ([]string, error) {
	args, err := splitCompilerArgs(defaultIfEmpty(value, defaultCompilerArgs))
	if err != nil {
		return nil, err
	}
	return c.sanitizeCompilerArgs(args)
}

func (c *Compiler) sanitizeCompilerArgs(args []string) ([]string, error) {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "" {
			continue
		}
		if strings.HasPrefix(arg, "@") {
			return nil, fmt.Errorf("response files are not allowed in compiler arguments: %s", arg)
		}
		if arg == "--" {
			return nil, errors.New("positional compiler inputs are not allowed")
		}

		if flag, value, consumed, ok := compilerPathFlagValue(args, i); ok {
			normalized, err := c.normalizeCompilerArgPath(flag, value)
			if err != nil {
				return nil, err
			}
			out = append(out, flag, normalized)
			if consumed {
				i++
			}
			continue
		}

		if flag, value, consumed, ok := compilerValueFlag(args, i); ok {
			if err := validateCompilerFlagValue(flag, value); err != nil {
				return nil, err
			}
			out = append(out, arg)
			if consumed {
				out = append(out, value)
			}
			if consumed {
				i++
			}
			continue
		}

		if isAllowedCompilerSwitch(arg) {
			out = append(out, arg)
			continue
		}

		if !strings.HasPrefix(arg, "-") {
			return nil, fmt.Errorf("positional compiler input %q is not allowed; add project files through the file list", arg)
		}
		return nil, fmt.Errorf("compiler argument %s is not allowed here", arg)
	}
	return out, nil
}

func compilerPathFlagValue(args []string, index int) (flag, value string, consumed bool, ok bool) {
	arg := args[index]
	switch arg {
	case "-I", "-isystem", "-iquote", "-idirafter", "-include", "-imacros":
		if index+1 >= len(args) {
			return arg, "", false, true
		}
		return arg, args[index+1], true, true
	}
	if strings.HasPrefix(arg, "-I") && len(arg) > len("-I") {
		return "-I", strings.TrimPrefix(arg, "-I"), false, true
	}
	if strings.HasPrefix(arg, "-isystem") && len(arg) > len("-isystem") {
		return "-isystem", strings.TrimSpace(strings.TrimPrefix(arg, "-isystem")), false, true
	}
	return "", "", false, false
}

func compilerValueFlag(args []string, index int) (flag, value string, consumed bool, ok bool) {
	arg := args[index]
	switch arg {
	case "-x", "-std", "-target", "--target", "-arch", "-march", "-mcpu", "-mtune", "-mfpmath", "-masm", "-D", "-U", "-fuse-ld":
		if index+1 >= len(args) {
			return arg, "", false, true
		}
		return arg, args[index+1], true, true
	}
	for _, prefix := range []string{"-std=", "-target=", "--target=", "-arch=", "-march=", "-mcpu=", "-mtune=", "-mfpmath=", "-masm=", "-D", "-U", "-fuse-ld="} {
		if strings.HasPrefix(arg, prefix) && len(arg) > len(prefix) {
			flag := strings.TrimSuffix(prefix, "=")
			return flag, strings.TrimPrefix(arg, prefix), false, true
		}
	}
	return "", "", false, false
}

func validateCompilerFlagValue(flag, value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("%s requires a value", flag)
	}
	if strings.HasPrefix(value, "@") {
		return fmt.Errorf("response-file value %q is not allowed", value)
	}
	switch flag {
	case "-D":
		if !safeMacroNameRE.MatchString(value) {
			return fmt.Errorf("-D value %q is not a supported macro definition", value)
		}
	case "-U":
		if !safeMacroNameRE.MatchString(value) || strings.Contains(value, "=") {
			return fmt.Errorf("-U value %q is not a supported macro name", value)
		}
	case "-x":
		switch value {
		case "c", "c-header", "cpp-output":
			return nil
		default:
			return fmt.Errorf("-x value %q is not supported", value)
		}
	case "-fuse-ld":
		switch value {
		case "lld", "lld-link":
			return nil
		default:
			return fmt.Errorf("-fuse-ld value %q is not supported; use lld", value)
		}
	case "-masm":
		switch value {
		case "intel", "att":
			return nil
		default:
			return fmt.Errorf("-masm value %q is not supported", value)
		}
	default:
		if !safeCompilerValueRE.MatchString(value) || looksLikePath(value) {
			return fmt.Errorf("%s value %q is not supported", flag, value)
		}
	}
	return nil
}

func isAllowedCompilerSwitch(arg string) bool {
	switch arg {
	case "-O0", "-O1", "-O2", "-O3", "-Og", "-Os", "-Oz", "-Ofast",
		"-g", "-g0", "-g1", "-g2", "-g3", "-ggdb", "-gline-tables-only",
		"-S", "-c", "-E",
		"-Wall", "-Wextra", "-Wpedantic", "-Werror", "-Wno-error", "-pedantic", "-pedantic-errors", "-w",
		"-fno-asynchronous-unwind-tables", "-fasynchronous-unwind-tables",
		"-fno-stack-protector", "-fstack-protector", "-fstack-protector-strong",
		"-fno-ident", "-fident", "-fno-addrsig", "-faddrsig",
		"-fverbose-asm", "-fno-verbose-asm",
		"-fomit-frame-pointer", "-fno-omit-frame-pointer",
		"-ffreestanding", "-fno-builtin", "-fwrapv", "-fno-strict-aliasing", "-fstrict-aliasing",
		"-nostdinc", "-pthread",
		"-m32", "-m64", "-mred-zone", "-mno-red-zone":
		return true
	}
	if strings.HasPrefix(arg, "-W") {
		if strings.HasPrefix(arg, "-Wl,") || strings.HasPrefix(arg, "-Wa,") || strings.HasPrefix(arg, "-Wp,") || strings.Contains(arg, "@") {
			return false
		}
		return safeCompilerValueRE.MatchString(arg)
	}
	if strings.HasPrefix(arg, "-mllvm") {
		return false
	}
	if strings.HasPrefix(arg, "-m") {
		return safeCompilerValueRE.MatchString(arg)
	}
	return false
}

func (c *Compiler) normalizeCompilerArgPath(flag, value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s requires a path", flag)
	}
	if strings.HasPrefix(value, "@") {
		return "", fmt.Errorf("response-file path %q is not allowed", value)
	}

	var candidates []compilerArgPathCandidate
	if filepath.IsAbs(value) || filepath.VolumeName(value) != "" {
		candidates = []compilerArgPathCandidate{{path: value}}
	} else {
		rel := filepath.FromSlash(strings.ReplaceAll(value, "\\", "/"))
		for _, root := range c.allowedCompilerArgRoots() {
			if root != "" {
				candidates = append(candidates, compilerArgPathCandidate{path: filepath.Join(root, rel)})
			}
		}
	}

	var fallback string
	for _, candidate := range candidates {
		for _, root := range c.allowedCompilerArgRoots() {
			if root == "" {
				continue
			}
			if err := ensurePathInside(root, candidate.path); err == nil {
				abs := absPath(candidate.path)
				if fallback == "" {
					fallback = abs
				}
				if fileExists(candidate.path) || directoryExists(candidate.path) {
					return abs, nil
				}
			}
		}
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", fmt.Errorf("%s path %q must stay inside the project or system include folders", flag, value)
}

type compilerArgPathCandidate struct {
	path string
}

func (c *Compiler) allowedCompilerArgRoots() []string {
	return []string{c.projectDir, c.systemIncludeDir}
}

func looksLikePath(value string) bool {
	return filepath.IsAbs(value) || filepath.VolumeName(value) != "" || strings.HasPrefix(value, ".") || strings.ContainsAny(value, `/\`)
}

func directoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func dependencyCompilerArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "-fuse-ld" {
			i++
			continue
		}
		if strings.HasPrefix(arg, "-fuse-ld=") {
			continue
		}
		out = append(out, arg)
	}
	return out
}
