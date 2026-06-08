param(
    [string]$Version = "22.1.7",
    [string]$Sha256 = "3b568b5be1443d1a04c63261fa3a7aed16e126a8ed2196a1032aa8ed602144bd"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$downloads = Join-Path $root "downloads"
$archiveName = "clang+llvm-$Version-x86_64-pc-windows-msvc.tar.xz"
$archive = Join-Path $downloads $archiveName
$url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-$Version/clang%2Bllvm-$Version-x86_64-pc-windows-msvc.tar.xz"
$extractDir = Join-Path $downloads "llvm-extract-$Version"
$fullDir = Join-Path $extractDir "clang+llvm-$Version-x86_64-pc-windows-msvc"
$toolchainDir = Join-Path $root "dist\toolchain"
$zipPath = Join-Path $root "internal\app\toolchains\llvm-windows-amd64.zip"
$maxToolchainZipEntries = 20000
$maxToolchainZipUncompressedBytes = 700MB

function Normalize-ArchiveEntryName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )
    return $Name.Replace("\", "/").TrimStart([char[]]@("/"))
}

function Assert-ArchiveEntryNameSafe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $normalized = Normalize-ArchiveEntryName $Name
    if (
        [string]::IsNullOrWhiteSpace($normalized) -or
        $normalized.StartsWith("../") -or
        $normalized.Contains("/../") -or
        $normalized -match '^[A-Za-z]:' -or
        $normalized.StartsWith("/")
    ) {
        throw "Archive contains unsafe entry path '$Name'."
    }
}

function Assert-TarArchiveSafe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArchivePath
    )

    $entries = tar -tf $ArchivePath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not list tar archive entries."
    }
    foreach ($entry in $entries) {
        Assert-ArchiveEntryNameSafe $entry
    }

    $verboseEntries = tar -tvf $ArchivePath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect tar archive entry types."
    }
    foreach ($line in $verboseEntries) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        $type = $line[0]
        if ($type -in @("l", "h", "c", "b", "p")) {
            throw "Archive contains unsupported non-regular entry: $line"
        }
    }
}

function New-ToolchainZip {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDir,
        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $DestinationPath) {
        Remove-Item -LiteralPath $DestinationPath -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DestinationPath) | Out-Null

    $sourceRoot = (Resolve-Path $SourceDir).Path.TrimEnd([char[]]@("\", "/"))
    $zip = [System.IO.Compression.ZipFile]::Open($DestinationPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File |
            Sort-Object @{ Expression = { $_.FullName.Substring($sourceRoot.Length).TrimStart([char[]]@("\", "/")).Replace("\", "/") } }
        foreach ($file in $files) {
            $entryName = $file.FullName.Substring($sourceRoot.Length).TrimStart([char[]]@("\", "/")).Replace("\", "/")
            Assert-ArchiveEntryNameSafe $entryName
            $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::FromUnixTimeSeconds(0)
            $src = [System.IO.File]::OpenRead($file.FullName)
            $dst = $entry.Open()
            try {
                $src.CopyTo($dst)
            } finally {
                $dst.Dispose()
                $src.Dispose()
            }
        }
    } finally {
        $zip.Dispose()
    }
}

function Assert-ToolchainZipShape {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ZipPath
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $ZipPath).Path)
    try {
        if ($zip.Entries.Count -gt $maxToolchainZipEntries) {
            throw "Toolchain zip has $($zip.Entries.Count) entries; maximum is $maxToolchainZipEntries."
        }
        $uncompressedBytes = 0L
        $entryNames = @()
        foreach ($entry in $zip.Entries) {
            $name = Normalize-ArchiveEntryName $entry.FullName
            Assert-ArchiveEntryNameSafe $name
            $uncompressedBytes += $entry.Length
            if ($uncompressedBytes -gt $maxToolchainZipUncompressedBytes) {
                throw "Toolchain zip expands beyond $maxToolchainZipUncompressedBytes bytes."
            }
            $entryNames += $name
        }
        foreach ($required in @("bin/clang.exe", "bin/clangd.exe", "bin/lld-link.exe")) {
            if ($entryNames -notcontains $required) {
                throw "Toolchain zip is missing $required."
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
            throw "Toolchain zip is missing lib/clang/<version>/include/stddef.h."
        }
    } finally {
        $zip.Dispose()
    }
}

New-Item -ItemType Directory -Force -Path $downloads | Out-Null

if (-not (Test-Path $archive)) {
    curl.exe -L --fail --progress-bar -o $archive $url
}

$actualHash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $Sha256.ToLowerInvariant()) {
    throw "SHA256 mismatch for $archiveName. Got $actualHash, expected $Sha256."
}

if (Test-Path $extractDir) {
    Remove-Item -LiteralPath $extractDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
Assert-TarArchiveSafe $archive
tar -xf $archive -C $extractDir
$clangResourceRoot = Join-Path $fullDir "lib\clang"
$clangResourceDir = Get-ChildItem -LiteralPath $clangResourceRoot -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
if (-not $clangResourceDir) {
    throw "No clang resource directory found under $clangResourceRoot."
}

if (Test-Path $toolchainDir) {
    Remove-Item -LiteralPath $toolchainDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $toolchainDir "bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $toolchainDir "lib\clang") | Out-Null

Copy-Item (Join-Path $fullDir "bin\clang.exe") (Join-Path $toolchainDir "bin\clang.exe") -Force
Copy-Item (Join-Path $fullDir "bin\clangd.exe") (Join-Path $toolchainDir "bin\clangd.exe") -Force
Copy-Item (Join-Path $fullDir "bin\lld-link.exe") (Join-Path $toolchainDir "bin\lld-link.exe") -Force
Copy-Item $clangResourceDir.FullName (Join-Path $toolchainDir "lib\clang\$($clangResourceDir.Name)") -Recurse -Force

New-ToolchainZip -SourceDir $toolchainDir -DestinationPath $zipPath
Assert-ToolchainZipShape -ZipPath $zipPath

Write-Host "Prepared slim LLVM toolchain at dist\toolchain"
Write-Host "Prepared embedded toolchain zip at internal\app\toolchains\llvm-windows-amd64.zip"
