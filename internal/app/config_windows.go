//go:build windows

package app

import (
	"path/filepath"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

type knownFolderID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var folderIDDesktop = knownFolderID{
	Data1: 0xB4BFCC3A,
	Data2: 0xDB2C,
	Data3: 0x424C,
	Data4: [8]byte{0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41},
}

func desktopDir(home string) string {
	shell32 := syscall.NewLazyDLL("shell32.dll")
	ole32 := syscall.NewLazyDLL("ole32.dll")
	shGetKnownFolderPath := shell32.NewProc("SHGetKnownFolderPath")
	coTaskMemFree := ole32.NewProc("CoTaskMemFree")

	var pathPtr *uint16
	ret, _, _ := shGetKnownFolderPath.Call(
		uintptr(unsafe.Pointer(&folderIDDesktop)),
		0,
		0,
		uintptr(unsafe.Pointer(&pathPtr)),
	)
	if ret == 0 && pathPtr != nil {
		path := utf16PtrToString(pathPtr)
		coTaskMemFree.Call(uintptr(unsafe.Pointer(pathPtr)))
		if path != "" {
			return path
		}
	}
	return filepath.Join(home, "Desktop")
}

func utf16PtrToString(ptr *uint16) string {
	if ptr == nil {
		return ""
	}
	n := 0
	for p := ptr; *p != 0; n++ {
		p = (*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(ptr)) + uintptr(n+1)*unsafe.Sizeof(*ptr)))
	}
	if n == 0 {
		return ""
	}
	buf := unsafe.Slice(ptr, n)
	return string(utf16.Decode(buf))
}
