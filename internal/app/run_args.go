package app

import (
	"fmt"
	"strings"
	"time"
)

func prepareRunCompilerArgs(args []string) ([]string, string, error) {
	out := make([]string, 0, len(args))
	note := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-target" || arg == "--target":
			if i+1 >= len(args) {
				return nil, "", fmt.Errorf("%s requires a target triple", arg)
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
