param(
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipFrontend) {
    if (Test-Path ".\web\package.json") {
        Push-Location ".\web"
        if (-not (Test-Path ".\node_modules")) {
            npm.cmd install
        }
        npm.cmd run build
        Pop-Location
    } else {
        Write-Warning "web/package.json not found; building with fallback embedded UI."
    }
}

$env:GOCACHE = Join-Path $root ".gocache"
go test ./...
New-Item -ItemType Directory -Force -Path ".\dist" | Out-Null
go build -trimpath -ldflags="-s -w" -o ".\dist\mini-godbolt.exe" .\cmd\mini-godbolt
New-Item -ItemType Directory -Force -Path ".\dist\include" | Out-Null

if (Test-Path ".\include") {
    Copy-Item -Path ".\include\*" -Destination ".\dist\include" -Recurse -Force
}

if (-not (Test-Path ".\internal\app\toolchains\llvm-windows-amd64.zip") -and -not (Test-Path ".\dist\toolchain\bin\clang.exe")) {
    Write-Warning "No bundled or sidecar LLVM toolchain found. The exe will start, but compile/LSP need llvm-windows-amd64.zip embedded or dist\toolchain\bin\clang.exe and clangd.exe."
}

Write-Host "Built dist\mini-godbolt.exe"
