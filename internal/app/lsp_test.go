package app

import (
	"bufio"
	"bytes"
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
