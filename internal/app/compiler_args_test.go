package app

import (
	"reflect"
	"testing"
)

func TestSplitCompilerArgs(t *testing.T) {
	args, err := splitCompilerArgs(`-Og -DNAME="mini godbolt" -I "C:\SDK Path\include"`)
	if err != nil {
		t.Fatalf("splitCompilerArgs failed: %v", err)
	}
	want := []string{"-Og", "-DNAME=mini godbolt", "-I", `C:\SDK Path\include`}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestSplitCompilerArgsRejectsUnterminatedQuote(t *testing.T) {
	if _, err := splitCompilerArgs(`-I "C:\SDK Path\include`); err == nil {
		t.Fatal("expected unterminated quote error")
	}
}
