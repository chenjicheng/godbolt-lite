package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const maxWebSocketPayloadBytes = 8 << 20
const maxLSPMessageBytes = 8 << 20
const maxLSPHeaderLineBytes = 4096
const lspInitialMessageTimeout = 15 * time.Second

func (s *Server) handleLSP(w http.ResponseWriter, r *http.Request) {
	if s.toolchainErr != nil {
		writeError(w, http.StatusServiceUnavailable, s.toolchainErr)
		return
	}
	if _, err := s.project.Load(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	select {
	case s.lspSlots <- struct{}{}:
		defer func() { <-s.lspSlots }()
	default:
		writeError(w, http.StatusTooManyRequests, errors.New("too many LSP sessions"))
		return
	}

	acceptOptions, err := lspAcceptOptions(r)
	if err != nil {
		writeError(w, http.StatusForbidden, err)
		return
	}

	conn, err := websocket.Accept(w, r, acceptOptions)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.SetReadLimit(maxWebSocketPayloadBytes)

	firstCtx, firstCancel := context.WithTimeout(r.Context(), lspInitialMessageTimeout)
	firstType, firstMessage, err := conn.Read(firstCtx)
	firstCancel()
	if err != nil {
		log.Printf("websocket closed before LSP initialize: %v", err)
		conn.Close(websocket.StatusPolicyViolation, "LSP initialize message required")
		return
	}
	if firstType != websocket.MessageText && firstType != websocket.MessageBinary {
		conn.Close(websocket.StatusUnsupportedData, "LSP messages must be text or binary")
		return
	}
	if !isLSPInitializeMessage(firstMessage) {
		conn.Close(websocket.StatusPolicyViolation, "first LSP message must be initialize")
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	cmd := exec.CommandContext(ctx, s.toolchain.Clangd,
		"--compile-commands-dir="+s.cfg.ProjectDir,
		"--background-index",
		"--log=error",
	)
	cmd.Dir = s.cfg.ProjectDir

	stdin, err := cmd.StdinPipe()
	if err != nil {
		conn.Close(websocket.StatusInternalError, "clangd stdin failed")
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		conn.Close(websocket.StatusInternalError, "clangd stdout failed")
		return
	}
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		_ = conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"jsonrpc":"2.0","method":"window/showMessage","params":{"type":1,"message":%q}}`, err.Error())))
		conn.Close(websocket.StatusInternalError, "clangd start failed")
		return
	}
	defer func() {
		cancel()
		_ = stdin.Close()
		_ = cmd.Wait()
	}()

	if stderr != nil {
		go func() {
			_, _ = io.Copy(logWriter{"clangd"}, stderr)
		}()
	}

	errCh := make(chan error, 2)
	go func() {
		errCh <- pumpLSPToWebSocket(ctx, stdout, conn)
	}()
	go func() {
		if err := writeLSPMessage(stdin, firstMessage); err != nil {
			errCh <- err
			return
		}
		errCh <- pumpWebSocketToLSP(ctx, conn, stdin)
	}()

	if err := <-errCh; err != nil && !isExpectedLSPBridgeError(err) {
		log.Printf("lsp bridge closed: %v", err)
	}
}

func pumpLSPToWebSocket(ctx context.Context, stdout io.Reader, conn *websocket.Conn) error {
	reader := bufio.NewReader(stdout)
	for {
		msg, err := readLSPMessage(reader)
		if err != nil {
			return err
		}
		if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
			return err
		}
	}
}

func pumpWebSocketToLSP(ctx context.Context, conn *websocket.Conn, stdin io.Writer) error {
	for {
		messageType, msg, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if messageType != websocket.MessageText && messageType != websocket.MessageBinary {
			continue
		}
		if err := writeLSPMessage(stdin, msg); err != nil {
			return err
		}
	}
}

func writeLSPMessage(w io.Writer, msg []byte) error {
	if len(msg) > maxLSPMessageBytes {
		return fmt.Errorf("LSP message too large: %d bytes", len(msg))
	}
	if _, err := fmt.Fprintf(w, "Content-Length: %d\r\n\r\n", len(msg)); err != nil {
		return err
	}
	_, err := w.Write(msg)
	return err
}

func readLSPMessage(r *bufio.Reader) ([]byte, error) {
	contentLength := -1
	for {
		line, err := readLSPHeaderLine(r)
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return nil, err
			}
			contentLength = n
		}
	}
	if contentLength < 0 {
		return nil, errors.New("missing Content-Length from clangd")
	}
	if contentLength > maxLSPMessageBytes {
		return nil, fmt.Errorf("LSP message too large: %d bytes", contentLength)
	}
	msg := make([]byte, contentLength)
	_, err := io.ReadFull(r, msg)
	return msg, err
}

func readLSPHeaderLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || len(line) > maxLSPHeaderLineBytes {
		return "", errors.New("LSP header line too large")
	}
	if err != nil {
		return "", err
	}
	return string(line), nil
}

func isExpectedLSPBridgeError(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return true
	}
	status := websocket.CloseStatus(err)
	return status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway
}

type logWriter struct {
	name string
}

func (w logWriter) Write(p []byte) (int, error) {
	text := strings.TrimSpace(string(p))
	if text != "" {
		log.Printf("%s: %s", w.name, text)
	}
	return len(p), nil
}

type lspWireMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
}

func isLSPInitializeMessage(msg []byte) bool {
	var wire lspWireMessage
	if err := json.Unmarshal(msg, &wire); err != nil {
		return false
	}
	return wire.JSONRPC == "2.0" && wire.Method == "initialize" && len(wire.ID) > 0 && string(wire.ID) != "null"
}

func lspAcceptOptions(r *http.Request) (*websocket.AcceptOptions, error) {
	if !isLoopbackHost(r.Host) {
		return nil, fmt.Errorf("LSP WebSocket host %q is not loopback", r.Host)
	}
	return &websocket.AcceptOptions{
		OriginPatterns: []string{"http://" + r.Host, "https://" + r.Host},
	}, nil
}

func isLoopbackHost(value string) bool {
	host, _, err := net.SplitHostPort(value)
	if err != nil {
		host = value
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
