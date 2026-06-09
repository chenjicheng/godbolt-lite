package app

import (
	"bytes"
	"fmt"
	"io"
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

const maxSourceReadBytes = 512 << 10

func (s *Server) handleSourceRead(w http.ResponseWriter, r *http.Request) {
	var req SourceReadRequest
	if err := decodeJSONBody(w, r, maxSourceReadBodyBytes, &req); err != nil {
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
		if err := validateReadableSourceRel(rel); err != nil {
			return SourceReadResponse{}, err
		}
		data, err := readRegularSourceFile(absPath)
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

	if rel, ok := pathRelIfInside(s.cfg.SystemIncludeDir, absPath); ok {
		if err := validateReadableSourceRel(rel); err != nil {
			return SourceReadResponse{}, err
		}
		data, err := readRegularSourceFile(absPath)
		if err != nil {
			return SourceReadResponse{}, err
		}
		return SourceReadResponse{
			URI:      uri,
			Path:     "external/system/" + filepath.ToSlash(rel),
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
	if err := ensurePathInside(absRoot, target); err != nil {
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

func validateReadableSourceRel(rel string) error {
	slashed := strings.ToLower(filepath.ToSlash(rel))
	switch slashed {
	case "project.json", "compile_commands.json", ".mini-godbolt-run":
		return fmt.Errorf("source URI points to project metadata")
	}
	if strings.HasPrefix(slashed, ".mini-godbolt-run/") {
		return fmt.Errorf("source URI points to project metadata")
	}
	if !isSourceLike(rel) {
		return fmt.Errorf("source URI has unsupported file extension")
	}
	return nil
}

func readRegularSourceFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("source URI is not a regular file")
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("source URI is not a regular file")
	}
	if info.Size() > maxSourceReadBytes {
		return nil, fmt.Errorf("source URI is %d bytes; maximum is %d", info.Size(), maxSourceReadBytes)
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSourceReadBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSourceReadBytes {
		return nil, fmt.Errorf("source URI exceeds %d bytes", maxSourceReadBytes)
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return nil, fmt.Errorf("source URI appears to be binary")
	}
	return data, nil
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
