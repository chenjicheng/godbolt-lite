# Mini Godbolt Architecture

## Runtime Layout

```text
mini-godbolt.exe
include/
  vendor.h
  vendor.c
toolchain/ (optional sidecar)
  bin/clang.exe
  bin/clangd.exe
```

The executable locates `include/` from `os.Executable()`, not from the process working directory.

Browser-managed project files are stored in:

```text
~/Desktop/mini-godbolt-project
```

C17 standard-library header stubs are embedded in the executable and extracted to:

```text
%LOCALAPPDATA%\mini-godbolt\system-include\c17
```

The project compile commands include that directory with `-isystem`, so clangd can complete standard headers and understand common libc declarations.

## Backend

The Go server exposes:

- `GET /api/status`
- `GET /api/project`
- `POST /api/project/sync`
- `POST /api/source/read`
- `POST /api/compile`
- `GET /api/lsp`

`/api/compile` compiles the active `.c` file to assembly only. It does not link and does not run user code.
The UI sends a free-form clang argument string; the server still appends `-S -o -` so assembly is returned to the page.

`/api/lsp` upgrades to WebSocket and bridges browser JSON-RPC messages to clangd's stdin/stdout LSP framing.

## Frontend

The frontend is a Vite app. Its production output is written to `internal/app/static` so Go can embed it in the single executable.

## Toolchain

Development can use `clang` and `clangd` from `PATH`.

Release builds embed a slimmed `internal/app/toolchains/llvm-windows-amd64.zip`. The archive must contain:

```text
bin/clang.exe
bin/clangd.exe
lib/clang/22/
```

At runtime the archive is extracted to:

```text
%LOCALAPPDATA%\mini-godbolt\toolchains\llvm-windows-amd64
```
