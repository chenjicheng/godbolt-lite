package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandlersRejectOversizedRequestBodies(t *testing.T) {
	server := testServerForHandlers(t)
	cases := []struct {
		name    string
		limit   int
		handler func(http.ResponseWriter, *http.Request)
		body    string
	}{
		{
			name:    "project sync",
			limit:   maxProjectSyncBodyBytes,
			handler: server.handleProjectSync,
			body:    strings.Repeat(" ", maxProjectSyncBodyBytes+1),
		},
		{
			name:    "compile",
			limit:   maxCompileBodyBytes,
			handler: server.handleCompile,
			body:    `{"activeFile":"main.c","compilerArgs":"` + strings.Repeat("x", maxCompileBodyBytes) + `"}`,
		},
		{
			name:    "run",
			limit:   maxRunBodyBytes,
			handler: server.handleRun,
			body:    `{"activeFile":"main.c","compilerArgs":"` + strings.Repeat("x", maxRunBodyBytes) + `"}`,
		},
		{
			name:    "source read",
			limit:   maxSourceReadBodyBytes,
			handler: server.handleSourceRead,
			body:    `{"uri":"file:///` + strings.Repeat("x", maxSourceReadBodyBytes) + `"}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if len(tc.body) <= tc.limit {
				t.Fatalf("test body length %d did not exceed limit %d", len(tc.body), tc.limit)
			}
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			tc.handler(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
		})
	}
}

func TestCompileAndRunRejectOversizedCompilerArgs(t *testing.T) {
	server := testServerForHandlers(t)
	body := `{"activeFile":"main.c","compilerArgs":"` + strings.Repeat("x", maxCompilerArgsBytes+1) + `"}`
	for name, handler := range map[string]func(http.ResponseWriter, *http.Request){
		"compile": server.handleCompile,
		"run":     server.handleRun,
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
			rec := httptest.NewRecorder()
			handler(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
		})
	}
}

func testServerForHandlers(t *testing.T) *Server {
	t.Helper()
	projectDir := t.TempDir()
	includeDir := t.TempDir()
	systemIncludeDir := t.TempDir()
	store := NewProjectStore(projectDir, includeDir, systemIncludeDir, "clang")
	return &Server{
		cfg: Config{
			ProjectDir:       projectDir,
			IncludeDir:       includeDir,
			SystemIncludeDir: systemIncludeDir,
		},
		project:      store,
		compiler:     NewCompiler("", projectDir, includeDir, systemIncludeDir),
		toolchainErr: errors.New("toolchain unavailable"),
	}
}

func TestHandleSourceReadRejectsOversizedSourceFiles(t *testing.T) {
	server := testServerForHandlers(t)
	writeTestFile(t, server.cfg.ProjectDir, "huge.c", strings.Repeat("x", maxSourceReadBytes+1))
	path := filepath.Join(server.cfg.ProjectDir, "huge.c")
	body := `{"uri":"` + pathToTestFileURI(path) + `"}`

	req := httptest.NewRequest(http.MethodPost, "/api/source/read", strings.NewReader(body))
	rec := httptest.NewRecorder()
	server.handleSourceRead(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusForbidden, rec.Body.String())
	}
}
