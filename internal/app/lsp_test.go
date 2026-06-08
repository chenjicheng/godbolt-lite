package app

import (
	"bufio"
	"bytes"
	"net/http"
	"strings"
	"testing"
)

func TestReadLSPMessage(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader("Content-Length: 2\r\n\r\n{}"))
	msg, err := readLSPMessage(reader)
	if err != nil {
		t.Fatalf("readLSPMessage failed: %v", err)
	}
	if string(msg) != "{}" {
		t.Fatalf("message = %q, want {}", string(msg))
	}
}

func TestReadLSPMessageRejectsOversizedContentLength(t *testing.T) {
	input := "Content-Length: " + stringForInt(maxLSPMessageBytes+1) + "\r\n\r\n"
	if _, err := readLSPMessage(bufio.NewReader(strings.NewReader(input))); err == nil {
		t.Fatal("readLSPMessage accepted oversized message")
	}
}

func TestReadLSPMessageRejectsOversizedHeaderLine(t *testing.T) {
	input := strings.Repeat("A", maxLSPHeaderLineBytes+1) + "\n"
	if _, err := readLSPMessage(bufio.NewReader(strings.NewReader(input))); err == nil {
		t.Fatal("readLSPMessage accepted oversized header")
	}
}

func TestWriteLSPMessageRejectsOversizedMessage(t *testing.T) {
	msg := bytes.Repeat([]byte("x"), maxLSPMessageBytes+1)
	if err := writeLSPMessage(bytes.NewBuffer(nil), msg); err == nil {
		t.Fatal("writeLSPMessage accepted oversized message")
	}
}

func TestIsLSPInitializeMessage(t *testing.T) {
	if !isLSPInitializeMessage([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)) {
		t.Fatal("initialize request was rejected")
	}
	for _, msg := range [][]byte{
		[]byte(`{"jsonrpc":"2.0","method":"initialized","params":{}}`),
		[]byte(`{"jsonrpc":"2.0","id":null,"method":"initialize","params":{}}`),
		[]byte(`not json`),
	} {
		if isLSPInitializeMessage(msg) {
			t.Fatalf("invalid initial message accepted: %s", string(msg))
		}
	}
}

func TestLSPAcceptOptionsRequiresLoopbackHost(t *testing.T) {
	if _, err := lspAcceptOptions(&http.Request{Host: "127.0.0.1:57070", RemoteAddr: "127.0.0.1:50000"}); err != nil {
		t.Fatalf("loopback host rejected: %v", err)
	}
	if _, err := lspAcceptOptions(&http.Request{Host: "example.com:57070", RemoteAddr: "127.0.0.1:50000"}); err == nil {
		t.Fatal("non-loopback host accepted")
	}
	if _, err := lspAcceptOptions(&http.Request{Host: "127.0.0.1:57070", RemoteAddr: "192.0.2.4:50000"}); err == nil {
		t.Fatal("non-loopback peer accepted")
	}
}

func stringForInt(value int) string {
	var out [20]byte
	i := len(out)
	for {
		i--
		out[i] = byte('0' + value%10)
		value /= 10
		if value == 0 {
			return string(out[i:])
		}
	}
}
