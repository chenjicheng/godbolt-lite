param(
    [switch]$SkipFrontend,
    [switch]$Release
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$embeddedToolchainZip = ".\internal\app\toolchains\llvm-windows-amd64.zip"

function Assert-EmbeddedToolchainZip {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ZipPath
    )

    if (-not (Test-Path $ZipPath)) {
        throw "Release build requires $ZipPath. Run scripts\fetch-llvm.ps1 first."
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $resolvedZip = (Resolve-Path $ZipPath).Path
    $zip = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip)
    try {
        $entryNames = @(
            $zip.Entries |
                ForEach-Object { $_.FullName.Replace("\", "/").TrimStart([char[]]@("/")) }
        )
        foreach ($required in @("bin/clang.exe", "bin/clangd.exe", "bin/lld-link.exe")) {
            if ($entryNames -notcontains $required) {
                throw "Embedded LLVM zip is missing $required."
            }
        }
        $hasClangResourceHeader = $false
        foreach ($entry in $entryNames) {
            if ($entry -match '^lib/clang/[^/]+/include/stddef\.h$') {
                $hasClangResourceHeader = $true
                break
            }
        }
        if (-not $hasClangResourceHeader) {
            throw "Embedded LLVM zip is missing lib/clang/<version>/include/stddef.h."
        }
    } finally {
        $zip.Dispose()
    }
}

if ($Release) {
    Assert-EmbeddedToolchainZip $embeddedToolchainZip
    if (Test-Path ".\dist\toolchain") {
        throw "Release validation must not be masked by dist\toolchain. Move or remove that sidecar toolchain before running scripts\build.ps1 -Release."
    }
}

if (-not $SkipFrontend) {
    if (Test-Path ".\web\package.json") {
        Push-Location ".\web"
        try {
            npm.cmd ci
            npm.cmd run build
        } finally {
            Pop-Location
        }
    } else {
        Write-Warning "web/package.json not found; building with fallback embedded UI."
    }
}

$env:GOCACHE = Join-Path $root ".gocache"
$env:GOTMPDIR = Join-Path $root ".gotmp"
$env:TEMP = Join-Path $root ".tmp"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:GOCACHE, $env:GOTMPDIR, $env:TEMP | Out-Null
go test ./...
New-Item -ItemType Directory -Force -Path ".\dist" | Out-Null
go build -trimpath -ldflags="-s -w" -o ".\dist\mini-godbolt.exe" .\cmd\mini-godbolt
New-Item -ItemType Directory -Force -Path ".\dist\include" | Out-Null

if (Test-Path ".\include") {
    Copy-Item -Path ".\include\*" -Destination ".\dist\include" -Recurse -Force
}

if (
    -not (Test-Path $embeddedToolchainZip) -and
    -not (
        (Test-Path ".\dist\toolchain\bin\clang.exe") -and
        (Test-Path ".\dist\toolchain\bin\clangd.exe") -and
        (Test-Path ".\dist\toolchain\bin\lld-link.exe")
    )
) {
    Write-Warning "No bundled or complete sidecar LLVM toolchain found. The exe will start, but compile/LSP/run need llvm-windows-amd64.zip embedded or dist\toolchain\bin\clang.exe, clangd.exe, and lld-link.exe."
}

Write-Host "Built dist\mini-godbolt.exe"
