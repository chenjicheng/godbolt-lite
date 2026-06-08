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

if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $toolchainDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "Prepared slim LLVM toolchain at dist\toolchain"
Write-Host "Prepared embedded toolchain zip at internal\app\toolchains\llvm-windows-amd64.zip"
