# Mini Godbolt

Windows single-exe mini Godbolt for C.

## Runtime behavior

- The app starts a local HTTP server on `127.0.0.1` and opens the browser.
- Browser-managed project files are stored in `~/Desktop/mini-godbolt-project`.
- Third-party headers and source files are project files. Add vendor folders directly in the Explorer; the app no longer reads a separate `include/` folder next to the exe.
- Built-in C17 header stubs are extracted to the app cache and passed to clang/clangd with `-isystem` for standard-header completion and semantic analysis.
- Clang generates assembly. clangd powers completion, diagnostics, hover, semantic highlighting, and Ctrl+click navigation.
- Run links the active `.c` file plus reachable sibling implementations discovered from project-local headers. For example, `#include "util.h"` adds `util.c` when it exists next to that header; unrelated temporary `.c` files are not linked. Vendor headers follow the same rule when they live inside the project tree. Run executes the resulting native Windows program and shows stdout/stderr/exit code in the Console panel.
- Compiler arguments are project-level and fully editable in the UI. The default is `-Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig`, which builds runnable native Windows programs. The `CSAPP` preset switches to `-target x86_64-pc-linux-gnu -Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig` for Linux x86-64/System V assembly.

Linux ABI output cannot execute directly on Windows. When Run sees a Linux `-target`, it omits that target for the runnable native build and reports that note in Console; the assembly view still uses the exact editable compiler arguments. ABI-sensitive code can therefore differ between the assembly view and Run output.

The built-in standard headers are declarations for editing and compile-to-assembly workflows. The bundled slim LLVM toolchain includes `lld-link.exe`, but it does not bundle a full C runtime or Windows SDK.

## Development

Prerequisites:

- Go 1.26.
- Node.js `^20.19.0 || >=22.12.0` for the Vite web UI.

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
New-Item -ItemType Directory -Force -Path .\.tmp | Out-Null
if (Test-Path .\dist\toolchain) { Move-Item .\dist\toolchain .\.tmp\release-toolchain-backup }
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1 -Release
if (Test-Path .\.tmp\release-toolchain-backup) { Move-Item .\.tmp\release-toolchain-backup .\dist\toolchain }
```

Release mode rebuilds the web UI, validates the embedded LLVM zip, rejects a masking `dist/toolchain` sidecar, starts the generated exe, confirms it uses the embedded cache toolchain rather than `PATH`, starts `clang.exe`, `clangd.exe`, and `lld-link.exe`, verifies clang resource headers with `<stddef.h>`, serves the rebuilt UI, and compiles the default project once.

## GitHub tag releases

Pushing a tag whose name starts with `v` triggers `.github/workflows/release.yml`.
The workflow runs on `windows-latest`, downloads and verifies the configured official LLVM archive, prepares the embedded toolchain zip, runs `scripts/build.ps1 -Release`, and publishes these release assets:

- `godbolt-lite-<tag>-windows-amd64.exe`
- `godbolt-lite-<tag>-windows-amd64.exe.sha256`

```powershell
git tag v0.1.0
git push origin v0.1.0
```
