package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type SourceReadRequest struct {
	URI string `json:"uri"`
}

type SourceReadResponse struct {
	URI      string `json:"uri"`
	Path     string `json:"path"`
	Content  string `json:"content"`
	ReadOnly bool   `json:"readOnly"`
}

func (s *Server) handleSourceRead(w http.ResponseWriter, r *http.Request) {
	var req SourceReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	path, err := fileURIToPath(req.URI)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	resp, err := s.readAllowedSource(req.URI, path)
	if err != nil {
		writeError(w, http.StatusForbidden, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) readAllowedSource(uri, path string) (SourceReadResponse, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return SourceReadResponse{}, err
	}

	if rel, ok := pathRelIfInside(s.cfg.ProjectDir, absPath); ok {
		data, err := os.ReadFile(absPath)
		if err != nil {
			return SourceReadResponse{}, err
		}
		return SourceReadResponse{
			URI:      uri,
			Path:     filepath.ToSlash(rel),
			Content:  string(data),
			ReadOnly: false,
		}, nil
	}

	if rel, ok := pathRelIfInside(s.cfg.IncludeDir, absPath); ok {
		data, err := os.ReadFile(absPath)
		if err != nil {
			return SourceReadResponse{}, err
		}
		return SourceReadResponse{
			URI:      uri,
			Path:     "external/include/" + filepath.ToSlash(rel),
			Content:  string(data),
			ReadOnly: true,
		}, nil
	}

	return SourceReadResponse{}, fmt.Errorf("source URI is outside allowed roots")
}

func pathRelIfInside(root, target string) (string, bool) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(absRoot, target)
	if err != nil {
		return "", false
	}
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}

func fileURIToPath(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "file" {
		return "", fmt.Errorf("only file:// URIs are supported")
	}

	path, err := url.PathUnescape(parsed.Path)
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" && len(path) >= 3 && path[0] == '/' && path[2] == ':' {
		path = path[1:]
	}
	if parsed.Host != "" && parsed.Host != "localhost" {
		if runtime.GOOS == "windows" {
			path = `\\` + parsed.Host + filepath.FromSlash(path)
		} else {
			return "", fmt.Errorf("file URI host %q is not supported", parsed.Host)
		}
	}
	return filepath.FromSlash(path), nil
}
