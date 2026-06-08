package app

import (
	"strings"

	"github.com/google/shlex"
)

const windowsDefaultCompilerArgs = "-Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig"
const linuxDefaultCompilerArgs = "-target x86_64-pc-linux-gnu -Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig"
const malformedLinuxDefaultCompilerArgs = "-target -Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig"
const defaultCompilerArgs = windowsDefaultCompilerArgs
const legacyDefaultCompilerArgs = "-Og -masm=intel -fno-asynchronous-unwind-tables"

func defaultIfEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func normalizeCompilerArgs(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == legacyDefaultCompilerArgs || value == linuxDefaultCompilerArgs || value == malformedLinuxDefaultCompilerArgs || value == windowsDefaultCompilerArgs {
		return defaultCompilerArgs
	}
	return value
}

func splitCompilerArgs(input string) ([]string, error) {
	return shlex.Split(preserveBackslashesForShlex(input))
}

func preserveBackslashesForShlex(input string) string {
	return strings.ReplaceAll(input, `\`, `\\`)
}
