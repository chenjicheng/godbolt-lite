package app

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"time"
)

//go:embed all:static
var staticFiles embed.FS

const (
	maxProjectSyncBodyBytes = 4 << 20
	maxCompileBodyBytes     = 1 << 20
	maxRunBodyBytes         = 64 << 10
	maxSourceReadBodyBytes  = 16 << 10
)

type Server struct {
	cfg          Config
	toolchain    Toolchain
	toolchainErr error
	project      *ProjectStore
	compiler     *Compiler
	lspSlots     chan struct{}
}

func Run(ctx context.Context, args []string) error {
	cfg, err := DefaultConfig()
	if err != nil {
		return err
	}

	flags := flag.NewFlagSet(appName, flag.ContinueOnError)
	flags.StringVar(&cfg.Addr, "addr", cfg.Addr, "HTTP listen address")
	flags.BoolFunc("no-browser", "do not open the browser automatically", func(string) error {
		cfg.OpenURL = false
		return nil
	})
	flags.StringVar(&cfg.ProjectDir, "project-dir", cfg.ProjectDir, "project workspace directory")
	flags.StringVar(&cfg.IncludeDir, "include-dir", cfg.IncludeDir, "third-party include/source directory")
	flags.StringVar(&cfg.CacheDir, "cache-dir", cfg.CacheDir, "toolchain cache directory")
	if err := flags.Parse(args); err != nil {
		return err
	}

	systemIncludeDir, err := EnsureSystemInclude(cfg.CacheDir)
	if err != nil {
		return err
	}
	cfg.SystemIncludeDir = systemIncludeDir

	srv := NewServer(cfg)
	if _, err := srv.project.Load(); err != nil {
		return err
	}

	httpServer := &http.Server{
		Handler:           srv.routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	listener, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return err
	}
	defer listener.Close()

	url := "http://" + listener.Addr().String()
	log.Printf("mini-godbolt listening on %s", url)
	log.Printf("project folder: %s", cfg.ProjectDir)
	log.Printf("third-party include folder: %s", cfg.IncludeDir)
	log.Printf("system include folder: %s", cfg.SystemIncludeDir)
	if srv.toolchainErr != nil {
		log.Printf("toolchain unavailable: %v", srv.toolchainErr)
	}

	if cfg.OpenURL {
		openBrowser(url)
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.Serve(listener)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpServer.Shutdown(shutdownCtx)
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

func NewServer(cfg Config) *Server {
	tc, err := EnsureToolchain(cfg)
	clangPath := tc.Clang
	if clangPath == "" {
		clangPath = "clang"
	}
	project := NewProjectStore(cfg.ProjectDir, cfg.IncludeDir, cfg.SystemIncludeDir, clangPath)
	return &Server{
		cfg:          cfg,
		toolchain:    tc,
		toolchainErr: err,
		project:      project,
		compiler:     NewCompiler(tc.Clang, cfg.ProjectDir, cfg.IncludeDir, cfg.SystemIncludeDir),
		lspSlots:     make(chan struct{}, 2),
	}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("GET /api/project", s.handleProjectGet)
	mux.HandleFunc("POST /api/project/sync", s.handleProjectSync)
	mux.HandleFunc("POST /api/source/read", s.handleSourceRead)
	mux.HandleFunc("POST /api/compile", s.handleCompile)
	mux.HandleFunc("POST /api/run", s.handleRun)
	mux.HandleFunc("GET /api/lsp", s.handleLSP)
	mux.Handle("/", s.staticHandler())
	return mux
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"projectDir":       s.cfg.ProjectDir,
		"includeDir":       s.cfg.IncludeDir,
		"systemIncludeDir": s.cfg.SystemIncludeDir,
		"cacheDir":         s.cfg.CacheDir,
		"toolchain":        s.toolchainStatus(),
		"ready":            s.toolchainErr == nil,
	})
}

func (s *Server) handleProjectGet(w http.ResponseWriter, r *http.Request) {
	state, err := s.project.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) handleProjectSync(w http.ResponseWriter, r *http.Request) {
	var state ProjectState
	if err := decodeJSONBody(w, r, maxProjectSyncBodyBytes, &state); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := s.project.Sync(state); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, s.project.Snapshot())
}

func (s *Server) handleCompile(w http.ResponseWriter, r *http.Request) {
	var req CompileRequest
	if err := decodeJSONBody(w, r, maxCompileBodyBytes, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := validateCompilerArgsLength(req.CompilerArgs); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if s.toolchainErr != nil {
		writeJSON(w, http.StatusOK, CompileResponse{
			OK:        false,
			ExitCode:  -1,
			RequestID: req.RequestID,
			Error:     s.toolchainErr.Error(),
		})
		return
	}

	state, err := s.project.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if req.ActiveFile == "" {
		req.ActiveFile = state.ActiveFile
	}
	if req.CompilerArgs == "" {
		req.CompilerArgs = state.CompilerArgs
	}
	writeJSON(w, http.StatusOK, s.compiler.Compile(r.Context(), req))
}

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	var req RunRequest
	if err := decodeJSONBody(w, r, maxRunBodyBytes, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := validateCompilerArgsLength(req.CompilerArgs); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if s.toolchainErr != nil {
		writeJSON(w, http.StatusOK, RunResponse{
			OK:        false,
			ExitCode:  -1,
			RequestID: req.RequestID,
			Error:     s.toolchainErr.Error(),
		})
		return
	}

	state, err := s.project.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if req.ActiveFile == "" {
		req.ActiveFile = state.ActiveFile
	}
	if req.CompilerArgs == "" {
		req.CompilerArgs = state.CompilerArgs
	}
	writeJSON(w, http.StatusOK, s.compiler.Run(r.Context(), req))
}

func (s *Server) staticHandler() http.Handler {
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fileServer.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, maxBytes int64, value any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	return json.NewDecoder(r.Body).Decode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("could not open browser: %v", err)
	}
}

func (s *Server) toolchainStatus() string {
	if s.toolchainErr != nil {
		return s.toolchainErr.Error()
	}
	lldLink := s.toolchain.LLDLink
	if lldLink == "" {
		lldLink = "not found"
	}
	return fmt.Sprintf("clang=%s clangd=%s lld-link=%s", s.toolchain.Clang, s.toolchain.Clangd, lldLink)
}
