# Mini Godbolt

Windows single-exe mini Godbolt for C.

## Runtime behavior

- The app starts a local HTTP server on `127.0.0.1` and opens the browser.
- Browser-managed project files are stored in `~/Desktop/mini-godbolt-project`.
- Third-party headers and visible source files are read from an `include/` folder next to `mini-godbolt.exe`.
- Built-in C17 header stubs are extracted to the app cache and passed to clang/clangd with `-isystem` for standard-header completion and semantic analysis.
- Clang generates assembly. clangd powers completion, diagnostics, hover, semantic highlighting, and Ctrl+click navigation.
- Run links the active `.c` file plus reachable sibling implementations discovered from local headers. For example, `#include "util.h"` adds `util.c` when it exists next to that header; unrelated temporary `.c` files are not linked. The same rule applies to third-party headers under `include/`. Run executes the resulting native Windows program and shows stdout/stderr/exit code in the Console panel.
- Compiler arguments are project-level and fully editable in the UI. The default is `-Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig`, which builds runnable native Windows programs. The `CSAPP` preset switches to `-target x86_64-pc-linux-gnu -Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig` for Linux x86-64/System V assembly.

Linux ABI output cannot execute directly on Windows. When Run sees a Linux `-target`, it omits that target for the runnable native build and reports that note in Console; the assembly view still uses the exact editable compiler arguments. ABI-sensitive code can therefore differ between the assembly view and Run output.

The built-in standard headers are declarations for editing and compile-to-assembly workflows. The bundled slim LLVM toolchain includes `lld-link.exe`, but it does not bundle a full C runtime or Windows SDK.

## Development

```powershell
$env:GOCACHE = Join-Path (Get-Location) '.gocache'
go test ./...
go run ./cmd/mini-godbolt -no-browser
```

LLVM 22.1.7 can be fetched from the official LLVM GitHub release and slimmed with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-llvm.ps1
```

This creates both `dist/toolchain` for sidecar testing and `internal/app/toolchains/llvm-windows-amd64.zip` for single-exe embedding. The embedded zip must contain `bin/clang.exe`, `bin/clangd.exe`, `bin/lld-link.exe`, and the clang resource headers.

For a release build:

```powershell
if (Test-Path .\dist\toolchain) { Move-Item .\dist\toolchain .\.tmp\release-toolchain-backup }
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1 -Release
if (Test-Path .\.tmp\release-toolchain-backup) { Move-Item .\.tmp\release-toolchain-backup .\dist\toolchain }
```

Release mode rebuilds the web UI, validates the embedded LLVM zip, rejects a masking `dist/toolchain` sidecar, starts the generated exe, confirms it uses the embedded cache toolchain rather than `PATH`, starts `clang.exe`, `clangd.exe`, and `lld-link.exe`, verifies clang resource headers with `<stddef.h>`, serves the rebuilt UI, and compiles the default project once.
