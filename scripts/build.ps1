param(
    [switch]$SkipFrontend,
    [switch]$Release
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$embeddedToolchainZip = ".\internal\app\toolchains\llvm-windows-amd64.zip"
$maxToolchainZipEntries = 20000
$maxToolchainZipUncompressedBytes = 700MB

if ($Release -and $SkipFrontend) {
    throw "Release build cannot use -SkipFrontend; the embedded UI must be rebuilt for release."
}

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
        if ($zip.Entries.Count -gt $maxToolchainZipEntries) {
            throw "Embedded LLVM zip has $($zip.Entries.Count) entries; maximum is $maxToolchainZipEntries."
        }
        $uncompressedBytes = 0L
        $entryNames = @()
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace("\", "/").TrimStart([char[]]@("/"))
            if (
                [string]::IsNullOrWhiteSpace($name) -or
                $name.StartsWith("../") -or
                $name.Contains("/../") -or
                $name -match '^[A-Za-z]:' -or
                $name.StartsWith("/")
            ) {
                throw "Embedded LLVM zip contains unsafe entry path '$($entry.FullName)'."
            }
            $uncompressedBytes += $entry.Length
            if ($uncompressedBytes -gt $maxToolchainZipUncompressedBytes) {
                throw "Embedded LLVM zip expands beyond $maxToolchainZipUncompressedBytes bytes."
            }
            $entryNames += $name
        }
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

function Get-FreeLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
    $listener.Start()
    try {
        return $listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

function Assert-ReleaseSmoke {
    $port = Get-FreeLoopbackPort
    $smokeRoot = Join-Path $root ".tmp\release-smoke"
    $projectDir = Join-Path $smokeRoot "project"
    $cacheDir = Join-Path $smokeRoot "cache"
    $stdoutPath = Join-Path $smokeRoot "stdout.log"
    $stderrPath = Join-Path $smokeRoot "stderr.log"
    if (Test-Path $smokeRoot) {
        Remove-Item -LiteralPath $smokeRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null

    $proc = Start-Process `
        -FilePath ".\dist\mini-godbolt.exe" `
        -ArgumentList @("-addr", "127.0.0.1:$port", "-no-browser", "-project-dir", $projectDir, "-cache-dir", $cacheDir) `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -PassThru
    try {
        $deadline = (Get-Date).AddSeconds(25)
        do {
            if ($proc.HasExited) {
                $stderr = if (Test-Path $stderrPath) { Get-Content -Raw $stderrPath } else { "" }
                throw "Release smoke process exited early with code $($proc.ExitCode). $stderr"
            }
            try {
                $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" -TimeoutSec 2
                if ($status.ready -eq $true) {
                    return
                }
            } catch {
                Start-Sleep -Milliseconds 300
            }
        } while ((Get-Date) -lt $deadline)
        throw "Release smoke did not report ready=true before timeout."
    } finally {
        if (-not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force
            $proc.WaitForExit()
        }
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
            npm.cmd ci --ignore-scripts
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
if (Test-Path ".\dist\include") {
    Remove-Item -LiteralPath ".\dist\include" -Recurse -Force
}
New-Item -ItemType Directory -Force -Path ".\dist\include" | Out-Null

if (Test-Path ".\include") {
    Copy-Item -Path ".\include\*" -Destination ".\dist\include" -Recurse -Force
}

if ($Release) {
    Assert-ReleaseSmoke
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
