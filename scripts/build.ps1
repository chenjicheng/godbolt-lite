param(
    [switch]$SkipFrontend,
    [switch]$Release
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. (Join-Path $PSScriptRoot "path-guards.ps1")
$embeddedToolchainZip = ".\internal\app\toolchains\llvm-windows-amd64.zip"
$maxToolchainZipEntries = 20000
$maxToolchainZipUncompressedBytes = 700MB

if ($Release -and $SkipFrontend) {
    throw "Release build cannot use -SkipFrontend; the embedded UI must be rebuilt for release."
}

function Invoke-CheckedTool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    $output = & $FilePath @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE. $output"
    }
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
            $name = ConvertTo-SafeArchiveEntryName $entry.FullName
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
    Remove-DirectoryInsideRoot -BaseDir $root -Path $smokeRoot
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
            $status = $null
            try {
                $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" -TimeoutSec 2
            } catch {
                Start-Sleep -Milliseconds 300
                continue
            }
            if ($status.ready -eq $true) {
                $expectedRoot = Join-Path $cacheDir "toolchains\llvm-windows-amd64"
                if (-not ([string]$status.toolchain).Contains($expectedRoot)) {
                    throw "Release smoke did not use the embedded toolchain cache. Status toolchain: $($status.toolchain)"
                }
                Invoke-CheckedTool (Join-Path $expectedRoot "bin\clang.exe") @("--version")
                Invoke-CheckedTool (Join-Path $expectedRoot "bin\clangd.exe") @("--version")
                Invoke-CheckedTool (Join-Path $expectedRoot "bin\lld-link.exe") @("--version")

                $probeDir = Join-Path $smokeRoot "probe"
                New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
                $probeSource = Join-Path $probeDir "probe.c"
                Set-Content -LiteralPath $probeSource -Encoding ASCII -Value "#include <stddef.h>`nint probe(void) { return sizeof(size_t) > 0; }"
                Invoke-CheckedTool (Join-Path $expectedRoot "bin\clang.exe") @("-fsyntax-only", $probeSource)

                $index = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 2 -UseBasicParsing
                if ($index.StatusCode -ne 200 -or -not ([string]$index.Content).Contains('id="app"')) {
                    throw "Release smoke did not serve the rebuilt web UI."
                }
                $compileBody = @{
                    activeFile = "main.c"
                    compilerArgs = "-Og -g0"
                    requestId = "release-smoke"
                } | ConvertTo-Json
                $compileResult = Invoke-RestMethod `
                    -Uri "http://127.0.0.1:$port/api/compile" `
                    -Method Post `
                    -ContentType "application/json" `
                    -Body $compileBody `
                    -TimeoutSec 10
                if ($compileResult.ok -ne $true) {
                    throw "Release smoke compile failed: $($compileResult.error) $($compileResult.stderr)"
                }
                return
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
        if ($Release) {
            throw "Release build requires web\package.json so the embedded UI can be rebuilt."
        }
        Write-Warning "web/package.json not found; building with fallback embedded UI."
    }
}

$env:GOCACHE = Join-Path $root ".gocache"
$env:GOTMPDIR = Join-Path $root ".gotmp"
$env:TEMP = Join-Path $root ".tmp"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:GOCACHE, $env:GOTMPDIR, $env:TEMP | Out-Null
go test ./...
if (-not (Test-Path ".\internal\app\static\index.html")) {
    throw "internal\app\static\index.html is missing. Build the frontend first; -SkipFrontend is development-only."
}
New-Item -ItemType Directory -Force -Path ".\dist" | Out-Null
go build -trimpath -ldflags="-s -w" -o ".\dist\mini-godbolt.exe" .\cmd\mini-godbolt
Remove-DirectoryInsideRoot -BaseDir $root -Path ".\dist\include"
New-Item -ItemType Directory -Force -Path ".\dist\include" | Out-Null

if (Test-Path ".\include") {
    Copy-DirectoryContentsInsideRoot -BaseDir $root -SourceDir ".\include" -DestinationDir ".\dist\include"
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
