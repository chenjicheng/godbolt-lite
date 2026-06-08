package app

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

func (s *Server) handleLSP(w http.ResponseWriter, r *http.Request) {
	if s.toolchainErr != nil {
		writeError(w, http.StatusServiceUnavailable, s.toolchainErr)
		return
	}
	if _, err := s.project.Load(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	ws, err := upgradeWebSocket(w, r)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}
	defer ws.Close()

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
		_ = ws.WriteClose()
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = ws.WriteClose()
		return
	}
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		_ = ws.WriteText([]byte(fmt.Sprintf(`{"jsonrpc":"2.0","method":"window/showMessage","params":{"type":1,"message":%q}}`, err.Error())))
		_ = ws.WriteClose()
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
		errCh <- pumpLSPToWebSocket(stdout, ws)
	}()
	go func() {
		errCh <- pumpWebSocketToLSP(ws, stdin)
	}()

	if err := <-errCh; err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		log.Printf("lsp bridge closed: %v", err)
	}
}

func pumpLSPToWebSocket(stdout io.Reader, ws *webSocketConn) error {
	reader := bufio.NewReader(stdout)
	for {
		msg, err := readLSPMessage(reader)
		if err != nil {
			return err
		}
		if err := ws.WriteText(msg); err != nil {
			return err
		}
	}
}

func pumpWebSocketToLSP(ws *webSocketConn, stdin io.Writer) error {
	for {
		opcode, msg, err := ws.ReadMessage()
		if err != nil {
			return err
		}
		switch opcode {
		case wsText, wsBinary:
			if err := writeLSPMessage(stdin, msg); err != nil {
				return err
			}
		case wsClose:
			return io.EOF
		}
	}
}

func writeLSPMessage(w io.Writer, msg []byte) error {
	if _, err := fmt.Fprintf(w, "Content-Length: %d\r\n\r\n", len(msg)); err != nil {
		return err
	}
	_, err := w.Write(msg)
	return err
}

func readLSPMessage(r *bufio.Reader) ([]byte, error) {
	contentLength := -1
	for {
		line, err := r.ReadString('\n')
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
	msg := make([]byte, contentLength)
	_, err := io.ReadFull(r, msg)
	return msg, err
}

type webSocketConn struct {
	conn net.Conn
	r    *bufio.Reader
	w    *bufio.Writer
	mu   sync.Mutex
}

const (
	wsText   byte = 0x1
	wsBinary byte = 0x2
	wsClose  byte = 0x8
	wsPing   byte = 0x9
	wsPong   byte = 0xA
)

func upgradeWebSocket(w http.ResponseWriter, r *http.Request) (*webSocketConn, error) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return nil, errors.New("websocket requires GET")
	}
	if !headerContains(r.Header, "Connection", "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "upgrade required", http.StatusUpgradeRequired)
		return nil, errors.New("missing websocket upgrade headers")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing websocket key", http.StatusBadRequest)
		return nil, errors.New("missing Sec-WebSocket-Key")
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket unsupported", http.StatusInternalServerError)
		return nil, errors.New("response writer does not support hijacking")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}

	accept := websocketAccept(key)
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\n")
	fmt.Fprintf(rw, "Upgrade: websocket\r\n")
	fmt.Fprintf(rw, "Connection: Upgrade\r\n")
	fmt.Fprintf(rw, "Sec-WebSocket-Accept: %s\r\n\r\n", accept)
	if err := rw.Flush(); err != nil {
		conn.Close()
		return nil, err
	}
	return &webSocketConn{conn: conn, r: rw.Reader, w: rw.Writer}, nil
}

func websocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func headerContains(header http.Header, name, value string) bool {
	for _, item := range header.Values(name) {
		for _, part := range strings.Split(item, ",") {
			if strings.EqualFold(strings.TrimSpace(part), value) {
				return true
			}
		}
	}
	return false
}

func (ws *webSocketConn) ReadMessage() (byte, []byte, error) {
	for {
		opcode, payload, err := ws.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch opcode {
		case wsPing:
			if err := ws.writeFrame(wsPong, payload); err != nil {
				return 0, nil, err
			}
			continue
		case wsPong:
			continue
		default:
			return opcode, payload, nil
		}
	}
}

func (ws *webSocketConn) readFrame() (byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(ws.r, header); err != nil {
		return 0, nil, err
	}
	fin := header[0]&0x80 != 0
	opcode := header[0] & 0x0f
	if !fin {
		return 0, nil, errors.New("fragmented websocket messages are not supported")
	}

	masked := header[1]&0x80 != 0
	length := uint64(header[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(ws.r, ext[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(ws.r, ext[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > 8<<20 {
		return 0, nil, errors.New("websocket message too large")
	}

	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(ws.r, mask[:]); err != nil {
			return 0, nil, err
		}
	}

	payload := make([]byte, int(length))
	if _, err := io.ReadFull(ws.r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return opcode, payload, nil
}

func (ws *webSocketConn) WriteText(payload []byte) error {
	return ws.writeFrame(wsText, payload)
}

func (ws *webSocketConn) WriteClose() error {
	return ws.writeFrame(wsClose, nil)
}

func (ws *webSocketConn) writeFrame(opcode byte, payload []byte) error {
	ws.mu.Lock()
	defer ws.mu.Unlock()

	if err := ws.w.WriteByte(0x80 | opcode); err != nil {
		return err
	}
	length := len(payload)
	switch {
	case length < 126:
		if err := ws.w.WriteByte(byte(length)); err != nil {
			return err
		}
	case length <= 0xffff:
		if err := ws.w.WriteByte(126); err != nil {
			return err
		}
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(length))
		if _, err := ws.w.Write(ext[:]); err != nil {
			return err
		}
	default:
		if err := ws.w.WriteByte(127); err != nil {
			return err
		}
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		if _, err := ws.w.Write(ext[:]); err != nil {
			return err
		}
	}
	if _, err := ws.w.Write(payload); err != nil {
		return err
	}
	return ws.w.Flush()
}

func (ws *webSocketConn) Close() error {
	return ws.conn.Close()
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

var _ = os.ErrClosed
