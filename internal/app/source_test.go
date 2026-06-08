package app

import "testing"

func TestFileURIToPathWindowsDrive(t *testing.T) {
	path, err := fileURIToPath("file:///C:/Users/test/My%20Project/main.c")
	if err != nil {
		t.Fatalf("fileURIToPath failed: %v", err)
	}
	if path == "" {
		t.Fatal("empty path")
	}
}
