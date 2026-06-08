package app

import (
	"fmt"
	"strings"
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
	var args []string
	var current strings.Builder
	var quote rune

	for _, r := range input {
		if quote != 0 {
			if r == quote {
				quote = 0
			} else {
				current.WriteRune(r)
			}
			continue
		}

		switch r {
		case '\'', '"':
			quote = r
		case ' ', '\t', '\r', '\n':
			if current.Len() > 0 {
				args = append(args, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}

	if quote != 0 {
		return nil, fmt.Errorf("unterminated quote in compiler arguments")
	}
	if current.Len() > 0 {
		args = append(args, current.String())
	}
	return args, nil
}
